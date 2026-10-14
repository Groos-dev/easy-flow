/**
 * pet 素材与染色：clawd 像素形象（素材在 src/renderer/public/pets，来源与许可见该目录 README）。
 *
 * 与 pets.ts 的分工：那边是状态词汇与排布规则，这边只管「一档状态画哪张图、哪个 agent 染成什么色」。
 * 六档状态各一张大图 + 一张 mini，折叠卡用 mini。
 */
import type { PetState } from './pets'

/** 六档 → clawd 默认主题里的状态文件 */
const PET_FILE: Record<PetState, string> = {
  idle: 'clawd-idle-follow.svg',
  thinking: 'clawd-working-thinking.svg',
  working: 'clawd-working-typing.svg',
  blocked: 'clawd-notification.svg',
  done: 'clawd-happy.svg',
  failed: 'clawd-error.svg',
}

/**
 * 折叠卡的小号：clawd 的 mini 组只有五张，没有失败版，failed 复用 alert——
 * 靠 .pet.s-failed 整体暗一档 + 未读时的一次性抖动区分。
 */
const PET_MINI_FILE: Record<PetState, string> = {
  idle: 'clawd-mini-idle.svg',
  thinking: 'clawd-mini-peek.svg',
  working: 'clawd-mini-typing.svg',
  blocked: 'clawd-mini-alert.svg',
  done: 'clawd-mini-happy.svg',
  failed: 'clawd-mini-alert.svg',
}

/**
 * 相对路径，不带前导斜杠：dev 下按 vite 根解析，打包后按 index.html 同级目录解析，
 * 两边都能取到公共目录里的素材。
 */
export function petImageSrc(state: PetState, { compact, still }: { compact: boolean; still: boolean }): string {
  const file = (compact ? PET_MINI_FILE : PET_FILE)[state]
  return `pets/${still ? file.replace(/\.svg$/, '.still.svg') : file}`
}

/**
 * 身体色归 agent：clawd 的 fill 是硬编码的，没有 currentColor 可继承，只能整张过 CSS filter
 * （和 clawd 自己一个路子，见其 pet-customization-catalog.js 的色调表）。
 * claude 不染——橙红本来就是这只螃蟹的原色。
 */
const AGENT_FILTER: Record<string, string> = {
  claude: '',
  codex: 'hue-rotate(155deg) saturate(0.9) brightness(1.02)',
  cursor: 'grayscale(1) brightness(1.1)',
}

/** 认不出的 agent 走中性灰，别借用某个具体 agent 的颜色 */
const UNKNOWN_FILTER = 'grayscale(1) brightness(1.1)'

export function agentFilter(agent: string): string {
  return AGENT_FILTER[agent] ?? UNKNOWN_FILTER
}
