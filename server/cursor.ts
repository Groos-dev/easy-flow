// Cursor 的落盘读取：transcript 补状态，composerHeaders / chat 库读标题。
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { actionOf, type SessionAction } from './action.ts'
import { readdirOrEmpty } from './fsutil.ts'
import { unknownStatus, type SessionObservation } from './session-state.ts'
import { str } from './util.ts'

const TAIL_BYTES = 256 * 1024
const MISS_RETRY_MS = 30_000

const PLACEHOLDER_TITLES = new Set(['new agent', 'new chat', 'untitled', '新会话'])

interface CachedPath {
  path: string | null
  checkedAt: number
}

const transcriptPaths = new Map<string, CachedPath>()
const chatPaths = new Map<string, CachedPath & { mtimeMs: number; title: string }>()
const transcriptReads = new Map<
  string,
  { mtimeMs: number; lastLine: string; observation: SessionObservation | null }
>()

function cacheKey(home: string, session: string): string {
  return `${home}\0${session}`
}

// 按会话 id 找 transcript；未命中 30 秒后再试。
function transcriptPath(cursorHome: string, session: string): string | null {
  const key = cacheKey(cursorHome, session)
  const cached = transcriptPaths.get(key)
  if (cached && (cached.path || Date.now() - cached.checkedAt < MISS_RETRY_MS)) {
    if (!cached.path || existsSync(cached.path)) return cached.path
    transcriptPaths.delete(key)
  }

  const projects = join(cursorHome, 'projects')
  for (const project of readdirOrEmpty(projects)) {
    const path = join(projects, project, 'agent-transcripts', session, `${session}.jsonl`)
    if (existsSync(path)) {
      transcriptPaths.set(key, { path, checkedAt: Date.now() })
      return path
    }
  }
  transcriptPaths.set(key, { path: null, checkedAt: Date.now() })
  return null
}

function tailText(path: string): string | null {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  const start = Math.max(0, size - TAIL_BYTES)
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    if (start === 0) return text
    const firstBreak = text.indexOf('\n')
    return firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
  } catch {
    return null
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

interface TranscriptEntry {
  type?: unknown
  status?: unknown
  role?: unknown
  message?: { content?: unknown }
}

interface TranscriptTail {
  entries: TranscriptEntry[]
  // 最后一行还没写完：这一轮不能拿上一轮的 turn_ended 当结论
  incomplete: boolean
  // 最后一条完整行；内容没变时不要用新的 mtime 重算
  lastLine: string
}

function parseTail(path: string): TranscriptTail {
  const text = tailText(path)
  if (!text) return { entries: [], incomplete: false, lastLine: '' }
  const lines = text.split('\n').filter((line) => line.trim())
  const entries: TranscriptEntry[] = []
  let incomplete = false
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as TranscriptEntry
      if (parsed && typeof parsed === 'object') entries.push(parsed)
    } catch {
      if (i === lines.length - 1) incomplete = true
    }
  }
  return { entries, incomplete, lastLine: entries.length ? lines[lines.length - 1] : '' }
}

function lastToolUse(entry: TranscriptEntry): { name: string; input: unknown } | null {
  const content = entry.message?.content
  if (!Array.isArray(content)) return null
  for (let i = content.length - 1; i >= 0; i--) {
    const item = content[i]
    if (!item || typeof item !== 'object') continue
    const block = item as { type?: unknown; name?: unknown; input?: unknown }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return { name: block.name, input: block.input }
    }
  }
  return null
}

function patchPath(patch: string): string {
  return patch.match(/^\*\*\* (?:Update|Add) File: (.+)$/m)?.[1]?.trim() ?? ''
}

// transcript 的工具名与参数位置和 hook 不同，先归一。
function transcriptAction(name: string, input: unknown, at: number): SessionAction | null {
  if (typeof input === 'string') {
    if (name === 'ApplyPatch') return actionOf('Edit', { file_path: patchPath(input) }, at)
    return null
  }
  if (!input || typeof input !== 'object') return null
  const args = input as Record<string, unknown>
  switch (name) {
    case 'Read':
    case 'ReadFile':
      return actionOf('Read', { file_path: args.path ?? args.file_path }, at)
    case 'Write':
      return actionOf('Write', { file_path: args.path ?? args.file_path }, at)
    case 'StrReplace':
      return actionOf('Edit', { file_path: args.path ?? args.file_path }, at)
    case 'Delete':
      return actionOf('Delete', { file_path: args.path ?? args.file_path }, at)
    case 'Shell':
      return actionOf('Shell', args, at)
    case 'Grep':
      return actionOf('Grep', { pattern: args.pattern }, at)
    case 'Glob':
      return actionOf('Glob', { pattern: args.glob_pattern ?? args.pattern }, at)
    case 'Task':
    case 'Subagent':
      return actionOf('Task', { description: args.description }, at)
    case 'WebSearch':
      return actionOf('WebSearch', { query: args.query }, at)
    case 'WebFetch':
      return actionOf('WebFetch', { url: args.url }, at)
    case 'CallMcpTool':
      return actionOf('CallMcpTool', { toolName: args.toolName ?? args.tool_name }, at)
    default:
      return null
  }
}

