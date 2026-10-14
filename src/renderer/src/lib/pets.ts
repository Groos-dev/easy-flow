/**
 * 卡上 pet 的状态词汇与挑选规则。
 *
 * 六档姿势来自设计稿（design/card-draft.html）：静止 / 思考 / 干活 / 等你 / 跑完待看 / 失败。
 * 一个 agent 一套形象（身材与颜色都在素材里），姿势 + 光环归状态，换 agent 也认得出在干什么。
 * 这里只管状态词汇与一行怎么排；素材文件与渲染通道在 lib/pet-art.ts。
 *
 * 除了挑状态，这里也把「一行 pet 怎么排」算成纯数据（planPetRow）——渲染层只管贴 markup，
 * 排布规则才有回归保护。
 */
import { badgesOf, isEventState } from './threads'
import type { Session, ThreadState } from './types'

export const PET_STATES = ['idle', 'thinking', 'working', 'blocked', 'done', 'failed'] as const
export type PetState = (typeof PET_STATES)[number]

/** 状态显示名，悬停提示用 */
export const PET_LABEL: Record<PetState, string> = {
  idle: '静止',
  thinking: '思考',
  working: '干活',
  blocked: '等你',
  done: '跑完待看',
  failed: '失败',
}

/**
 * 急缓：卡住 > 失败 > 跑完没看 > 干活 > 思考 > 静止。
 * 只有前三档值得人动——后三档自己会走完，不需要管。
 */
export const PET_RANK: Record<PetState, number> = {
  blocked: 0,
  failed: 1,
  done: 2,
  working: 3,
  thinking: 4,
  idle: 5,
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
export function focusIndex(states: PetState[]): number {
  if (states.length === 0) return -1
  let best = 0
  states.forEach((s, i) => {
    if (PET_RANK[s] < PET_RANK[states[best]]) best = i
  })
  return PET_RANK[states[best]] <= PET_ATTENTION ? best : -1
}

/**
 * 会话实时状态 → pet 状态。
 *
 * TODO(hook): 细粒度管道（claude-hook / codex-hook）接上后，「正在跑」要拆成 thinking / working，
 * 别再把它们合成 working 这一档；届时它的状态字面量就直接是 pet 的六档，这层适配可以撤。
 *
 * 在那之前只有粗粒度四档，先按最贴近的姿势落：running 落 working（设计稿的「正在跑」变体
 * 画的就是 working），其余同名。unknown 读不到，不给 pet——与角标口径一致。
 */
export function petStateOf(state: ThreadState): PetState | null {
  switch (state) {
    case 'running':
      return 'working'
    case 'done':
      return 'done'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}

/** 一张卡最多挂几只 pet：卡片内容宽约 310px，再多就挤了，多的收成 +N */
export const MAX_PETS = 4

export interface PetItem {
  session: Session
  state: PetState
  /** 未读事件：给事件边框与一次性动效。读过就没了——pet 本身留着 */
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
 * 两层拆开：pet 是**回到会话的入口**，只要读得到状态（unknown 之外）就长期留着；
 * 事件样式（边框 + 动效）与抢注意力才跟 `fresh` 走，读过就消失。
 */
export function planPetRow(sessions: Session[]): PetRowPlan {
  const pets = sessions
    .map((session) => ({ session, state: petStateOf(session.status.state) }))
    .filter((p): p is { session: Session; state: PetState } => p.state !== null)

  // 抢动效仍按 badgesOf 挑（未读事件 + 正在跑），再映射回整排的坐标——
  // 消费掉的 pet 留着，但不抢注意力。badgesOf 已按急缓排序，focusIndex 只认 attention 三档。
  const attentive = badgesOf(sessions)
  const focusAt = focusIndex(
    attentive.map((s) => petStateOf(s.status.state)).filter((s): s is PetState => s !== null),
  )
  const focusSession = focusAt >= 0 ? attentive[focusAt] : undefined

  const shown = pets.slice(0, MAX_PETS)
  return {
    items: shown.map((p) => ({
      session: p.session,
      state: p.state,
      event: isEventState(p.session.status.state) && p.session.status.fresh,
      focus: p.session === focusSession,
    })),
    more: pets.length - shown.length,
  }
}
