import { useEffect, useSyncExternalStore } from 'react'
import { getLanguage, setLanguage, subscribeLanguage, type Language } from '../../../shared/i18n.ts'
import { api } from './api'

// Subscribe in display components so memoized cards also update when language changes.
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
}

// One synchronization subscription per window; never reload or discard document drafts.
export function useLanguageSync(): Language {
  const language = useLanguage()
  useEffect(() => {
    let alive = true
    const refresh = () => { void api.language().then(({ language }) => { if (alive) setLanguage(language) }).catch(() => {}) }
    refresh()
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('easy-flow-language')
    if (channel) channel.onmessage = refresh
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { alive = false; channel?.close(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en' }, [language])
  return language
}

export async function changeLanguage(language: Language): Promise<void> {
  const result = await api.setLanguage(language)
  setLanguage(result.language)
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('easy-flow-language')
    channel.postMessage(result.language)
    channel.close()
  }
}
