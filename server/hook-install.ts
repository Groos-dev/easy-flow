/**
 * 设置页的「一键配置 hook」：把 easy-flow 的 hook 写进两个 agent 的用户级配置。
 *
 * 硬约束是**只增不改**——Codex 的 ~/.codex/hooks.json 里已经有 cmux / orca，
 * Claude 的 ~/.claude/settings.json 里用户也可能自己配了。所以这里只往事件数组末尾追加自己那条，
 * 卸载时按端点标记（`/api/hook`）只摘自己那条，别人的原样不动；装完再读一遍核对，不写完就说成功。
 *
 * 认「装没装」一律读文件，不看状态文件：用户手工改过要如实反映。
 * 改配置前留一份 `.bak`；文件不是合法 JSON / hooks 字段形状不认识就整个拒改，别把没读懂的配置覆盖掉。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { InstallOutcome } from './skill-install.ts'

export type HookAgentId = 'claude' | 'codex'

/** 设置页每个 agent 一行的状态 */
export interface HookAgentStatus {
  id: HookAgentId
  label: string
  /** 用户级配置文件 */
  file: string
  installed: boolean
  /** 装了几个事件 */
  events: number
  /** 指向的地址与端口 */
  url: string
  /** 读文件出的问题（不是合法 JSON 等）；正常为空串 */
  problem: string
}

export interface HookPlan {
  port: number
  agents: HookAgentStatus[]
}

/** 端点里带 /api/hook 就算自己那条——这是 easy-flow 独有的路径，别人的 hook 不会命中 */
const MARKER = '/api/hook'

function endpoint(port: number, agent: HookAgentId): string {
  return `http://127.0.0.1:${port}/api/hook${agent === 'codex' ? '?agent=codex' : ''}`
}

/**
 * 装哪些事件：管道认的那些，去掉子 agent 那对（store 见 agent_id 就忽略，装了也是死重量）。
 * Claude 侧用 hook-pipeline.md 实测过的那批；Codex 侧用实测事件集里 store 认的部分。
 */
const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'PreCompact',
  'PostCompact',
  'Interrupt',
] as const

/** Claude 的工具类事件才要 matcher，照 hook-pipeline.md 实测的写法 */
const CLAUDE_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

function claudeBlock(event: string, port: number): Record<string, unknown> {
  return {
    ...(CLAUDE_MATCHER_EVENTS.has(event) ? { matcher: '*' } : {}),
    hooks: [
      {
        type: 'command',
        timeout: 3,
        command: `curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- '${endpoint(port, 'claude')}' >/dev/null 2>&1 || true`,
      },
    ],
  }
}

/** Codex 的 hook 只有 command：用 curl 一行转发，零依赖、不限 checkout 路径 */
function codexBlock(_event: string, port: number): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'command',
        timeout: 3,
        command: `curl -s -m 3 -X POST -H 'content-type: application/json' --data-binary @- '${endpoint(port, 'codex')}' >/dev/null 2>&1; echo '{}'`,
      },
    ],
  }
}

interface HookSpec {
  id: HookAgentId
  label: string
  file: string
  events: readonly string[]
  block: (event: string, port: number) => Record<string, unknown>
  endpoint: (port: number) => string
}

function specs(home: string): HookSpec[] {
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      file: join(home, '.claude', 'settings.json'),
      events: CLAUDE_EVENTS,
      block: claudeBlock,
      endpoint: (port) => endpoint(port, 'claude'),
    },
    {
      id: 'codex',
      label: 'Codex',
      file: join(home, '.codex', 'hooks.json'),
      events: CODEX_EVENTS,
      block: codexBlock,
      endpoint: (port) => endpoint(port, 'codex'),
    },
  ]
}

/** 一个 block 是不是我们那条：它的 hooks[] 里任一条带 /api/hook 端点 */
function isOurBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const hooks = (block as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((h) => {
    if (!h || typeof h !== 'object') return false
    const rec = h as Record<string, unknown>
    return (
      (typeof rec.url === 'string' && rec.url.includes(MARKER)) ||
      (typeof rec.command === 'string' && rec.command.includes(MARKER))
    )
  })
}

type Loaded =
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; obj: Record<string, unknown>; trailingNewline: boolean }

function load(file: string): Loaded {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { kind: 'error', message: `${file} 不是合法 JSON（${(err as Error).message}）` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'error', message: `${file} 顶层不是 JSON 对象` }
  }
  return { kind: 'ok', obj: parsed as Record<string, unknown>, trailingNewline: raw.endsWith('\n') }
}

/** 按原文件的缩进与行尾习惯回写，让「装完再卸完」能逐字还原 */
function render(obj: Record<string, unknown>, trailingNewline: boolean): string {
  return JSON.stringify(obj, null, 2) + (trailingNewline ? '\n' : '')
}

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T
}