function observationOf(entries: TranscriptEntry[], observedAt: number): SessionObservation | null {
  if (!entries.length) return null
  const last = entries[entries.length - 1]

  if (last.type === 'turn_ended') {
    const status = str(last.status)
    if (status === 'aborted') {
      return { status: { state: 'blocked', needsAction: '', observedAt, detail: 'Cursor 会话日志：这一轮被停下' }, action: null }
    }
    if (status === 'error') {
      return { status: { state: 'failed', needsAction: '', observedAt, detail: 'Cursor 会话日志：这一轮失败' }, action: null }
    }
    if (status === 'success' || status === 'completed') {
      return { status: { state: 'done', needsAction: '', observedAt, detail: 'Cursor 会话日志：这一轮跑完' }, action: null }
    }
    return { status: unknownStatus(`Cursor 会话日志：认不出的结束状态 ${status || '(空)'}`), action: null }
  }

  if (last.role === 'user') {
    return { status: { state: 'thinking', needsAction: '', observedAt, detail: 'Cursor 会话日志：等模型响应' }, action: null }
  }
  if (last.role === 'assistant') {
    const tool = lastToolUse(last)
    if (tool) {
      return {
        status: { state: 'working', needsAction: '', observedAt, detail: `Cursor 会话日志：在调 ${tool.name}` },
        action: transcriptAction(tool.name, tool.input, observedAt),
      }
    }
    return { status: { state: 'thinking', needsAction: '', observedAt, detail: 'Cursor 会话日志：模型在想下一步' }, action: null }
  }
  return null
}

// 按登记 id 读最新观察；读不到时不返回。
export function cursorObservations(
  cursorHome: string,
  sessions: readonly string[],
): Map<string, SessionObservation> {
  const out = new Map<string, SessionObservation>()
  for (const session of sessions) {
    const path = transcriptPath(cursorHome, session)
    if (!path) continue
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    const cached = transcriptReads.get(path)
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.observation) out.set(session, cached.observation)
      continue
    }
    const { entries, incomplete, lastLine } = parseTail(path)
    if (incomplete || !entries.length) continue
    if (cached && cached.lastLine === lastLine) {
      // 内容没变，只更新 mtime：沿用旧观察的时刻，别让它盖掉更新的 hook
      transcriptReads.set(path, { ...cached, mtimeMs })
      if (cached.observation) out.set(session, cached.observation)
      continue
    }
    const observation = observationOf(entries, mtimeMs)
    transcriptReads.set(path, { mtimeMs, lastLine, observation })
    if (observation) out.set(session, observation)
  }
  return out
}

function usableName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  if (!name || PLACEHOLDER_TITLES.has(name.toLowerCase())) return ''
  return name
}

// chat 库的 meta 可能是十六进制编码的 JSON。
function decodeMeta(value: string): string {
  if (value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)) {
    return Buffer.from(value, 'hex').toString('utf8')
  }
  return value
}

function readTitle(dbPath: string): string | null {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined
    if (typeof row?.value !== 'string') return ''
    const meta = JSON.parse(decodeMeta(row.value)) as { name?: unknown }
    return usableName(meta.name)
  } catch {
    return null
  } finally {
    db.close()
  }
}

function composerTitles(stateDb: string, sessions: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!sessions.length || !existsSync(stateDb)) return out
  let db: DatabaseSync
  try {
    db = new DatabaseSync(stateDb, { readOnly: true })
  } catch {
    return out
  }
  try {
    const stmt = db.prepare('SELECT value FROM composerHeaders WHERE composerId = ?')
    for (const session of sessions) {
      const row = stmt.get(session) as { value?: unknown } | undefined
      if (typeof row?.value !== 'string') continue
      try {
        const meta = JSON.parse(row.value) as { name?: unknown }
        const name = usableName(meta.name)
        if (name) out.set(session, name)
      } catch {
        // 这一行不是 JSON，跳过，别把已经读到的标题丢掉
      }
    }
  } catch {
    // 表不在：这一轮退回 chat 库
    return new Map()
  } finally {
    db.close()
  }
  return out
}

function chatDbPath(cursorHome: string, session: string): string | null {
  const key = cacheKey(cursorHome, session)
  const cached = chatPaths.get(key)
  if (cached && (cached.path || Date.now() - cached.checkedAt < MISS_RETRY_MS)) {
    if (!cached.path || existsSync(cached.path)) return cached.path
    chatPaths.delete(key)
  }
  const chats = join(cursorHome, 'chats')
  for (const workspace of readdirOrEmpty(chats)) {
    const path = join(chats, workspace, session, 'store.db')
    if (existsSync(path)) return path
  }
  return null
}

// 先读 composerHeaders，没有再读 chat 库。
export function cursorTitles(
  cursorHome: string,
  stateDb: string,
  sessions: readonly string[],
): Map<string, string> {
  const fromComposer = composerTitles(stateDb, sessions)
  const out = new Map<string, string>()
  for (const session of sessions) {
    const header = fromComposer.get(session)
    if (header) {
      out.set(session, header)
      continue
    }
    const key = cacheKey(cursorHome, session)
    const path = chatDbPath(cursorHome, session)
    if (!path) {
      chatPaths.set(key, { path: null, checkedAt: Date.now(), mtimeMs: 0, title: '' })
      continue
    }
    let mtimeMs: number
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    const cached = chatPaths.get(key)
    if (cached && cached.path === path && cached.mtimeMs === mtimeMs) {
      if (cached.title) out.set(session, cached.title)
      continue
    }
    const title = readTitle(path)
    if (title === null) continue
    chatPaths.set(key, { path, checkedAt: Date.now(), mtimeMs, title })
    if (title) out.set(session, title)
  }
  return out
}
