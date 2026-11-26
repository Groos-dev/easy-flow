import { message, messageDetail } from '../src/shared/i18n.ts'
import { SessionState } from '../src/shared/domain.ts'
/**
 * Antigravity（Agent Manager）的落盘读取与工具名归一。
 *
 * 每条对话一个目录：`<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`。
 * Agent Manager 的 app_data_dir 是 `~/.gemini/antigravity`，IDE 与 CLI 各用 `antigravity-ide` /
 * `antigravity-cli`，三处都找。transcript 是滚动窗口，checkpoint 时整份重写（会变短），所以按 mtime
 * 重读尾部，不按追加增量读。
 *
 * 只读、不写回；读不到就不返回，调用方退回 unknown，交给 hook 推送与活跃超时兜底。
 * Step fields and the conversation_summaries SQLite table were verified against
 * the installed Antigravity App 2.34.0. Native event times, not checkpoint mtimes,
 * determine whether a pull observation may replace a hook event.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { actionOf, type SessionAction } from './action.ts'
import { unknownStatus, type SessionObservation } from './session-state.ts'
import { str } from './util.ts'

// Agent Manager 在前：同一个 id 只会落在其中一处
const APP_DIRS = ['antigravity', 'antigravity-ide', 'antigravity-cli'] as const

const TAIL_BYTES = 256 * 1024
const TITLE_MAX = 80

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value.trim().replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : 0
}

function summaryDb(home: string, app: string): DatabaseSync | null {
  const path = join(home, app, 'conversation_summaries.db')
  if (!existsSync(path)) return null
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 25')
    return db
  } catch {
    return null
  }
}

interface SummaryRow {
  conversation_id?: unknown
  status?: unknown
  last_modified_time?: unknown
  last_user_input_time?: unknown
  last_user_input_step_index?: unknown
  not_fully_idle?: unknown
  killed?: unknown
  step_count?: unknown
}

function summaries(home: string, sessions: readonly string[]): Map<string, SummaryRow> {
  const result = new Map<string, SummaryRow>()
  if (!sessions.length) return result
  for (const app of APP_DIRS) {
    const db = summaryDb(home, app)
    if (!db) continue
    try {
      for (let start = 0; start < sessions.length; start += 500) {
        const ids = sessions.slice(start, start + 500)
        const rows = db.prepare(`SELECT conversation_id, status, last_modified_time,
          last_user_input_time, last_user_input_step_index, not_fully_idle, killed, step_count
          FROM conversation_summaries WHERE conversation_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as SummaryRow[]
        for (const row of rows) {
          const id = str(row.conversation_id)
          if (id && !result.has(id)) result.set(id, row)
        }
      }
    } catch {
      // Missing/changed tables or a locked database do not prevent transcript fallback.
    } finally {
      db.close()
    }
  }
  return result
}

// ------------------------------------------------------------------ 工具名

interface ToolRule {
  // action.ts 认得的工具名
  tool: string
  // 归一后的参数字段
  field: string
  // Antigravity 参数里依次找哪些字段（新旧工具名的参数名不一样）
  from: readonly string[]
}

/**
 * Antigravity 的工具 → action.ts 已有的动作。新名（read_file / write_file / edit_file）与
 * 旧别名（view_file / write_to_file / replace_file_content …）都认。
 */
const TOOL_RULES: Record<string, ToolRule> = {
  run_command: { tool: 'Bash', field: 'command', from: ['CommandLine', 'command'] },
  view_file: { tool: 'Read', field: 'file_path', from: ['AbsolutePath', 'Path'] },
  read_file: { tool: 'Read', field: 'file_path', from: ['Path', 'AbsolutePath'] },
  view_file_outline: { tool: 'Read', field: 'file_path', from: ['AbsolutePath', 'Path'] },
  view_code_item: { tool: 'Read', field: 'file_path', from: ['File', 'AbsolutePath', 'Path'] },
  list_dir: { tool: 'Read', field: 'file_path', from: ['DirectoryPath'] },
  write_file: { tool: 'Write', field: 'file_path', from: ['Path', 'TargetFile'] },
  write_to_file: { tool: 'Write', field: 'file_path', from: ['TargetFile', 'Path'] },
  edit_file: { tool: 'Edit', field: 'file_path', from: ['Path', 'TargetFile'] },
  replace_file_content: { tool: 'Edit', field: 'file_path', from: ['TargetFile', 'Path'] },
  multi_replace_file_content: { tool: 'Edit', field: 'file_path', from: ['TargetFile', 'Path'] },
  grep_search: { tool: 'Grep', field: 'pattern', from: ['Query', 'query'] },
  find_by_name: { tool: 'Glob', field: 'pattern', from: ['Pattern', 'pattern'] },
  search_web: { tool: 'WebSearch', field: 'query', from: ['query', 'Query'] },
  read_url_content: { tool: 'WebFetch', field: 'url', from: ['Url', 'url'] },
  call_mcp_tool: { tool: 'CallMcpTool', field: 'toolName', from: ['ToolName', 'toolName'] },
}

