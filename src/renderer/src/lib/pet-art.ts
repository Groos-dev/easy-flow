/**
 * 卡上 pet 的素材：一个 agent 一套开源像素形象。
 *
 * 与 pets.ts 的分工：那边是状态词汇与排布规则，这边只管「哪个 agent、哪一档状态画哪张图、走哪条通道」。
 *
 * - Claude → clawd 像素螃蟹，走 `<img>`。每张 SVG 自带 `<style>` 与 `@keyframes`，内联到一张卡里会撞名，
 *   用 `<img>` 让每个文档独立、CSS 天然隔离（clawd 自己也是这么渲的）。
 * - Codex → cloudling 云宝，**内联成 `<svg>`**。它是脚本驱动的（素材自带 requestAnimationFrame 画眼睛、
 *   驱动呼吸），`<img>` 会禁脚本、只剩一朵静止的云；而 `<object>` 的文档画布在 Chromium 里恒为不透明，
 *   暗色卡片上就是一块白方块。内联的 SVG 是普通元素，背景天然透明、跟着主题走。
 *
 * 素材来源与许可见 src/renderer/public/pets/README.md；构建见 scripts/build-pets.mjs。
 */
import { CLOUDLING_SVG } from './pet-cloudling-art'
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

/** 一块素材怎么落到页面上 */
export type PetArt = { channel: 'img'; src: string } | { channel: 'inline'; svg: string }

/** 认不出的 agent 落到 clawd（默认那只）；只有 codex 走 cloudling */
function artFor(agent: string): { files: Record<PetState, string>; minis: Record<PetState, string>; inline: boolean } {
  return agent === 'codex'
    ? { files: CLOUDLING_FILE, minis: CLOUDLING_MINI_FILE, inline: true }
    : { files: CLAWD_FILE, minis: CLAWD_MINI_FILE, inline: false }
}

/**
 * 相对路径，不带前导斜杠：dev 下按 vite 根解析，打包后按 index.html 同级目录解析，两边都能取到。
 * `still` 只对 `<img>` 那条通道有意义——clawd 的自带动画封在文档里，只能换 `*.still.svg` 那份。
 */
export function petArt(agent: string, state: PetState, { compact, still }: { compact: boolean; still: boolean }): PetArt {
  const { files, minis, inline } = artFor(agent)
  const file = (compact ? minis : files)[state]
  if (inline) return { channel: 'inline', svg: CLOUDLING_SVG[file] }
  return { channel: 'img', src: `pets/${still ? file.replace(/\.svg$/, '.still.svg') : file}` }
}

const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/
const STYLE_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/
/** 脚本里按文档找元素的三处调用；`getElementById` 的参数是 id，另两个是选择器 */
const LOOKUP_RE = /\.(getElementById|querySelector|querySelectorAll)\(\s*(['"])([^'"]*)\2/g
/** 属性值里指向本文件元素的引用 */
const REF_RE = /(url\(#|href="#)([\w-]+)/g

/**
 * 按实例改写素材里的 id，并拆成「静态标记」与「驱动脚本」两半。
 *
 * 内联后素材与宿主同文档，而素材里的 id 是按文档唯一的：同屏两只同档云宝会撞——`getElementById`
 * 摸到别人那只、`url(#…)` 解析到别人的 defs，且那只一卸载、这些引用就全断。所以每只实例给
 * 自己这棵树的 id 与全部引用加同一个后缀：标记里的 `id` / `url(#…)` / `href="#…"` / 选择器，
 * 脚本里的查找参数、选择器与运行时写回去的属性值（`setAttribute('fill', 'url(#eye-grad)')`）。
 *
 * 只改写素材里真有的 id：`<style>` 里的 `#5870E8` 是颜色不是选择器，靠 id 集合区分。
 * id 集合从整份素材里收（不只是静态标记）——thinking 那几个档的脚本会现拼一段带 id 的
 * 标记插进去，那些 id 同样得跟着实例走。
 */
export function scopeCloudling(svg: string, uid: string): { markup: string; script: string } {
  const found = svg.match(SCRIPT_RE)
  const script = (found ? found[1] : '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
  const markup = svg.replace(SCRIPT_RE, '')
  const ids = new Set([...svg.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]))
  const scoped = (id: string) => (ids.has(id) ? `${id}-${uid}` : id)
  const bumpIds = (text: string) => text.replace(/\bid="([\w-]+)"/g, (_, id: string) => `id="${id}-${uid}"`)
  const bumpRefs = (text: string) => text.replace(REF_RE, (_, prefix: string, id: string) => `${prefix}${scoped(id)}`)
  const bumpSelector = (selector: string) => selector.replace(/#([\w-]+)/g, (_, id: string) => `#${scoped(id)}`)
  return {
    markup: bumpRefs(bumpIds(markup)).replace(
      STYLE_RE,
      (_, open: string, css: string, close: string) =>
        open + css.replace(/#([\w-]+)/g, (__, id: string) => `#${scoped(id)}`) + close,
    ),
    script: bumpRefs(
      bumpIds(
        script.replace(LOOKUP_RE, (_, method: string, quote: string, arg: string) =>
          `.${method}(${quote}${method === 'getElementById' ? scoped(arg) : bumpSelector(arg)}${quote}`,
        ),
      ),
    ),
  }
}
