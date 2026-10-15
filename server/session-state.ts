/**
 * 会话状态层：一条会话一条，所有来源都写它。
 *
 * 来源三类：
 *   推送  agent 的 hook 事件（每做一个动作 POST 一条，比拉落盘细一个量级）
 *   拉取  看板请求时读 agent 的落盘——claude 的桌面记录与 CLI 进程、codex 的 rollout jsonl
 *   交互  点一下 pet（板侧写「这条静止」，会话再动起来时被下一个事件覆盖）
 *
 * 全表只有一条规则——**时刻新的赢**。不能是「写得晚的赢」：拉取是快照、推送是事件，
 * 快照可能比事件旧，21:00 的 PreToolUse 不能被 18:00 的落盘结论盖掉。
 *
 * key 用 agent 自己报的那个 id（claude 的内层 `<uuid>`、codex 的 thread id）。桌面会话的登记
 * id 是 `local_<uuid>`，与它不同名——写与读之前都拿记录里的 cliSessionId 翻一下
 * （见 threads.ts 的 hookKeyOf），这样点击与 hook 事件才落在同一个格子里。
 */

/**
 * 状态字面量。服务端与渲染层共用这一套，展示层不再译第二遍。
 *
 * 一个字段说清「这条会话现在是什么形态」——不另开一层细粒度活动：`running` 那种笼统值
 * 与 `thinking` / `working` 这种细值本来就是一个概念，拆到两个字段里只会多一层翻译。
 *
 * 命名与 clawd-on-desk 的六档姿势一一对应（attention / notification / error 那边叫这名，
 * 这边按看板自己的语义叫 done / blocked / failed，映射在 lib/pet-art.ts）。
 * `unknown` 是我们加的：它不是一种状态，是「读不到」。
 */
export const THREAD_STATES = ['idle', 'thinking', 'working', 'done', 'blocked', 'failed', 'unknown'] as const
export type ThreadState = (typeof THREAD_STATES)[number]

/** 一条会话状态的观察。所有来源都写这个，写的人自己把判据拼进 detail */
export interface SessionStatus {
  state: ThreadState
  /** 需要人介入时，要人回答的那句话原文；其余为空串 */
  needsAction: string
  /** 这条状态的时刻（epoch ms）。展示时才格式化成库里的口径（yyyy-mm-dd HH:mm） */
  observedAt: number
  /** 判据出处，详情页 hover 用 */
  detail: string
}

/** 读不到时的状态。调用方拿不到条目时也该拿到它，而不是自己拼一个 */
export function unknownStatus(detail: string): SessionStatus {
  return { state: 'unknown', needsAction: '', observedAt: 0, detail }
}

/** 板侧写的那条：点一下 pet = 这条会话此刻「静止」，不用管了 */
export function idleStatus(at = Date.now()): SessionStatus {
  return { state: 'idle', needsAction: '', observedAt: at, detail: '板侧：点过 pet' }
}

/** 在干活的那些档：会话真在动，跟「静止 / 等你」分开 */
export function isActive(state: ThreadState): boolean {
  return state === 'thinking' || state === 'working'
}

export class SessionStateStore {
  private entries = new Map<string, SessionStatus>()

  /**
   * 写一条。**时刻新的赢**；一样新时说得出状态的那条赢——`unknown` 只是「这个来源说不出话」，
   * 它不该盖掉一条真的观察。`observedAt` 为 0 表示说不出时刻，只在表里空着时落得下。
   * 返回是否采纳。
   */
  put(agent: string, session: string, status: SessionStatus): boolean {
    const k = key(agent, session)
    const old = this.entries.get(k)
    if (old && !newer(status, old)) return false
    this.entries.set(k, status)
    return true
  }

  get(agent: string, session: string): SessionStatus | undefined {
    return this.entries.get(key(agent, session))
  }

  /** 会话下线：抹掉。读的时候自然落回「读不到」 */
  remove(agent: string, session: string): void {
    this.entries.delete(key(agent, session))
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

function newer(next: SessionStatus, old: SessionStatus): boolean {
  if (next.observedAt !== old.observedAt) return next.observedAt > old.observedAt
  // 一样新：unknown 不许盖掉一条真的观察；两条都真就是「后到覆盖先到」
  return old.state === 'unknown' || next.state !== 'unknown'
}

/** key 里带上 agent——同一个工作区并排跑着 claude 与 codex 是常态，不分开就会互相点亮 */
function key(agent: string, session: string): string {
  return `${agent}\u0000${session}`
}

/** 进程内共用的一份：所有来源往里写，读看板时从这里取 */
export const sessionState = new SessionStateStore()