function tableOf(obj: Record<string, unknown>): Record<string, unknown> {
  const h = obj.hooks
  return h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : {}
}

/**
 * 就地改一份配置：先把任意事件下的自己那条全摘掉，装的时候再往目标事件追加。
 * 「先摘后加」一次覆盖两种情形——换端口要更新、重复点装不能出现第二条。
 * 返回是否真的改动了，据此决定要不要落盘（幂等时不碰文件、不产 .bak）。
 */
function apply(
  obj: Record<string, unknown>,
  spec: HookSpec,
  port: number,
  mode: 'install' | 'uninstall',
): boolean {
  const table = tableOf(obj)
  let changed = false
  for (const [event, value] of Object.entries(table)) {
    if (!Array.isArray(value)) continue
    const kept = value.filter((b) => !isOurBlock(b))
    if (kept.length === value.length) continue
    changed = true
    if (kept.length) table[event] = kept
    else delete table[event]
  }
  if (mode === 'install') {
    for (const event of spec.events) {
      const list = Array.isArray(table[event]) ? (table[event] as unknown[]).slice() : []
      list.push(spec.block(event, port))
      table[event] = list
      changed = true
    }
  }
  if (changed) {
    if (Object.keys(table).length) obj.hooks = table
    else delete obj.hooks
  }
  return changed
}

function countOurs(obj: Record<string, unknown>): number {
  let n = 0
  for (const value of Object.values(tableOf(obj))) {
    if (!Array.isArray(value)) continue
    n += value.filter((b) => isOurBlock(b)).length
  }
  return n
}

function backup(file: string): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
}

/** 读现状：每个 agent 装没装、装了几个事件、指向哪个地址与端口。 */
export function hookPlan({ port, home = homedir() }: { port: number; home?: string }): HookPlan {
  return {
    port,
    agents: specs(home).map((spec) => {
      const base = { id: spec.id, label: spec.label, file: spec.file, url: spec.endpoint(port) }
      const loaded = load(spec.file)
      if (loaded.kind === 'missing') return { ...base, installed: false, events: 0, problem: '' }
      if (loaded.kind === 'error') return { ...base, installed: false, events: 0, problem: loaded.message }
      const events = countOurs(loaded.obj)
      return { ...base, installed: events > 0, events, problem: '' }
    }),
  }
}

/** 一键装：两个 agent 各写一份，只追加自己那条；写完读一遍核对。 */
export function installHooks({ port, home = homedir() }: { port: number; home?: string }): InstallOutcome {
  let changed = false
  for (const spec of specs(home)) {
    const loaded = load(spec.file)
    if (loaded.kind === 'error') throw new Error(`没敢改 ${spec.file}：${loaded.message}`)
    const obj = loaded.kind === 'ok' ? clone(loaded.obj) : {}
    const trailingNewline = loaded.kind === 'ok' ? loaded.trailingNewline : true
    if (obj.hooks !== undefined && !(typeof obj.hooks === 'object' && obj.hooks && !Array.isArray(obj.hooks))) {
      throw new Error(`${spec.file} 的 hooks 字段不是对象，没敢改`)
    }
    const before = loaded.kind === 'ok' ? render(loaded.obj, trailingNewline) : null
    apply(obj, spec, port, 'install')
    const after = render(obj, trailingNewline)
    if (after === before) continue

    backup(spec.file)
    mkdirSync(dirname(spec.file), { recursive: true })
    writeFileSync(spec.file, after, 'utf8')

    // 写完再读一遍核对，别写完就说成功
    const verify = load(spec.file)
    const events = verify.kind === 'ok' ? countOurs(verify.obj) : 0
    if (events !== spec.events.length) {
      throw new Error(`${spec.label} 写入后核对不一致：只认出 ${events}/${spec.events.length} 个事件`)
    }
    changed = true
  }
  return { summary: changed ? '已安装' : '已是最新，没有改动', failed: [] }
}

/**
 * 一键卸：只摘自己那条（按端点标记），别人的原样不动；没有就跳过，不报错。
 * 配置文件不存在或读不了都算没得可卸——读不了的那份由设置页的状态行报出来。
 */
export function uninstallHooks({ home = homedir() }: { home?: string } = {}): InstallOutcome {
  let removed = false
  for (const spec of specs(home)) {
    const loaded = load(spec.file)
    if (loaded.kind !== 'ok') continue
    const obj = clone(loaded.obj)
    if (!apply(obj, spec, 0, 'uninstall')) continue

    backup(spec.file)
    writeFileSync(spec.file, render(obj, loaded.trailingNewline), 'utf8')
    removed = true
  }
  return { summary: removed ? '已卸载' : '没有需要卸载的条目', failed: [] }
}
