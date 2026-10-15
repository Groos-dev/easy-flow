/**
 * 卡上 pet 的姿势与挑选规则。
 *
 * **姿势就是会话状态本身**，没有第二层词汇：状态有哪几档，pet 就有哪几张脸。
 * 素材与渲染通道在 lib/pet-art.ts；状态字面量在 lib/types.ts（与 server 的 THREAD_STATES 一致）。
 *
 * 这里把「一行 pet 怎么排」算成纯数据（planPetRow）——渲染层只管贴 markup，
 * 排布规则才有回归保护。
 */
import { badgesOf, isEventState } from './threads'
import type { Session, ThreadState } from './types'

/** 会画出来的那些状态：`unknown` 是「读不到」，不给 pet——与角标口径一致 */
export type Pose = Exclude<ThreadState, 'unknown'>

/** 状态显示名，悬停提示用 */
export const PET_LABEL: Record<ThreadState, string> = {
  idle: '静止',
  thinking: '思考',
  working: '干活',
  sweeping: '压上下文',
  blocked: '等你',
  done: '跑完待看',
  failed: '失败',
  unknown: '读不到状态',
}

/**
 * 急缓：卡住 > 失败 > 跑完没看 > 干活 > 思考 > 静止。
 * 只有前三档值得人动——后三档自己会走完，不需要管。
 */
export const PET_RANK: Record<ThreadState, number> = {
  blocked: 0,
  failed: 1,
  done: 2,
  working: 3,
  sweeping: 3,
  thinking: 4,
  idle: 5,
  unknown: 6,
}

/** 抢注意力的分界线：rank 小于等于它的才配那圈脉冲 */
export const PET_ATTENTION = 2

/**
 * 一群 pet 里挑出唯一该「抢注意力」的那只——最急的那只脉冲，其余安静。
 *
 * 这条只 gate 卡住那圈脉冲（.pet.focus.s-blocked）；干活 / 思考的轻动是无条件的，
 * 不靠它——否则最活跃的两档永远轮不到 focus，动效就成了死代码。
 * 没有需要人注意的（全在干活 / 思考 / 静止）返回 -1。并列取靠前的。
 */
export function focusIndex(states: ThreadState[]): number {
  if (states.length === 0) return -1
  let best = 0
  states.forEach((s, i) => {
    if (PET_RANK[s] < PET_RANK[states[best]]) best = i
  })
  return PET_RANK[states[best]] <= PET_ATTENTION ? best : -1
}

/** 一张卡最多挂几只 pet：卡片内容宽约 310px，再多就挤了，多的收成 +N */
export const MAX_PETS = 4

export interface PetItem {
  session: Session
  state: Pose
  /** 事件型状态（跑完 / 卡住 / 失败）：给边框与一次性动效。点过之后变 idle 就没有了 */
  event: boolean
  /** 唯一抢动效的那只（只对 blocked 的脉冲有效）；其余为 false */
  focus: boolean
}

export interface PetRowPlan {
  /** 已截到上限的那几只，超出部分在 more 里 */
  items: PetItem[]
  /** 收成 +N 的数量 */
  more: number
}

/**
 * 一行 pet 的排布：挂哪些会话、截到几只、谁带事件样式、谁抢动效。
 * 渲染层只负责贴 markup，规则在这儿算好才测得动。
 *
 * pet 是**回到会话的入口**，只要读得到状态（unknown 之外）就长期留着；姿势就是状态本身。
 * 点过 pet 会被写成 `idle`（静止），事件边框与抢注意力也跟着消失。
 */
export function planPetRow(sessions: Session[]): PetRowPlan {
  const pets = sessions
    .map((session) => ({ session, state: session.status.state }))
    .filter((p): p is { session: Session; state: Pose } => p.state !== 'unknown')

  // 抢动效仍按 badgesOf 挑（事件 + 在干活），再映射回整排的坐标——
  // 消费掉的 pet 留着，但不抢注意力。badgesOf 已按急缓排序，focusIndex 只认 attention 三档。
  const attentive = badgesOf(sessions)
  const focusAt = focusIndex(attentive.map((s) => s.status.state))
  const focusSession = focusAt >= 0 ? attentive[focusAt] : undefined

  const shown = pets.slice(0, MAX_PETS)
  return {
    items: shown.map((p) => ({
      session: p.session,
      state: p.state,
      event: isEventState(p.session.status.state),
      focus: p.session === focusSession,
    })),
    more: pets.length - shown.length,
  }
}
