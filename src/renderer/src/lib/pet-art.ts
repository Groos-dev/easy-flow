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
 * - 程小帮 → cxb 蓝卫衣短发女孩，走 `<img>`。每档是用 gpt-image-2.5 生成的三帧动作表切出的
 *   循环动画 WebP（另出一份首帧静态版给减动效用），构建见 scripts/build-cxb-pet.py。
 * - Cursor → cursor 立方体小机器人（方块 logo + 指针箭头），走 `<img>`。同样是生图动作表切出的
 *   循环动画 WebP + 静态版，构建见 scripts/build-cursor-pet.py。
 *
 * 素材来源与许可见 src/renderer/public/pets/README.md；clawd / cloudling 的构建见
 * scripts/build-pets.mjs。
 */
import { CLOUDLING_SVG } from './pet-cloudling-art'
import type { Pose } from './pets'

const CLAWD_FILE: Record<Pose, string> = {
  idle: 'clawd-idle-follow.svg',
  thinking: 'clawd-working-thinking.svg',
  working: 'clawd-working-typing.svg',
  sweeping: 'clawd-working-sweeping.svg',
  blocked: 'clawd-notification.svg',
  done: 'clawd-happy.svg',
  failed: 'clawd-error.svg',
}

const CLAWD_MINI_FILE: Record<Pose, string> = {
  idle: 'clawd-mini-idle.svg',
  thinking: 'clawd-mini-peek.svg',
  working: 'clawd-mini-typing.svg',
  sweeping: 'clawd-mini-typing.svg',
  blocked: 'clawd-mini-alert.svg',
  done: 'clawd-mini-happy.svg',
  failed: 'clawd-mini-alert.svg',
}

const CLOUDLING_FILE: Record<Pose, string> = {
  idle: 'cloudling-idle.svg',
  thinking: 'cloudling-thinking.svg',
  working: 'cloudling-typing.svg',
  sweeping: 'cloudling-sweeping.svg',
  blocked: 'cloudling-notification.svg',
  done: 'cloudling-attention.svg',
  failed: 'cloudling-error.svg',
}

const CLOUDLING_MINI_FILE: Record<Pose, string> = {
  idle: 'cloudling-mini-idle.svg',
  thinking: 'cloudling-mini-peek.svg',
  working: 'cloudling-mini-typing.svg',
  sweeping: 'cloudling-mini-typing.svg',
  blocked: 'cloudling-mini-alert.svg',
  done: 'cloudling-mini-happy.svg',
  failed: 'cloudling-mini-alert.svg',
}

const CXB_FILE: Record<Pose, string> = {
  idle: 'cxb-idle.webp',
  thinking: 'cxb-thinking.webp',
  working: 'cxb-working.webp',
  sweeping: 'cxb-sweeping.webp',
  blocked: 'cxb-blocked.webp',
  done: 'cxb-done.webp',
  failed: 'cxb-failed.webp',
}

const CXB_MINI_FILE: Record<Pose, string> = {
  idle: 'cxb-mini-idle.webp',
  thinking: 'cxb-mini-peek.webp',
  working: 'cxb-mini-typing.webp',
  sweeping: 'cxb-mini-typing.webp',
  blocked: 'cxb-mini-alert.webp',
  done: 'cxb-mini-happy.webp',
  failed: 'cxb-mini-alert.webp',
}

const CURSOR_FILE: Record<Pose, string> = {
  idle: 'cursor-idle.webp',
  thinking: 'cursor-thinking.webp',
  working: 'cursor-working.webp',
  sweeping: 'cursor-sweeping.webp',
  blocked: 'cursor-blocked.webp',
  done: 'cursor-done.webp',
  failed: 'cursor-failed.webp',
}

const CURSOR_MINI_FILE: Record<Pose, string> = {
  idle: 'cursor-mini-idle.webp',
  thinking: 'cursor-mini-peek.webp',
  working: 'cursor-mini-typing.webp',
  sweeping: 'cursor-mini-typing.webp',
  blocked: 'cursor-mini-alert.webp',
  done: 'cursor-mini-happy.webp',
  failed: 'cursor-mini-alert.webp',
}

// 静止越久越困：打哈欠 → 打盹 → 瘫倒 → 睡着
export type IdleMood = 'awake' | 'yawning' | 'dozing' | 'collapsing' | 'sleeping'

const CLAWD_IDLE: Record<IdleMood, string> = {
  awake: 'clawd-idle-follow.svg',
  yawning: 'clawd-idle-yawn.svg',
  dozing: 'clawd-idle-doze.svg',
  collapsing: 'clawd-collapse-sleep.svg',
  sleeping: 'clawd-sleeping.svg',
}

const CLOUDLING_IDLE: Record<IdleMood, string> = {
  awake: 'cloudling-idle.svg',
  yawning: 'cloudling-idle-to-dozing.svg',
  dozing: 'cloudling-dozing.svg',
  collapsing: 'cloudling-dozing-to-sleeping.svg',
  sleeping: 'cloudling-sleeping.svg',
}

const CXB_IDLE: Record<IdleMood, string> = {
  awake: 'cxb-idle.webp',
  yawning: 'cxb-idle-yawn.webp',
  dozing: 'cxb-idle-doze.webp',
  collapsing: 'cxb-collapse-sleep.webp',
  sleeping: 'cxb-sleeping.webp',
}