function parseArgs(args: unknown): Record<string, unknown> | null {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : null
}

// 子 agent 的说明：取第一个子 agent 的角色 / 类型，没有再退到提示词
function subagentDescription(args: Record<string, unknown>): string {
  const list = args.Subagents
  const first = Array.isArray(list) && list[0] && typeof list[0] === 'object' ? (list[0] as Record<string, unknown>) : null
  if (!first) return ''
  return str(first.Role) || str(first.TypeName) || str(first.Prompt)
}

/**
 * 一次 Antigravity 工具调用 → hook / action.ts 用的 { 工具名, 参数 }。
 * 认不出的工具原样返回名字、参数为空，action.ts 会把它当认不出。
 */
export function antigravityToolCall(name: string, args: unknown): { tool: string; input: Record<string, unknown> } {
  const parsed = parseArgs(args) ?? {}
  if (name === 'invoke_subagent') return { tool: 'Task', input: { description: subagentDescription(parsed) } }
  if (name.startsWith('mcp_')) return { tool: 'CallMcpTool', input: { toolName: name } }
  const rule = Object.hasOwn(TOOL_RULES, name) ? TOOL_RULES[name] : undefined
  if (!rule) return { tool: name, input: {} }
  const value = rule.from.map((key) => parsed[key]).find((v) => typeof v === 'string' && v.trim())
  return { tool: rule.tool, input: typeof value === 'string' ? { [rule.field]: value } : {} }
}

// Native interactive tools wait for a person, rather than doing background work.
// Implicit App-policy approval waits have no dedicated observer hook. Do not
// infer them from BypassSandbox: a proposed request is not an approval decision.
export function antigravityNeedsInput(name: string, args: unknown): string | null {
  if (name !== 'ask_question' && name !== 'ask_permission') return null
  const parsed = parseArgs(args) ?? {}
  if (name === 'ask_permission') return str(parsed.Reason) || [str(parsed.Action), str(parsed.Target)].filter(Boolean).join(': ')
  const questions = parsed.questions
  return Array.isArray(questions)
    ? questions.map(item => item && typeof item === 'object' ? str((item as Record<string, unknown>).question) : '').filter(Boolean).join('\n')
    : ''
}

function antigravityAction(name: string, args: unknown, at: number): SessionAction | null {
  const { tool, input } = antigravityToolCall(name, args)
  return actionOf(tool, input, at)
}

// ------------------------------------------------------------------ transcript

function transcriptPaths(home: string, session: string): string[] {
  // 会话 id 进路径之前先挡住目录穿越
  if (!session || session.includes('/') || session.includes('\\') || session.includes('..')) return []
  const paths: string[] = []
  for (const app of APP_DIRS) {
    for (const name of ['transcript.jsonl', 'transcript_full.jsonl']) {
      const path = join(home, app, 'brain', session, '.system_generated', 'logs', name)
      if (existsSync(path)) paths.push(path)
    }
  }
  return paths
}

function tailText(path: string, size: number): string | null {
  const start = Math.max(0, size - TAIL_BYTES)
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(size - start)
    const count = readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8', 0, count)
    if (start === 0) return text
    const firstBreak = text.indexOf('\n')
    return firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

interface Step {
  type?: unknown
  status?: unknown
  created_at?: unknown
  step_index?: unknown
  tool_calls?: unknown
  toolCalls?: unknown
}

interface ParsedTail {
  steps: Step[]
  // 最后一行还没写完：这一轮的结论还不能下
  incomplete: boolean
  lastLine: string
}

function parseTail(path: string, size: number): ParsedTail {
  const text = tailText(path, size)
  if (!text) return { steps: [], incomplete: false, lastLine: '' }
  const lines = text.split('\n').filter((line) => line.trim())
  const steps: Step[] = []
  let incomplete = false
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as Step
      if (parsed && typeof parsed === 'object') steps.push(parsed)
    } catch {
      if (i === lines.length - 1) incomplete = true
    }
  }
  return { steps, incomplete, lastLine: steps.length ? lines[lines.length - 1] : '' }
}

function stepType(step: Step): string {
  return str(step.type).toUpperCase()
}

