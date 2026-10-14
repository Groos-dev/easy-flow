/**
 * agent 的 hook 事件 → 会话实时状态。
 *
 * hook 是「推」：agent 每做一个动作就往 /api/hook POST 一条，比轮询落盘文件（一轮才知道结果）
 * 细一个量级。这条管道只做两件事——把事件名归一成状态、按会话暂存最新一条；
 * 读的时候由 threads.ts 优先取这里，取不到再退回落盘文件那条老路（兜底不能省）。
 *
 * 三条纪律：
 *   - 认不出的事件名 / 缺 session_id 一律忽略，不报错——hook 是别人发来的，不能因为我们没接住就把它呛回去
 *   - 一个会话只留最新一条：状态是「现在在哪」，历史由 agent 自己的 transcript 负责
 *   - 只活在进程内：服务重启就空，正好干净地退回落盘那条路
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
 * 挑事件的口径：只有「主会话的形态变了」才记。SubagentStart / SubagentStop 带 agent_id，
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
    case 'PostToolUseFailure':
      // 工具报错：短暂出错。下一个事件（思考 / 干活 / 收尾）一到就翻过去
      return of('failed', '')
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
}

/**
 * 进程内的最新状态表。一条会话一条，后到覆盖先到。
 * 读侧传 session_id 直接命中；桌面会话的登记 id 是 `local_<uuid>` 而 hook 给的是
 * 内层 `<uuid>`（见 claudeStatus 里的 cliSessionId 映射），所以另外留一个按 cwd 兜的口子。
 */
export class HookStore {
  private entries = new Map<string, Entry>()

  /** 收一条事件。认不出 / 缺 id / 子 agent 事件 → 什么都不做，返回 null */
  record(payload: HookPayload, at = Date.now()): HookStatus | null {
    const session = str(payload.session_id)
    const event = str(payload.hook_event_name)
    if (!session || !event) return null
    // 子 agent 的事件不改主会话状态（SubagentStart / SubagentStop / 子 agent 的工具调用）
    if (str(payload.agent_id)) return null
    // 下线：会话没了，把这条抹掉，读的时候自然退回落盘
    if (event === 'SessionEnd') {
      this.entries.delete(session)
      return null
    }
    const status = normalizeHookEvent(payload, at)
    if (!status) return null
    this.entries.set(session, { status, cwd: normCwd(payload.cwd) })
    return status
  }

  get(session: string): HookStatus | undefined {
    return this.entries.get(session)?.status
  }

  /** 按工作目录找。同一目录开了多条会话时取最近的那条 */
  byCwd(cwd: string): HookStatus | undefined {
    const target = normCwd(cwd)
    if (!target) return undefined
    let best: HookStatus | undefined
    for (const entry of this.entries.values()) {
      if (entry.cwd !== target) continue
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
}

/** 进程内共用的一份：HTTP 层往里写，读看板时从这里取 */
export const hookStore = new HookStore()
