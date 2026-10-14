/**
 * 卡上 pet 的素材：一个 agent 一套开源像素形象。
 *
 * 与 pets.ts 的分工：那边是状态词汇与排布规则，这边只管「哪个 agent、哪一档状态画哪张图、走哪条通道」。
 *
 * - Claude → clawd 像素螃蟹，走 `<img>`。每张 SVG 自带 `<style>` 与 `@keyframes`，内联到一张卡里会撞名，
 *   用 `<img>` 让每个文档独立、CSS 天然隔离（clawd 自己也是这么渲的）。
 * - Codex → cloudling 云宝，走 `<object>`。27/28 个文件是脚本驱动（requestAnimationFrame + setAttribute），
 *   `<img>` 会禁脚本、只剩一朵静止的云。
 *
 * 素材来源与许可见 src/renderer/public/pets/README.md；构建见 scripts/build-pets.mjs。
 */
import type { PetState } from './pets'

/** 六档 → clawd 默认主题里的状态文件 */
const CLAWD_FILE: Record<PetState, string> = {
  idle: 'clawd-idle-follow.svg',
  thinking: 'clawd-working-thinking.svg',
  working: 'clawd-working-typing.svg',
  blocked: 'clawd-notification.svg',
  done: 'clawd-happy.svg',
  failed: 'clawd-error.svg',
}

/** 折叠卡的小号：clawd 的 mini 组只有五张、没有失败版，failed 复用 alert（靠 .pet.s-failed 整体暗一档区分） */
const CLAWD_MINI_FILE: Record<PetState, string> = {
  idle: 'clawd-mini-idle.svg',
  thinking: 'clawd-mini-peek.svg',
  working: 'clawd-mini-typing.svg',
  blocked: 'clawd-mini-alert.svg',
  done: 'clawd-mini-happy.svg',
  failed: 'clawd-mini-alert.svg',
}

/** 六档 → cloudling 主题里的状态文件 */
const CLOUDLING_FILE: Record<PetState, string> = {
  idle: 'cloudling-idle.svg',
  thinking: 'cloudling-thinking.svg',
  working: 'cloudling-typing.svg',
  blocked: 'cloudling-notification.svg',
  done: 'cloudling-attention.svg',
  failed: 'cloudling-error.svg',
}

/** 折叠卡的小号：cloudling 有 9 个 mini 状态，六档都落得上；failed 同样复用 alert */
const CLOUDLING_MINI_FILE: Record<PetState, string> = {
  idle: 'cloudling-mini-idle.svg',
  thinking: 'cloudling-mini-peek.svg',
  working: 'cloudling-mini-typing.svg',
  blocked: 'cloudling-mini-alert.svg',
  done: 'cloudling-mini-happy.svg',
  failed: 'cloudling-mini-alert.svg',
}

/** 一块素材画在哪条通道上 */
type PetChannel = 'img' | 'object'
export interface PetArt {
  src: string
  channel: PetChannel
}

/** 认不出的 agent 落到 clawd（默认那只）；只有 codex 走 cloudling */
function artFor(agent: string): { files: Record<PetState, string>; minis: Record<PetState, string>; channel: PetChannel } {
  return agent === 'codex'
    ? { files: CLOUDLING_FILE, minis: CLOUDLING_MINI_FILE, channel: 'object' }
    : { files: CLAWD_FILE, minis: CLAWD_MINI_FILE, channel: 'img' }
}

/**
 * 相对路径，不带前导斜杠：dev 下按 vite 根解析，打包后按 index.html 同级目录解析，两边都能取到。
 * `still` 换 `*.still.svg`（prefers-reduced-motion 的静态版）。
 */
export function petArt(agent: string, state: PetState, { compact, still }: { compact: boolean; still: boolean }): PetArt {
  const { files, minis, channel } = artFor(agent)
  const file = (compact ? minis : files)[state]
  return { src: `pets/${still ? file.replace(/\.svg$/, '.still.svg') : file}`, channel }
}
