/**
 * 应用外观。选择存在配置里，渲染层按解析后的结果挂 <html data-theme>。
 *
 * 跟随系统时不记具体值：系统外观一变，渲染层按当前色系重挂一次。
 */
export const THEMES = ['system', 'light', 'dark'] as const

export type Theme = (typeof THEMES)[number]

export const THEME_LABELS: Record<Theme, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

// 实际生效的外观：跟随系统时看系统当前是深色还是浅色
export function resolveTheme(theme: Theme, systemPrefersLight: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersLight ? 'light' : 'dark'
  return theme
}
