/**
 * 卡上 pet 的状态词汇与挑选规则（纯函数，不碰数据源——值全靠 props 进）。
 *
 * 六档姿势来自设计稿（design/card-draft.html）：静止 / 思考 / 干活 / 等你 / 跑完待看 / 失败。
 * 两轴分开：身体色归 agent（AGENT_TINT），姿势 + 光环归状态，所以换个 agent 也认得出在干什么。
 */
import type { ThreadState } from './types'

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

/** 身体色 = 哪个 agent：Claude 暖棕、Codex 青绿；认不出的走灰 */
export const AGENT_TINT: Record<string, string> = {
  claude: '#c98a5e',
  codex: '#5fb8a0',
  cursor: '#8b93a1',
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

/** 分界线：rank 小于等于它的才配动效 */
export const PET_ATTENTION = 2

/**
 * 一群 pet 里挑出唯一该动的那只——最急的那只动，其余安静；三个一起跳，看板就成水族馆了。
 * 没有需要人注意的（全在干活 / 思考 / 静止）返回 -1，谁都不动。并列取靠前的。
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
 * 会话实时状态 → pet 状态。细粒度管道（thinking / idle）还没接上，现在只有粗粒度四档，
 * 先按最贴近的姿势落：running 落 working（设计稿的「正在跑」变体画的就是 working），其余同名。
 * unknown 读不到，不给 pet——与角标口径一致，读不到的东西不该出现在卡上。
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
