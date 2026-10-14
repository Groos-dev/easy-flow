#!/usr/bin/env node
/**
 * 把 .pet-src 里的 clawd 素材生成到 src/renderer/public/pets/：
 * - 重设 viewBox：原始 `-15 -25 45 45` 留白太大，44px 里螃蟹只有十几个像素。
 *   这里按各文件的内容包围盒收紧成方形，取景口径一致（只改取景框，不动图形坐标，
 *   SVG 自带动画的 transform-origin 仍按原坐标系生效）
 * - 再出一份 *.still.svg：往自带 <style> 里注入 `* { animation: none !important }`，
 *   给 prefers-reduced-motion 兜底（外部 CSS 够不进 <img> 里的 SVG 文档）
 *
 * BBOX 是各文件内容包围盒（含 CSS 隐藏层），用 headless Chrome 的 getBBox 量出；
 * top 是给动画外扩额外留的顶部空间——只有 clawd-error 的烟雾会飘到包围盒上方。
 *
 * 只本地自用、不推远端，版权见 .pet-src/LICENSE.clawd。
 * 生成物落在公共目录，构建后到 out/renderer/pets/，Electron 用相对路径能取到。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, '.pet-src')
const OUT = join(ROOT, 'src/renderer/public/pets')

// 六档常驻状态用大图，折叠卡用 mini——多出来的状态（yawn / sleep / …）不落地
// 公共取景框：六档共用同一尺寸，状态切换时角色不跳大小；
// 内容超出时才按需放宽（happy 的彩带、error 的烟雾）
const ART = [
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
]

const PAD = 2
const FRAME = { full: 28, mini: 22 }
const HEADER = `<!--
  来源：clawd-on-desk（https://github.com/rullerzhou-afk/clawd-on-desk）assets/svg/，默认主题 themes/clawd。
  许可：All Rights Reserved；Clawd 角色版权归 Anthropic，本目录插画仅授权用于 Clawd on Desk 应用本身。
  本仓库属本地自用，勿 push 到远端。完整许可见 .pet-src/LICENSE.clawd，由 scripts/build-pets.mjs 生成。
-->
`

const STILL_RULE = `
      /* still：停掉自带动画，其余声明原样保留（prefers-reduced-motion 用） */
      * { animation: none !important; }
`

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
  console.error(`缺少素材目录 ${SRC}，无法生成 pet 素材`)
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

for (const { name, bbox, top } of ART) {
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
  svg = HEADER + svg.replace(/viewBox="[^"]*"/, `viewBox="${frameViewBox(bbox, top, min)}"`)
  writeFileSync(join(OUT, name), svg)
  writeFileSync(join(OUT, name.replace(/\.svg$/, '.still.svg')), svg.replace('</style>', `${STILL_RULE}    </style>`))
}

console.log(`生成 ${ART.length} 份素材（含静态版）到 ${OUT}`)
