#!/usr/bin/env node
/**
 * 从 .pet-src/ 生成看板 pet 素材到 src/renderer/public/pets/。两套形象、两条通道：
 *
 * - clawd（Claude）：clawd-on-desk 默认主题，走 <img>。每张自带 <style> 与 @keyframes，
 *   内联到一张卡里会互相覆盖，用 <img> 让每个 SVG 文档独立、CSS 天然隔离。这里做两件事：
 *   1) 重设 viewBox：原始 `-15 -25 45 45` 留白太大，44px 里螃蟹只有十几个像素；按内容
 *      包围盒收紧成方形（只改取景框、不动图形坐标，SVG 自带 transform-origin 仍按原坐标系生效）。
 *   2) 另出 *.still.svg：往自带 <style> 里注入 `* { animation: none !important }` 停掉动画，
 *      再把「基础 opacity: 0、只靠 keyframes 显形」的装饰按文件置为可见——冻结后它们会永久消失。
 *
 * - cloudling（Codex）：clawd-on-desk 的 cloudling 主题，**内联进宿主 DOM**，构建期落成一个 TS 模块。
 *   27/28 个文件是脚本驱动（约 5.8KB 的 requestAnimationFrame + setAttribute），<img> 会禁脚本 →
 *   一朵静止的云；而走 <object> 的话，object 文档的画布在 Chromium 里恒为不透明（background:
 *   transparent 实测无效），暗色卡片上就是一块白方块。内联的 SVG 是普通元素，背景天然透明、
 *   跟着主题走，所以这里只重设 viewBox，把结果写进 src/renderer/src/lib/pet-cloudling-art.ts。
 *   同文档里 id 会撞，实例级改写见 pet-art.ts 的 scopeCloudling。
 *
 * BBOX 用 headless Chrome 的 getBBox 量出（clawd 含 CSS 隐藏层；cloudling 去掉透明底 rect）。
 * top 是给动画外扩额外留的顶部空间——只有 clawd-error 的烟雾会飘到包围盒上方。
 *
 * 依赖 .pet-src/ 里的原始素材，而该目录被 .gitignore 忽略（素材 All Rights Reserved，只本地自用）：
 * 干净 clone 里跑不了本脚本，仅本机可重跑。版权见 .pet-src/LICENSE.clawd 与 public/pets/README.md。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, '.pet-src')
const OUT = join(ROOT, 'src/renderer/public/pets')
const CLOUDLING_MODULE = join(ROOT, 'src/renderer/src/lib/pet-cloudling-art.ts')

const CLAWD_HEADER = `<!--
  来源：clawd-on-desk（https://github.com/rullerzhou-afk/clawd-on-desk）assets/svg/，默认主题 themes/clawd。
  许可：All Rights Reserved；Clawd 角色版权归 Anthropic，本目录插画仅授权用于 Clawd on Desk 应用本身。
  本仓库属本地自用，勿 push 到远端。完整许可见 .pet-src/LICENSE.clawd，由 scripts/build-pets.mjs 生成。
-->
`

const CLOUDLING_MODULE_HEADER = `/**
 * 生成文件，勿手改——由 scripts/build-pets.mjs 从 .pet-src/cloudling 生成。
 *
 * 来源：clawd-on-desk（https://github.com/rullerzhou-afk/clawd-on-desk）themes/cloudling（作者 stlabslogo）。
 * 许可：All Rights Reserved，仅授权用于 Clawd on Desk 应用本身。本仓库属本地自用，勿 push 到远端。
 * 完整许可见 .pet-src/LICENSE.clawd。
 *
 * 键是素材文件名，值是处理过 viewBox 的整份 SVG 原文（含驱动动画的 <script>）。
 * 内联渲染、实例级 id 改写见 src/renderer/src/lib/pet-art.ts。
 */