function toolCallsOf(step: Step): Array<{ name: string; args: unknown }> {
  const raw = Array.isArray(step.tool_calls) ? step.tool_calls : Array.isArray(step.toolCalls) ? step.toolCalls : []
  const calls: Array<{ name: string; args: unknown }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const call = item as Record<string, unknown>
    const name = str(call.name) || str(call.tool_name) || str(call.toolName)
    if (name) calls.push({ name, args: call.args ?? call.arguments ?? call.input })
  }
  return calls
}

/**
 * 尾部最后一步 → 观察。
 *   USER_INPUT                     模型还没回：思考
 *   PLANNER_RESPONSE 带工具调用    在干活（气泡里放最后一个工具）
 *   PLANNER_RESPONSE 不带工具调用  这一轮答完了：跑完待看
 *   其他步骤（工具结果、系统消息）  最近一次回复要了工具就还在干活，否则说不出结论
 */
export function observationOfSteps(steps: readonly Step[], observedAt: number): SessionObservation | null {
  if (!steps.length) return null
  const last = steps[steps.length - 1]
  const type = stepType(last)
  const state = str(last.status).toUpperCase()
  const createdAt = timestamp(last.created_at)
  if (createdAt) observedAt = createdAt
  if (state === 'ERROR' || type === 'ERROR_MESSAGE') {
    return { status: { state: SessionState.Failed, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: this turn failed") }, action: null }
  }
  if (state && !['DONE', 'RUNNING', 'PENDING'].includes(state)) return null
  if (type === 'USER_INPUT') {
    return { status: { state: SessionState.Thinking, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: waiting for a model response") }, action: null }
  }
  if (type === 'PLANNER_RESPONSE') {
    if (state === 'RUNNING' || state === 'PENDING') {
      return { status: { state: SessionState.Thinking, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: waiting for a model response") }, action: null }
    }
    const calls = toolCallsOf(last)
    if (!calls.length) {
      return { status: { state: SessionState.Done, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: this turn finished") }, action: null }
    }
    const call = calls[calls.length - 1]
    const question = antigravityNeedsInput(call.name, call.args)
    if (question !== null) {
      return { status: { state: SessionState.Blocked, needsAction: question, observedAt, ...messageDetail("Antigravity transcript: calling {0}", [call.name]) }, action: null }
    }
    return {
      status: { state: SessionState.Working, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: calling {0}", [call.name]) },
      action: antigravityAction(call.name, call.args, observedAt),
    }
  }
  for (let i = steps.length - 2; i >= 0; i--) {
    const kind = stepType(steps[i])
    if (kind === 'USER_INPUT') return null
    if (kind === 'PLANNER_RESPONSE') {
      if (!toolCallsOf(steps[i]).length) return null
      if (type === 'GENERIC' && state === 'DONE') {
        return { status: { state: SessionState.Thinking, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: waiting for a model response") }, action: null }
      }
      const call = toolCallsOf(steps[i]).at(-1)
      const question = call ? antigravityNeedsInput(call.name, call.args) : null
      if (question !== null) {
        return { status: { state: SessionState.Blocked, needsAction: question, observedAt, ...messageDetail("Antigravity transcript: running a tool") }, action: null }
      }
      return { status: { state: SessionState.Working, needsAction: '', observedAt, ...messageDetail("Antigravity transcript: running a tool") }, action: null }
    }
  }
  return null
}

interface TranscriptRead {
  mtimeMs: number
  size: number
  lastLine: string
  index: number
  createdAt: number
  incomplete: boolean
  observation: SessionObservation | null
}
const reads = new Map<string, TranscriptRead>()

function readTranscript(path: string): TranscriptRead | null {
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  const cached = reads.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached
  const parsed = parseTail(path, size)
  const last = parsed.steps.at(-1)
  const observation = parsed.incomplete ? null : observationOfSteps(parsed.steps, 0)
  const read: TranscriptRead = {
    mtimeMs, size, lastLine: parsed.lastLine,
    index: typeof last?.step_index === 'number' ? last.step_index : -1,
    createdAt: timestamp(last?.created_at), incomplete: parsed.incomplete,
    observation: cached?.lastLine === parsed.lastLine ? cached.observation : observation,
  }
  // Never cache a partial write as a completed turn.
  if (!parsed.incomplete) reads.set(path, read)
  return read
}

function latestTranscript(home: string, session: string): TranscriptRead | null {
  const candidates = transcriptPaths(home, session).map(readTranscript).filter((read): read is TranscriptRead => !!read)
  candidates.sort((a, b) => b.index - a.index || b.createdAt - a.createdAt || b.mtimeMs - a.mtimeMs || b.size - a.size)
  const latest = candidates[0]
  if (!latest || candidates.some(read => read.incomplete && read.mtimeMs >= latest.mtimeMs)) return null
  return latest
}

function summaryObservation(row: SummaryRow, read: TranscriptRead | null): SessionObservation | null {
  let transcript = read?.observation ?? null
  const lastInputIndex = row.last_user_input_step_index
  const lastInputAt = timestamp(row.last_user_input_time)
  const currentTurn = typeof lastInputIndex === 'number' && lastInputIndex >= 0 && read && read.index >= 0
    ? read.index >= lastInputIndex : !lastInputAt || !!transcript && transcript.status.observedAt >= lastInputAt
  if (!currentTurn) transcript = null
  const nativeState = str(row.status)
  const observedAt = timestamp(row.last_modified_time)
  if (transcript && observedAt && transcript.status.observedAt > observedAt) return transcript
  let state: SessionState
  if (row.killed === 1 || row.killed === true || nativeState === 'CASCADE_RUN_STATUS_CANCELING') state = SessionState.Blocked
  else if (nativeState === 'CASCADE_RUN_STATUS_RUNNING' || nativeState === 'CASCADE_RUN_STATUS_BUSY') {
    state = transcript?.status.state === SessionState.Blocked ? SessionState.Blocked
      : transcript?.status.state === SessionState.Working ? SessionState.Working : SessionState.Thinking
  } else if (nativeState === 'CASCADE_RUN_STATUS_IDLE') {
    const recentFailure = transcript?.status.state === SessionState.Failed && transcript.status.observedAt >= timestamp(row.last_user_input_time)
    state = row.not_fully_idle === 1 || row.not_fully_idle === true ? SessionState.Working
      : recentFailure ? SessionState.Failed : row.step_count === 0 ? SessionState.Idle : SessionState.Done
  } else return transcript
  return {
    status: { state, needsAction: state === SessionState.Blocked ? transcript?.status.needsAction ?? '' : '', observedAt, ...messageDetail("Antigravity database: {0}", [nativeState]) },
    action: transcript?.action ?? null,
  }
}

/**
 * 按登记 id 读最新观察；读不到的不返回。
 * 内容没变只是 mtime 变了，沿用旧观察的时刻——别让一次重写盖掉更新的 hook 事件。
 */
export function antigravityObservations(home: string, sessions: readonly string[]): Map<string, SessionObservation> {
  const out = new Map<string, SessionObservation>()
  const rows = summaries(home, sessions)
  for (const session of sessions) {
    const read = latestTranscript(home, session)
    const row = rows.get(session)
    const observation = row ? summaryObservation(row, read) : read?.observation
    if (observation) out.set(session, observation)
  }
  return out
}

// 读不到这条会话时的说法，threads.ts 用
export function antigravityMissing(): SessionObservation {
  return { status: unknownStatus(message("No Antigravity transcript for this session")), action: null }
}

// ------------------------------------------------------------------ 标题

// 提示可能多行：标题只取第一行，太长截断
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX).trimEnd()}…` : line
}

/**
 * Native sidebar titles come from the read-only conversation_summaries database.
 * A legacy history.jsonl is used only as a fallback when that app has no title.
 */
export function antigravityTitles(home: string, sessions: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!sessions.length) return out
  const want = new Set(sessions)
  for (const app of APP_DIRS) {
    const db = summaryDb(home, app)
    if (db) {
      try {
        for (let start = 0; start < sessions.length; start += 500) {
          const ids = sessions.slice(start, start + 500)
          const rows = db.prepare(`SELECT conversation_id, title, preview FROM conversation_summaries
            WHERE conversation_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
          for (const row of rows) {
            const id = str(row.conversation_id)
            // The installed App uses preview as the sidebar title until a
            // dedicated title is assigned. Verified against its native UI.
            const title = str(row.title).trim() || firstLine(str(row.preview))
            if (id && title && !out.has(id)) out.set(id, title)
          }
        }
      } catch {
        // Keep registered titles when the native database cannot be read.
      } finally {
        db.close()
      }
    }
    const path = join(home, app, 'history.jsonl')
    if (!existsSync(path)) continue
    let text: string
    try {
      const { size } = statSync(path)
      text = tailText(path, size) ?? ''
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as { conversationId?: unknown; display?: unknown }
        const id = str(row.conversationId)
        if (!want.has(id) || out.has(id)) continue
        const title = firstLine(str(row.display))
        if (title) out.set(id, title)
      } catch {
        /* 半行或坏行：跳过 */
      }
    }
  }
  return out
}
