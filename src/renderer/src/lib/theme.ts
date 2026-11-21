import { ThemeMode } from '../../../shared/domain.ts'
import { useCallback, useEffect, useState } from 'react'
import { resolveTheme, type Theme } from '../../../shared/theme'
import { api } from './api'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

function systemPrefersLight(): boolean {
  return window.matchMedia(LIGHT_QUERY).matches
}

// 挂 data-theme，同时让主进程把原生外观跟上
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(theme, systemPrefersLight())
  window.easyFlow?.setNativeTheme?.(theme)
}

// 跟随系统时系统外观一变就得重挂：light ↔ dark
function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(LIGHT_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/**
 * 当前主题与重读入口：主窗口与 mini 面板各挂一份。
 * 主题来自服务端配置。
 */
export function useTheme(): {
  theme: Theme
  setTheme: (theme: Theme) => void
  reloadTheme: () => void
} {
  const [theme, setTheme] = useState<Theme>(ThemeMode.System)

  const reloadTheme = useCallback(async () => {
    try {
      setTheme((await api.theme()).theme)
    } catch {
      /* 读不到就按跟随系统走，主题不该拦住界面 */
    }
  }, [])

  useEffect(() => {
    void reloadTheme()
  }, [reloadTheme])

  useEffect(() => {
    applyTheme(theme)
    return watchSystemTheme(() => applyTheme(theme))
  }, [theme])

  return { theme, setTheme, reloadTheme }
}