`

// ---------------------------------------------------------------------------
// clawd（<img>）
// ---------------------------------------------------------------------------

// 常驻状态用大图，折叠卡用 mini。公共取景框：各档共用同一尺寸，状态切换时角色不跳大小；
// 内容超出时才按需放宽（happy 的彩带、error 的烟雾）。
//
// 后 25 个是 16 档对齐时补的（theme.json 的 states / displayHintMap / idleAnimations / reactions /
// miniMode 引用到的全部文件）。bbox 用 headless Chrome 的 getBBox 量出，与先前那 11 个同一套方法。
// 没有 top：动画外扩的那几个先按静态框走——统一尺寸比不裁掉一颗星星重要，等真接上再逐个看。
const CLAWD_ART = [
  { name: 'clawd-idle-follow.svg', bbox: [0, 6, 15, 10] },
  { name: 'clawd-working-thinking.svg', bbox: [-2.12, -6.34, 20.24, 22.34] },
  { name: 'clawd-working-typing.svg', bbox: [-0.5, -6, 16, 22] },
  { name: 'clawd-notification.svg', bbox: [-3.27, -3.17, 18.28, 19.18] },
  { name: 'clawd-happy.svg', bbox: [-7.5, -9.5, 29, 25.5] },
  // 烟雾动画会飘到 y≈-19，顶部多留 8 个单位的取景空间
  { name: 'clawd-error.svg', bbox: [-3, -2, 19, 18], top: 8 },
  { name: 'clawd-mini-idle.svg', bbox: [-3.17, 4.64, 18.01, 12.23] },
  { name: 'clawd-mini-peek.svg', bbox: [-3.17, 4.64, 18.01, 12.23] },
  { name: 'clawd-mini-typing.svg', bbox: [-2, 4.61, 20.5, 12.95] },
  { name: 'clawd-mini-alert.svg', bbox: [-4, 2.5, 18.84, 14.37] },
  { name: 'clawd-mini-happy.svg', bbox: [-7.5, -6.5, 22.34, 23.67] },
  { name: 'clawd-collapse-sleep.svg', bbox: [-0.61, 0, 16.22, 16] },
  { name: 'clawd-designing.svg', bbox: [-7, 2, 28, 14] },
  { name: 'clawd-dizzy.svg', bbox: [0, -0.25, 15, 16.25] },
  { name: 'clawd-headphones-groove.svg', bbox: [-5, 2.85, 23, 13.15] },
  { name: 'clawd-heart-eyes.svg', bbox: [0, 6, 15, 10] },
  { name: 'clawd-idle-bubble.svg', bbox: [0, -1.2, 22, 17.2] },
  { name: 'clawd-idle-doze.svg', bbox: [-0.61, 7.3, 16.22, 8.7] },
  { name: 'clawd-idle-look.svg', bbox: [0, 6, 15, 10] },
  { name: 'clawd-idle-reading.svg', bbox: [0, -7.08, 15, 23.08] },
  { name: 'clawd-idle-yawn.svg', bbox: [0, 6, 15, 10] },
  { name: 'clawd-mini-crabwalk.svg', bbox: [-2, 6.74, 15.3, 9.52] },
  { name: 'clawd-mini-sleep.svg', bbox: [-3.17, 0, 18.01, 16.87] },
  { name: 'clawd-react-annoyed.svg', bbox: [0, 0.5, 16.6, 15.5] },
  { name: 'clawd-react-double-jump.svg', bbox: [0, 6, 15, 10] },
  { name: 'clawd-react-double.svg', bbox: [0, 6, 18.25, 12.75] },
  { name: 'clawd-react-drag.svg', bbox: [-1.11, 5.65, 15.69, 10.2] },
  { name: 'clawd-react-left.svg', bbox: [0, 6, 15, 14.75] },
  { name: 'clawd-react-right.svg', bbox: [0, 6, 19.25, 14.75] },
  { name: 'clawd-sleeping.svg', bbox: [-1, 0, 17, 16] },
  { name: 'clawd-wake.svg', bbox: [-1, 9, 17, 7] },
  { name: 'clawd-working-building.svg', bbox: [0, 1, 23, 15] },
  { name: 'clawd-working-carrying.svg', bbox: [-1.76, 4.17, 18.83, 12.14] },
  { name: 'clawd-working-debugger.svg', bbox: [0, 4.5, 15, 11.5] },
  { name: 'clawd-working-juggling.svg', bbox: [-0.28, -1.73, 15.56, 17.73] },
  { name: 'clawd-working-sweeping.svg', bbox: [-3, 5, 18.5, 11] },
]

// still 版额外规则：把「基础 opacity: 0、只靠动画显形」的装饰置为可见（连同动画冻结后应有的静置 transform）。
// 逐个文件过一遍：没有动画显形装饰的（idle / peek / mini-idle）不加；error 的烟雾基础位置在头顶之外、
// 硬置可见会悬空，本轮选择「无烟雾」的那一帧，也不加。
const CLAWD_STILL = {
  // 星星：flash-center / flash-outer 只改 opacity，置 1 即可
  'clawd-happy.svg': '.spark-center, .spark-outer { opacity: 1 !important; }',
  'clawd-mini-happy.svg': '.spark-center, .spark-outer { opacity: 1 !important; }',
  // 思考气泡 + 圆点：bubble 的生命只改 opacity/transform，置 1 后停在气泡本来的位置
  'clawd-working-thinking.svg': '.left-bubble, .right-bubble, .dot { opacity: 1 !important; }',
  // 灯泡 + 光晕：bulb-fly / rays-burst 把元素整体缩到 hold 帧，静置要连 transform 一起补
  'clawd-notification.svg': [
    '.bulb { opacity: 1 !important; transform: translate(9.5px, -2.7px) scale(0.24) !important; }',
    '.rays { opacity: 0.9 !important; transform: translate(-0.1px, -0.1px) scale(0.9) !important; }',
  ].join('\n      '),
  // 惊叹号：alert-flash 只改 opacity/transform，本来的位置在角色左侧，置 1 即可
  'clawd-mini-alert.svg': '.alert-pop { opacity: 1 !important; }',
}

const PAD = 2
const FRAME = { full: 28, mini: 22 }
const STILL_RULE = `
      /* still：停掉自带动画，其余声明原样保留（prefers-reduced-motion 用） */
      * { animation: none !important; }
