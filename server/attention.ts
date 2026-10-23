/**
 * 会话事件 → dock 红点与系统通知：只做判断与文案，不碰 Electron。
 *
 * 事件口径沿用 thread-status：`done` / `blocked` / `failed` 才算事件，正在跑不是；
 * `unknown` 是「读不到」，不是「没事了」——一次读失败不能把已经挂着的红点抹掉。
 *
 * 一条会话同时只挂一个事件（身份键 `agent:session`），推送键再带上状态与时刻：
 * 同一轮询反复读到同一个观察只算一次，同一会话的下一轮则是新事件。
 */
import { EVENT_STATES, isEventState } from '../src/shared/thread-events.ts'
import type { EventState, SessionStatus } from './session-state.ts'

export type AttentionState = EventState

/** 角标与通知的急缓顺序，与「哪些状态算事件」是两件事 */
const SEVERITY: readonly AttentionState[] = ['blocked', 'failed', 'done']

/** 通知要跳回哪条需求。字段与服务端的 Requirement 对齐，只带用得上的 */
export interface AttentionRequirement {
  id: string
  title: string
  slug: string
  project: string
}

export interface AttentionSession {
  agent: string
  session: string
  /** agent 会话自己的标题；登记时由 agent 给，通知副标题用 */
  sessionTitle: string
  /** 打开这条会话的 deeplink；没有则为空串 */
  link: string
  requirement: AttentionRequirement
  /** 通知层只需要这几项；hookEvent 用来识别 Interrupt 这类不该打扰的事件 */
  status: Pick<SessionStatus, 'state' | 'needsAction' | 'observedAt' | 'hookEvent'>
}

export interface AttentionEvent {
  /** 身份键：同一会话同时只挂一个事件 */
  id: string
  /** 推送键：身份 + 状态 + 时刻。重复轮询同一个观察不会重复推送 */
  pushKey: string
  agent: string
  session: string
  /** agent 会话标题；通知副标题拼在 agent 名后面 */
  sessionTitle: string
  link: string
  requirement: AttentionRequirement
  state: AttentionState
  needsAction: string
  observedAt: number
  /** hook 事件名；通知层用它识别 Interrupt 等不该打扰的事件 */
  hookEvent?: string
  /** 第一次读到 unknown 的时刻；读回来就清掉，挂太久由 TTL 收掉 */
  staleSince?: number
}

/** 一直读不到的会话挂多久就自动消账：agent 记录被删、应用卸载后不能永远占着红点 */
export const UNKNOWN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 同一会话、同一状态在这个窗口内重复到达，视为同一条事件。
 * hook 的重试、用户级与项目级双装 hook 都会让同一事件被投递两次，
 * 而 observedAt 是接收方盖的时间戳，不能用来区分「两次事件」。
 */
const EVENT_DEDUPE_WINDOW_MS = 10_000

export interface AttentionDiff {
  /** 当前仍然挂着的事件（含启动时恢复的） */
  outstanding: AttentionEvent[]
  /** 本次新出现、需要推送的事件；启动第一轮永远是空（只对齐，不补炸） */
  added: AttentionEvent[]
  /** 本次消账的事件 */
  cleared: AttentionEvent[]
  /** 因为长期 unknown 被 TTL 收掉的事件（也属于消账，单独列出以便记日志） */
  expired: AttentionEvent[]
}

function attentionIdOf(agent: string, session: string): string {
  return `${agent}:${session}`
}

export function attentionPushKeyOf(agent: string, session: string, state: AttentionState, observedAt: number): string {
  return `${agent}:${session}:${state}:${observedAt}`
}

function toEvent(session: AttentionSession, state: AttentionState): AttentionEvent {
  return {
    id: attentionIdOf(session.agent, session.session),
    pushKey: attentionPushKeyOf(session.agent, session.session, state, session.status.observedAt),
    agent: session.agent,
    session: session.session,
    sessionTitle: session.sessionTitle,
    link: session.link,
    requirement: session.requirement,
    state,
    needsAction: session.status.needsAction,
    observedAt: session.status.observedAt,
    hookEvent: session.status.hookEvent,
  }
}

/** 急的在前，同档按时刻新的在前 */
function sortEvents(events: Iterable<AttentionEvent>): AttentionEvent[] {
  return [...events].sort((a, b) => {
    const byState = SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state)
    if (byState !== 0) return byState
    if (a.observedAt !== b.observedAt) return b.observedAt - a.observedAt
    return a.id.localeCompare(b.id)
  })
}

export class AttentionTracker {
  private current = new Map<string, AttentionEvent>()
  /** 启动后的第一轮只对齐持久化状态，不推送停机期间堆下的事件 */
  private primed = false

  constructor(initial: readonly AttentionEvent[] = []) {
    for (const event of initial) this.current.set(event.id, event)
  }

