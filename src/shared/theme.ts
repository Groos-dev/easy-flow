import { ThemeMode } from './domain.ts'
import { t as tr } from "./i18n.ts"
/**
 * 应用外观。选择存在配置里，渲染层按解析后的结果挂 <html data-theme>。
 *
 * 跟随系统时不记具体值：系统外观一变，渲染层按当前色系重挂一次。
 */
export const THEMES = Object.values(ThemeMode)

export type Theme = ThemeMode

export const THEME_LABELS: Record<Theme, string> = {
  get system() { return tr("System") },
  get light() { return tr("Light") },
  get dark() { return tr("Dark") },
}

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

// 实际生效的外观：跟随系统时看系统当前是深色还是浅色
export function resolveTheme(theme: Theme, systemPrefersLight: boolean): Exclude<Theme, typeof ThemeMode.System> {
  if (theme === ThemeMode.System) return systemPrefersLight ? ThemeMode.Light : ThemeMode.Dark
  return theme
}