`
// ---------------------------------------------------------------------------
// cloudling（内联 <svg>）
// ---------------------------------------------------------------------------

const CLOUDLING_ART = [
  'cloudling-idle.svg',
  'cloudling-thinking.svg',
  'cloudling-typing.svg',
  'cloudling-sweeping.svg',
  'cloudling-notification.svg',
  'cloudling-attention.svg',
  'cloudling-error.svg',
  'cloudling-idle-to-dozing.svg',
  'cloudling-dozing.svg',
  'cloudling-dozing-to-sleeping.svg',
  'cloudling-sleeping.svg',
  'cloudling-mini-idle.svg',
  'cloudling-mini-peek.svg',
  'cloudling-mini-typing.svg',
  'cloudling-mini-alert.svg',
  'cloudling-mini-happy.svg',
  'cloudling-mini-sleep.svg',
]
const CLOUDLING_SRC = join(SRC, 'cloudling')
// 原 viewBox `-32 -24 88 72` 里角色只占 22×19，缩到 44px 里几乎看不见；
// 取 theme.json 的 marginBox（中心 12,12、边长 28）当公共取景框，云宝刚好填满。
const CLOUDLING_VIEWBOX = '-2 -2 28 28'
const CLOUDLING_SIDE = 28

/**
 * 包围盒 + 留白 → 方形 viewBox 字符串。
 * side 取公共取景框和「内容 + 留白」的较大者：常规状态一律用公共框（角色大小一致），
 * 只有内容本身超出公共框的文件才放宽。
 */
function frameViewBox([x, y, w, h], top = 0, min = FRAME.full) {
  const y0 = y - top
  const hh = h + top
  const side = Math.max(min, w + PAD * 2, hh + PAD * 2)
  const cx = x + w / 2
  const cy = y0 + hh / 2
  const n = (v) => Number(v.toFixed(2))
  return `${n(cx - side / 2)} ${n(cy - side / 2)} ${n(side)} ${n(side)}`
}

if (!existsSync(SRC)) {
  console.error(`缺少素材目录 ${SRC}，无法生成 pet 素材（.pet-src/ 只本地自用，不在仓库里）`)
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

// ---- clawd ----
for (const { name, bbox, top } of CLAWD_ART) {
  const src = join(SRC, name)
  if (!existsSync(src)) {
    console.error(`缺少源文件 ${src}`)
    process.exit(1)
  }
  let svg = readFileSync(src, 'utf8')
  if (!svg.includes('viewBox="') || !svg.includes('</style>')) {
    console.error(`${name} 缺 viewBox 或 <style>，结构变了，人工确认再生成`)
    process.exit(1)
  }
  const min = name.includes('-mini-') ? FRAME.mini : FRAME.full
  svg = CLAWD_HEADER + svg.replace(/viewBox="[^"]*"/, `viewBox="${frameViewBox(bbox, top, min)}"`)
  writeFileSync(join(OUT, name), svg)
  // 这些装饰基础就 opacity: 0，只靠 keyframes 显形——冻结后会一直不显示，补回可见状态
  const reveal = CLAWD_STILL[name] ? `      /* still：靠动画显形的装饰，冻结后置为可见 */\n      ${CLAWD_STILL[name]}\n` : ''
  writeFileSync(join(OUT, name.replace(/\.svg$/, '.still.svg')), svg.replace('</style>', `${STILL_RULE}${reveal}    </style>`))
}

// ---- cloudling ----
// 不落地 SVG 文件：它只以「内联进宿主 DOM」的形态出现，所以直接写进 TS 模块

function stripXmlDecl(svg) {
  return svg.replace(/^\s*<\?xml[^>]*\?>\s*/, '')
}

function flattenIdPrefix(svg) {
  const prefix = svg.match(/const p = '([\w-]+)'/)?.[1]
  return prefix ? svg.replaceAll('${p}', prefix) : svg
}

const cloudlingArt = []
for (const name of CLOUDLING_ART) {
  const src = join(CLOUDLING_SRC, name)
  if (!existsSync(src)) {
    console.error(`缺少源文件 ${src}`)
    process.exit(1)
  }
  const raw = readFileSync(src, 'utf8')
  if (!raw.includes('viewBox="') || !raw.includes('<script')) {
    console.error(`${name} 缺 viewBox 或 <script>，结构变了，人工确认再生成`)
    process.exit(1)
  }
  // 重设根 <svg> 的取景框与尺寸；尺寸只是兜底，内联后由 CSS 定
  const body = flattenIdPrefix(stripXmlDecl(raw))
    .replace(/<svg\b[^>]*>/, (tag) =>
      tag
        .replace(/viewBox="[^"]*"/, `viewBox="${CLOUDLING_VIEWBOX}"`)
        .replace(/\swidth="[^"]*"/, ` width="${CLOUDLING_SIDE}"`)
        .replace(/\sheight="[^"]*"/, ` height="${CLOUDLING_SIDE}"`),
    )
  cloudlingArt.push(`  ${JSON.stringify(name)}: ${JSON.stringify(body)},`)
}
writeFileSync(
  CLOUDLING_MODULE,
  `${CLOUDLING_MODULE_HEADER}export const CLOUDLING_SVG: Record<string, string> = {\n${cloudlingArt.join('\n')}\n}\n`,
)

console.log(`生成 clawd ${CLAWD_ART.length} 份（含静态版）到 ${OUT}；cloudling ${CLOUDLING_ART.length} 份到 ${CLOUDLING_MODULE}`)