const CURSOR_IDLE: Record<IdleMood, string> = {
  awake: 'cursor-idle.webp',
  yawning: 'cursor-idle-yawn.webp',
  dozing: 'cursor-idle-doze.webp',
  collapsing: 'cursor-collapse-sleep.webp',
  sleeping: 'cursor-sleeping.webp',
}

const COLLAPSE_MS = 5_000

const IDLE_STAGES: ReadonlyArray<{ after: number; mood: IdleMood }> = [
  { after: 50 * 60_000 + COLLAPSE_MS, mood: 'sleeping' },
  { after: 50 * 60_000, mood: 'collapsing' },
  { after: 10 * 60_000, mood: 'dozing' },
  { after: 20_000, mood: 'yawning' },
]

export function idleMoodOf(observedAt: number, now = Date.now()): IdleMood {
  if (!observedAt) return 'awake'
  const idleMs = now - observedAt
  return IDLE_STAGES.find((stage) => idleMs >= stage.after)?.mood ?? 'awake'
}

// 一块素材怎么落到页面上
export type PetArt = { channel: 'img'; src: string } | { channel: 'inline'; svg: string }

interface Theme {
  files: Record<Pose, string>
  minis: Record<Pose, string>
  idle: Record<IdleMood, string>
  miniSleep: string
  inline: boolean
  // 从睡着里被叫醒时先播的一档；没有就不播（素材没有这一档的 agent 直接切目标姿势）
  wake?: string
}

const CLAWD: Theme = {
  files: CLAWD_FILE,
  minis: CLAWD_MINI_FILE,
  idle: CLAWD_IDLE,
  miniSleep: 'clawd-mini-sleep.svg',
  inline: false,
}

const CLOUDLING: Theme = {
  files: CLOUDLING_FILE,
  minis: CLOUDLING_MINI_FILE,
  idle: CLOUDLING_IDLE,
  miniSleep: 'cloudling-mini-sleep.svg',
  inline: true,
}

const CXB: Theme = {
  files: CXB_FILE,
  minis: CXB_MINI_FILE,
  idle: CXB_IDLE,
  miniSleep: 'cxb-mini-sleep.webp',
  inline: false,
  wake: 'cxb-wake.webp',
}

const CURSOR: Theme = {
  files: CURSOR_FILE,
  minis: CURSOR_MINI_FILE,
  idle: CURSOR_IDLE,
  miniSleep: 'cursor-mini-sleep.webp',
  inline: false,
}

// 认不出的 agent 落到 clawd（默认那只）；四个认识的 agent 各自一套形象
function themeFor(agent: string): Theme {
  if (agent === 'codex') return CLOUDLING
  if (agent === 'chengxiaobang') return CXB
  if (agent === 'cursor') return CURSOR
  return CLAWD
}

function fileFor(theme: Theme, state: Pose, mood: IdleMood, compact: boolean): string {
  if (state !== 'idle') return (compact ? theme.minis : theme.files)[state]
  if (!compact) return theme.idle[mood]
  return mood === 'sleeping' ? theme.miniSleep : theme.minis.idle
}

/**
 * 从「睡着 / 瘫倒」的静止里被叫醒：下一次状态变化先播一档「醒来」。
 *
 * 判据只看上一帧，不需要新信号：上一帧还是静止、且已经困到瘫倒或睡着，这一帧不再是静止，
 * 就说明它被叫醒了。素材里没有 wake 这一档的 agent 不播（云宝与 clawd 的上游主题里醒来是
 * 睡眠序列的一部分，没有独立素材），直接切目标姿势。
 */
export function isWaking(
  agent: string,
  prev: { state: Pose; mood: IdleMood },
  nextState: Pose,
): boolean {
  return (
    !!themeFor(agent).wake &&
    prev.state === 'idle' &&
    (prev.mood === 'sleeping' || prev.mood === 'collapsing') &&
    nextState !== 'idle'
  )
}

/**
 * 相对路径，不带前导斜杠：dev 下按 vite 根解析，打包后按 index.html 同级目录解析，两边都能取到。
 * `still` 换静态素材：clawd 自带动画封在 SVG 文档里，换 `*.still.svg`；cxb / cursor 是动画 WebP，
 * 换首帧的 `*-still.webp`。折叠卡的小号素材本来就是静态的，不参与替换。
 * `wake` 只对带这一档素材的主题生效，且折叠卡不放——小号素材没有醒来这一张。
 */
export function petArt(
  agent: string,
  state: Pose,
  { compact, still, mood = 'awake', wake = false }: { compact: boolean; still: boolean; mood?: IdleMood; wake?: boolean },
): PetArt {
  const theme = themeFor(agent)
  const file = wake && !compact && theme.wake ? theme.wake : fileFor(theme, state, mood, compact)
  if (theme.inline) return { channel: 'inline', svg: CLOUDLING_SVG[file] }
  // 小号素材里只有 clawd 的 SVG 另出了 still 版；位图 mini 本来就是静态首帧
  const swap = still && (!compact || file.endsWith('.svg'))
  const src = swap ? file.replace(/\.svg$/, '.still.svg').replace(/\.webp$/, '-still.webp') : file
  return { channel: 'img', src: `pets/${src}` }
}

const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/
const STYLE_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/
// 脚本里按文档找元素的三处调用；`getElementById` 的参数是 id，另两个是选择器
const LOOKUP_RE = /\.(getElementById|querySelector|querySelectorAll)\(\s*(['"])([^'"]*)\2/g
// 属性值里指向本文件元素的引用
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