  observe(sessions: readonly AttentionSession[], now = Date.now()): AttentionDiff {
    const next = new Map<string, AttentionEvent>()
    const added: AttentionEvent[] = []
    const expired: AttentionEvent[] = []

    for (const session of sessions) {
      const { state } = session.status
      const id = attentionIdOf(session.agent, session.session)

      if (isEventState(state)) {
        const event = toEvent(session, state)
        const old = this.current.get(id)
        // 同一事件在窗口内重复到达：沿用旧推送键，不重复推送。
        // hook 推送带事件名、pull 快照不带，缺一边时不能据此判成两件事；
        // 两边都有事件名且不同（Interrupt → PermissionRequest）才是新事件。
        const sameHookEvent =
          !event.hookEvent || !old?.hookEvent || event.hookEvent === old.hookEvent
        // 同状态但一边还没拿到问题原文时也按同一事件合并，
        // 避免 hook 与 pull 各推一次
        const sameQuestion =
          !event.needsAction || !old?.needsAction || event.needsAction === old.needsAction
        if (
          old &&
          old.state === state &&
          sameQuestion &&
          sameHookEvent &&
          Math.abs(event.observedAt - old.observedAt) < EVENT_DEDUPE_WINDOW_MS
        ) {
          next.set(id, {
            ...event,
            pushKey: old.pushKey,
            observedAt: old.observedAt,
            needsAction: event.needsAction || old.needsAction,
            hookEvent: old.hookEvent || event.hookEvent,
          })
          continue
        }
        next.set(id, event)
        if (this.primed && old?.pushKey !== event.pushKey) added.push(event)
        continue
      }

      // 读不到：保留上一条事件。读失败不等于事情解决了
      if (state === 'unknown') {
        const old = this.current.get(id)
        if (!old) continue
        const staleSince = old.staleSince ?? now
        if (now - staleSince >= UNKNOWN_TTL_MS) {
          expired.push({ ...old, staleSince })
          continue
        }
        next.set(id, { ...old, staleSince })
      }
      // idle / thinking / working / sweeping：消账，不进 next
    }

    const expiredIds = new Set(expired.map((event) => event.id))
    const cleared: AttentionEvent[] = []
    for (const [id, old] of this.current) {
      if (!next.has(id) && !expiredIds.has(id)) cleared.push(old)
    }

    this.current = next
    this.primed = true
    return {
      outstanding: sortEvents(next.values()),
      added: sortEvents(added),
      cleared,
      expired: sortEvents(expired),
    }
  }

  snapshot(): AttentionEvent[] {
    return sortEvents(this.current.values())
  }
}

// ---------------------------------------------------------------- 通知文案

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  chengxiaobang: '程小帮',
}

function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent
}

export interface AttentionNotification {
  title: string
  subtitle: string
  body: string
  /** 全部是跑完时不出声；有卡住 / 失败时出声 */
  silent: boolean
  requirement: AttentionRequirement
  events: AttentionEvent[]
}

/** 通知标题只留一行：换行压成空格，超长截断加省略号 */
const TITLE_MAX_CHARS = 14
const SESSION_TITLE_MAX_CHARS = 18

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

function oneLineTitle(title: string): string {
  return oneLine(title, TITLE_MAX_CHARS)
}

/** 通知只报「谁、哪条需求」：副标题是 agent 名，不再写「这一轮跑完了」这类轮次描述 */
function agentTitles(group: readonly AttentionEvent[]): string {
  const labels = group.map((event) => {
    const agent = agentLabel(event.agent)
    const title = oneLine(event.sessionTitle, SESSION_TITLE_MAX_CHARS)
    return title ? `${agent} · ${title}` : agent
  })
  return [...new Set(labels)].sort().join('、')
}

/** 需要人回答的原话才进正文；多条时标上是谁在问 */
function questionBody(group: readonly AttentionEvent[]): string {
  const asked = group.filter((event) => event.state === 'blocked' && event.needsAction)
  return asked
    .map((event) =>
      group.length === 1 ? event.needsAction : `${agentLabel(event.agent)}：${event.needsAction}`,
    )
    .join('\n')
}

/**
 * 按需求合并：一个轮询周期里同一需求的多条事件只发一条通知。
 * 按会话合并会在并行跑三个 agent 时产生三条几乎一样的通知，反而更吵。
 */
export function groupAttentionNotifications(events: readonly AttentionEvent[]): AttentionNotification[] {
  const groups = new Map<string, AttentionEvent[]>()
  for (const event of sortEvents(events)) {
    const group = groups.get(event.requirement.id)
    if (group) group.push(event)
    else groups.set(event.requirement.id, [event])
  }

  return [...groups.values()].map((group) => {
    const requirement = group[0].requirement
    return {
      title: oneLineTitle(requirement.title),
      subtitle: agentTitles(group),
      body: questionBody(group),
      silent: group.every((event) => event.state === 'done'),
      requirement,
      events: group,
    }
  })
}

/** 持久化的形状：只存事件本身，标题等展示字段重启后由快照刷新 */
export interface AttentionFile {
  events: AttentionEvent[]
}

export function readAttentionFile(raw: string): AttentionEvent[] {
  try {
    const parsed = JSON.parse(raw) as Partial<AttentionFile> | null
    if (!Array.isArray(parsed?.events)) return []
    return parsed.events.filter(isEvent).map((event) => ({
      ...event,
      link: typeof event.link === 'string' ? event.link : '',
      sessionTitle: typeof event.sessionTitle === 'string' ? event.sessionTitle : '',
      needsAction: typeof event.needsAction === 'string' ? event.needsAction : '',
      ...(typeof event.hookEvent === 'string' && event.hookEvent
        ? { hookEvent: event.hookEvent }
        : {}),
      ...(typeof event.staleSince === 'number' ? { staleSince: event.staleSince } : {}),
    }))
  } catch {
    return []
  }
}

function isEvent(value: unknown): value is AttentionEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<AttentionEvent>
  return (
    typeof event.id === 'string' &&
    typeof event.pushKey === 'string' &&
    typeof event.agent === 'string' &&
    typeof event.session === 'string' &&
    typeof event.state === 'string' &&
    (EVENT_STATES as readonly string[]).includes(event.state) &&
    typeof event.observedAt === 'number' &&
    typeof event.requirement === 'object' &&
    event.requirement !== null &&
    typeof event.requirement.id === 'string' &&
    typeof event.requirement.title === 'string' &&
    typeof event.requirement.slug === 'string' &&
    typeof event.requirement.project === 'string'
  )
}
