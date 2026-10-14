/**
 * agent 的 hook 事件 → 会话实时状态。
 *
 * hook 是「推」：agent 每做一个动作就往 /api/hook POST 一条，比轮询落盘文件（一轮才知道结果）
 * 细一个量级。这条管道只做两件事——把事件名归一成状态、按会话暂存最新一条；
 * 读的时候由 threads.ts 优先取这里，取不到再退回落盘文件那条老路（兜底不能省）。
 *
 * 四条纪律：
 *   - 认不出的事件名 / 缺 session_id 一律忽略，不报错——hook 是别人发来的，不能因为我们没接住就把它呛回去
 *   - 一个会话只留最新一条：状态是「现在在哪」，历史由 agent 自己的 transcript 负责
 *   - 只活在进程内：服务重启就空，正好干净地退回落盘那条路
 *   - 认来源：claude 与 codex 共用这一个入口，条目按 agent 分开存，读的时候也只认自己那条
 *
 * 实测依据见需求 docs/easy-flow/hook-pipeline.md（本机 claude 2.1.278：http hook 生效、
 * session_id 等于 CLAUDE_CODE_SESSION_ID、主 agent 不带 agent_id）。
 */
import { realpathSync } from 'node:fs'
import type { ThreadState } from './threads.ts'

/**
 * 细粒度活动。state 只有四档半（running 把「思考」和「干活」压成了一档），
 * pet 要按姿势分开就得有个更细的字段——hook 驱动时有值，落盘兜底路径为空。
 */
export const SESSION_ACTIVITIES = ['idle', 'thinking', 'working'] as const
export type SessionActivity = (typeof SESSION_ACTIVITIES)[number]

/**
 * hook 状态最多信这么久。过了就当这条观察不再算数，读的时候退回落盘文件。
 *
 * 四档都要过期，不能只给 running：`Stop` / `StopFailure` / `PermissionRequest` 如果永不过期，
 * 一条陈年事件会一直压着落盘结论——codex 那边没配 SessionEnd 就永久卡住。
 */
export const HOOK_TTL_MS = 30 * 60_000

/** 一条会话的实时状态。state / activity 与 SessionStatus 同一套口径 */
export interface HookStatus {
  state: ThreadState
  activity: SessionActivity | ''
  /** 需要人介入时那句话原文；hook 事件里通常没有，留空 */
  needsAction: string
  /** 归一时刻（epoch ms），展示前再格式化成库里的口径 */
  at: number
  /** 触发它的事件名，详情页 hover 用 */
  event: string
}

