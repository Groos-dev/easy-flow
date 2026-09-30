/**
 * 探测系统已安装的等宽字体。
 *
 * 原理：用 canvas 测量同一段文字在不同 font-family 下的宽度。
 * 若指定字体存在，宽度会与回退字体不同；否则浏览器静默回退，宽度与基准一致。
 * 这是浏览器环境里检测字体的通用做法，不需要后端读取字体目录。
 */
const CANDIDATES = [
  // 带 Nerd 字形的（终端提示符需要）
  'JetBrainsMono Nerd Font Mono',
  'JetBrainsMono Nerd Font',
  'JetBrainsMonoNL Nerd Font Mono',
  'MesloLGS NF',
  'MesloLGM Nerd Font Mono',
  'Hack Nerd Font Mono',
  'FiraCode Nerd Font Mono',
  'CaskaydiaCove Nerd Font Mono',
  'SauceCodePro Nerd Font Mono',
  'VictorMono Nerd Font Mono',
  'Inconsolata Nerd Font Mono',
  // 普通等宽
  'SF Mono',
  'Menlo',
  'Monaco',
  'JetBrains Mono',
  'Fira Code',
  'Hack',
  'Cascadia Code',
  'Cascadia Mono',
  'Source Code Pro',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'Andale Mono',
  'Courier New',
]

const BASELINE = 'monospace'
const PROBE = 'mmmmmmmmmmlliWWWWWWWWWW0123456789'

let cached: string[] | null = null

function measure(family: string, size = 72): number {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = `${size}px ${family}`
  return ctx.measureText(PROBE).width
}

export function detectMonospaceFonts(): string[] {
  if (cached) return cached
  if (typeof document === 'undefined') return []

  const base = measure(BASELINE)
  const found = CANDIDATES.filter((family) => {
    // 用两种基准宽度对比，降低误判（某些字体在 monospace 基准下宽度恰好相同）
    const quoted = `"${family}"`
    const w1 = measure(`${quoted}, monospace`)
    const w2 = measure(`${quoted}, serif`)
    return w1 !== base || w2 !== measure('serif')
  })

  cached = found
  return found
}

