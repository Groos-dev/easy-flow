/**
 * agent 的 hook 事件 → 会话状态（**推送源**）。
 *
 * hook 是「推」：agent 每做一个动作就往 /api/hook POST 一条，比拉落盘文件（一轮才知道结果）
 * 细一个量级。这里只做两件事——把事件名归一成状态、写进状态层（见 session-state.ts）；
 * 拉不到、没装、事件认不出时，读侧自然落回拉取那条路（兜底不能省）。
 *
 * 四条纪律：
 *   - 认不出的事件名 / 缺 session_id 一律忽略，不报错——hook 是别人发来的，不能因为我们没接住就把它呛回去
 *   - 一个会话只留最新一条：状态是「现在在哪」，历史由 agent 自己的 transcript 负责
 *   - 只活在进程内：服务重启就空，正好干净地退回拉取那条路
 *   - 认来源：claude 与 codex 共用这一个入口，条目按 agent 分开存，读的时候也只认自己那条
 *
 * 实测依据见需求 docs/easy-flow/hook-pipeline.md（本机 claude 2.1.278：http hook 生效、
 * session_id 等于 CLAUDE_CODE_SESSION_ID、主 agent 不带 agent_id）。
 */
import { type SessionStateStore, type SessionStatus, type ThreadState } from './session-state.ts'

/** hook 打过来的 JSON。字段随事件变，只挑我们认的；其余原样放着不关心 */
export interface HookPayload {
  hook_event_name?: unknown
  session_id?: unknown
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
export function normalizeHookEvent(payload: HookPayload, at = Date.now()): SessionStatus | null {
  const event = str(payload.hook_event_name)
  if (!event) return null
  const of = (state: ThreadState): SessionStatus => ({
    state,
    needsAction: '',
    observedAt: at,
    detail: `hook 事件：${event}`,
  })
  switch (event) {
    case 'SessionStart':
      // 上线：会话活着但还没干活——姿势是静止，没活可看
      return of('idle')
    case 'UserPromptSubmit':
    case 'PostToolUse':
      // 收到人话 / 工具跑完：模型在想下一步
      return of('thinking')
    case 'PreToolUse':
      // 要调工具了：这是「干活」，tool_name 在 payload 里，不改状态形状
      return of('working')
    case 'PreCompact':
      return of('sweeping')
    case 'PostCompact':
      // 压上下文：活儿还在跑，只是不在调工具
      return of('thinking')
    case 'PostToolUseFailure':
      // 工具报错：短暂出错。下一个事件（思考 / 干活 / 收尾）一到就翻过去
      return of('failed')
    case 'Interrupt':
      // 被打断（人按了停）：停下等人接手，不能停在「干活」上
      return of('blocked')
    case 'PermissionRequest':
      // 卡住等人授权。事件里没有那句要人回答的话，原文留空
      return of('blocked')
    case 'Stop':
      return of('done')
    case 'StopFailure':
      return of('failed')
    default:
      return null
  }
}

export interface RecordOptions {
  /** 来源 agent。claude 的原生 http hook 带不了额外字段，所以缺省就是 claude */
  agent?: string
  at?: number
}

/**
 * 收一条事件，写进状态层。认不出 / 缺 id / 子 agent 事件 → 什么都不做，返回 null。
 *
 * key 用 hook 自己报的 session_id：桌面会话报的是内层 `<uuid>`，与登记 id 不同名，
 * 读侧与点击都靠 cliSessionId 翻到同一个格子上（见 threads.ts 的 hookKeyOf）。
 */
export function recordHook(
  payload: HookPayload,
  { agent = 'claude', at = Date.now() }: RecordOptions = {},
  store: SessionStateStore,
): SessionStatus | null {
  const session = str(payload.session_id)
  const event = str(payload.hook_event_name)
  if (!session || !event) return null
  // 子 agent 的事件不改主会话状态（SubagentStart / SubagentStop / 子 agent 的工具调用）
  if (str(payload.agent_id)) return null
  // 下线：会话没了，抹掉这条，读的时候自然退回拉取那条路
  if (event === 'SessionEnd') {
    store.remove(agent, session)
    return null
  }
  const status = normalizeHookEvent(payload, at)
  if (!status) return null
  store.put(agent, session, status)
  return status
}