/** hook 打过来的 JSON。字段随事件变，只挑我们认的；其余原样放着不关心 */
export interface HookPayload {
  hook_event_name?: unknown
  session_id?: unknown
  cwd?: unknown
  tool_name?: unknown
  agent_id?: unknown
  [key: string]: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 事件名 → 状态。认不出返回 null（调用方忽略）。
 *
 * 表里两个 agent 的事件都要认（一条管道共用）：claude 发 `PostToolUseFailure`，
 * codex 发 `Interrupt` 与 `PreCompact` / `PostCompact`。少认一个的后果是状态卡在旧值上，
 * 比如打断后一直显示「干活」。
 *
 * 挑事件的口径：只有「主会话的形态变了」才记。`SubagentStart` / `SubagentStop` 带 agent_id，
 * 那是子 agent 的生死，不是主会话的状态——一张卡一只 pet，子 agent 不另开，所以这里不接。
 */
export function normalizeHookEvent(payload: HookPayload, at = Date.now()): HookStatus | null {
  const event = str(payload.hook_event_name)
  if (!event) return null
  const of = (state: ThreadState, activity: SessionActivity | ''): HookStatus => ({
    state,
    activity,
    needsAction: '',
    at,
    event,
  })
  switch (event) {
    case 'SessionStart':
      // 上线：会话活着但还没干活——姿势是静止（activity），没活可看
      return of('running', 'idle')
    case 'UserPromptSubmit':
    case 'PostToolUse':
      // 收到人话 / 工具跑完：模型在想下一步
      return of('running', 'thinking')
    case 'PreToolUse':
      // 要调工具了：这是「干活」，tool_name 在 payload 里，不改状态形状
      return of('running', 'working')
    case 'PreCompact':
    case 'PostCompact':
      // 压上下文：活儿还在跑，只是不在调工具
      return of('running', 'thinking')
    case 'PostToolUseFailure':
      // 工具报错：短暂出错。下一个事件（思考 / 干活 / 收尾）一到就翻过去
      return of('failed', '')
    case 'Interrupt':
      // 被打断（人按了停）：停下等人接手，不能停在「干活」上
      return of('blocked', '')
    case 'PermissionRequest':
      // 卡住等人授权。事件里没有那句要人回答的话，原文留空
      return of('blocked', '')
    case 'Stop':
      return of('done', '')
    case 'StopFailure':
      return of('failed', '')
    default:
      return null
  }
}

/** 目录归一：macOS 的 /tmp 与 /private/tmp 是同一个地方，不归一就配不上 */
function normCwd(raw: unknown): string {
  const path = str(raw)
  if (!path) return ''
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

interface Entry {
  status: HookStatus
  /** 事件带来的工作目录，归一过；用来在没有 id 映射时按 cwd 兜 */
  cwd: string
  /** 来源 agent。两条管道共用入口，条目必须认得出是谁发的 */
  agent: string
}

function key(agent: string, session: string): string {
  return `${agent}\u0000${session}`
}

export interface RecordOptions {
  /** 来源 agent。claude 的原生 http hook 带不了额外字段，所以缺省就是 claude */
  agent?: string
  at?: number
}

/**
 * 进程内的最新状态表。一条会话一条，后到覆盖先到。
 * 读侧传 session_id 直接命中；桌面会话的登记 id 是 `local_<uuid>` 而 hook 给的是
 * 内层 `<uuid>`（见 threads.ts 的 cliSessionId 映射），所以另外留一个按 cwd 兜的口子。
 *
 * 过期的条目在读的时候不返回，写的时候顺手清掉——崩溃的会话不会有 SessionEnd，
 * 不清理 map 会随进程一直涨。
 */
export class HookStore {
  private entries = new Map<string, Entry>()

  /** 收一条事件。认不出 / 缺 id / 子 agent 事件 → 什么都不做，返回 null */
  record(payload: HookPayload, { agent = 'claude', at = Date.now() }: RecordOptions = {}): HookStatus | null {
    const session = str(payload.session_id)
    const event = str(payload.hook_event_name)
    if (!session || !event) return null
    // 子 agent 的事件不改主会话状态（SubagentStart / SubagentStop / 子 agent 的工具调用）
    if (str(payload.agent_id)) return null
    // 下线：会话没了，把这条抹掉，读的时候自然退回落盘
    if (event === 'SessionEnd') {
      this.entries.delete(key(agent, session))
      this.prune()
      return null
    }
    const status = normalizeHookEvent(payload, at)
    if (!status) return null
    this.entries.set(key(agent, session), { status, cwd: normCwd(payload.cwd), agent })
    this.prune()
    return status
  }

  get(session: string, agent: string): HookStatus | undefined {
    const entry = this.entries.get(key(agent, session))
    return entry && !expired(entry.status, Date.now()) ? entry.status : undefined
  }

  /** 按工作目录找，只认同一个 agent 的条目。同目录多条时取最近的那条 */
  byCwd(cwd: string, agent: string): HookStatus | undefined {
    const target = normCwd(cwd)
    if (!target) return undefined
    const now = Date.now()
    let best: HookStatus | undefined
    for (const entry of this.entries.values()) {
      if (entry.agent !== agent || entry.cwd !== target) continue
      if (expired(entry.status, now)) continue
      if (!best || entry.status.at > best.at) best = entry.status
    }
    return best
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  /** 按当前时刻清掉过期条目——没有新事件时由 get / byCwd 的 expired 兜住 */
  private prune(): void {
    const now = Date.now()
    for (const [k, entry] of this.entries) {
      if (expired(entry.status, now)) this.entries.delete(k)
    }
  }
}

function expired(status: HookStatus, now: number): boolean {
  return now - status.at > HOOK_TTL_MS
}

/** 进程内共用的一份：HTTP 层往里写，读看板时从这里取 */
export const hookStore = new HookStore()
