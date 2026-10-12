/**
 * 卡片角标的挑选。一条需求名下可能挂着好几个会话，**每个会话一个角标**——
 * 同时开着几个 agent 时，看板上要能一眼看出是哪个在等你、哪个在跑。
 *
 * 整套按 IM 的未读来做：只有**事件**才提示，读过了就不再提示。事件是
 * `done` / `failed`（一轮跑完）与 `blocked`（一轮结束时把问题抛给了你）；
 * 「读过」由服务端给的 fresh 判——Claude 看会话有没有在你最后一次聚焦之后动过，
 * Codex 看官方的未读集合，你一打开会话那边就把标记清了。
 *
 * `running` 不是事件，是实时状态：它自己会结束，不需要人「消费」，所以不受已读影响。
 * `unknown` 读不到，不提示。
 */
import type { Session, ThreadState } from './types'

/** 从急到缓：卡住了 > 出错 > 跑完了没看 > 正在跑。角标按这个顺序排 */
const ORDER: ThreadState[] = ['blocked', 'failed', 'done', 'running']

/** 是不是「事件」型状态：会攒下未读、需要人消费的那种。其余是实时状态或读不到 */
export function isEventState(state: ThreadState): boolean {
  return state === 'done' || state === 'blocked' || state === 'failed'
}

/** 这条会话现在要不要挂角标：未读事件，或正在跑 */
export function needsBadge(session: Session): boolean {
  const { state, fresh } = session.status
  if (state === 'unknown') return false
  return !isEventState(state) || fresh
}

/** 一条需求名下该挂角标的会话，按急缓排序；没有就返回空数组（卡片不挂角标） */
export function badgesOf(sessions: Session[]): Session[] {
  return sessions
    .filter(needsBadge)
    .sort((a, b) => ORDER.indexOf(a.status.state) - ORDER.indexOf(b.status.state))
}
