/**
 * 卡片角标的挑选。一条需求名下可能挂着好几个会话，**每个会话一个角标**——
 * 同时开着几个 agent 时，看板上要能一眼看出是哪个在等你、哪个在跑。
 *
 * 只有状态说了算：事件是 `done` / `failed`（一轮跑完）与 `blocked`（一轮结束时把问题
 * 抛给了你），它们会一直挂着——不消掉，因为那正是「这条要人推」的理由。消掉的唯一方式是
 * 在 pet 上点一下（板侧把状态写成 `idle`，见 server/hook.ts 的 markIdle）。
 *
 * `thinking` / `working` 不是事件，是实时状态：它们自己会走完。`idle` 是点过的那档、`unknown` 读不到，
 * 都不提示。
 */
import { isEventState } from '../../../shared/thread-events'
import type { Session, ThreadState } from './types'

/** 从急到缓：卡住了 > 出错 > 跑完了 > 干活 > 思考。角标按这个顺序排 */
const ORDER: ThreadState[] = ['blocked', 'failed', 'done', 'working', 'thinking']

/**
 * 事件口径与服务端、通知层共用 src/shared/thread-events.ts，
 * 不再各写一份。
 */
export { isEventState }

/**
 * 这条会话现在要不要挂角标：事件（要人推），或正在跑。
 *
 * 卡片上那圈告警色与原文用的是同一条判据，所以「有告警」与「有可点的入口」永远同时成立。
 * `idle`（点过 pet 写进去的那档）不挂：它就是「这条不用管了」的意思。
 */
export function needsBadge(session: Session): boolean {
  const { state } = session.status
  return state !== 'unknown' && state !== 'idle'
}

/** 一条需求名下该挂角标的会话，按急缓排序；没有就返回空数组（卡片不挂角标） */
export function badgesOf(sessions: Session[]): Session[] {
  return sessions
    .filter(needsBadge)
    .sort((a, b) => ORDER.indexOf(a.status.state) - ORDER.indexOf(b.status.state))
}
