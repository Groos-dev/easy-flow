/**
 * 项目图标的取值：显示名首字符 + 由 slug 定的稳定色相。
 * 纯函数——同一个项目每次渲染都得长一样，颜色不能随机。
 */

/** 首字符：跳过空格与标点；中文取第一个字，英文取首字母并大写 */
export function projectInitial(name: string): string {
  const s = name.replace(/[^\p{L}\p{N}]/gu, '')
  return (s.charAt(0) || '?').toUpperCase()
}

/** slug → 色相（0-359）。同一个 slug 永远同一个色，不同的尽量岔开 */
export function projectHue(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360
  return h
}

/** 图标底色：固定 42% 饱和度、38% 亮度，暗色主题下白字压得住 */
export function projectColor(slug: string): string {
  return `hsl(${projectHue(slug)}, 42%, 38%)`
}
