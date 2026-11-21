import { agentLabel, openTargetLabel } from '../lib/labels'
import { LogSeverity } from '../../../shared/domain.ts'
import { LANGUAGES, Language } from '../../../shared/i18n.ts'
import { useLanguage, changeLanguage } from '../lib/language'
import { t as tr } from "../../../shared/i18n.ts"
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  NOTIFICATION_MODES,
  NOTIFICATION_MODE_LABELS,
  type NotificationMode,
} from '../../../shared/notification-mode'
import { THEMES, THEME_LABELS, type Theme } from '../../../shared/theme'
import { LOG_LEVELS, type LogLevel } from '../../../shared/log-level'
import { api } from '../lib/api'
import {
  CONTEXT_LABEL,
  CONTEXT_ORDER,
  SHORTCUTS,
  isComposing,
  shortcut,
} from '../lib/keys'
import { acceleratorFromEvent, acceleratorKeys, formatAccelerator } from '../lib/shortcut'
import type { HookPlan, OpenWithPayload, OpenWithOption, SettingsPayload, SkillPayload, SyncResult } from '../lib/types'
import { AgentIcon, CheckIcon, ChevronIcon, KeyGlyph, PencilIcon, ResetIcon, TerminalIcon } from './icons'

interface Props {
  onBack: () => void
  // 应用后通知外层重新拉取数据
  onApplied: () => void
  // 外观归外层：换主题时整个界面一起重挂
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

type SectionId = 'appearance' | 'data' | 'open' | 'shortcut' | 'notify' | 'skill' | 'hook' | 'log'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'appearance', get label() { return tr("Appearance") } },
  { id: 'data', get label() { return tr("Data directory") } },
  { id: 'open', get label() { return tr("Open with") } },
  { id: 'shortcut', get label() { return tr("Keyboard shortcuts") } },
  { id: 'notify', get label() { return tr("Notifications") } },
  { id: 'skill', get label() { return tr("CLI and Skill") } },
  { id: 'hook', get label() { return tr("Hooks") } },
  { id: 'log', get label() { return tr("Logs") } },
]

function describeSync(sync: SyncResult | null): string {
  if (!sync) return tr("No synchronization needed")
  const parts: string[] = []
  if (sync.added.length) parts.push(tr("Added {0}", [sync.added.length]))
  if (sync.missing.length) parts.push(tr("Missing {0}", [sync.missing.length]))
  if (sync.restored.length) parts.push(tr("Restored {0}", [sync.restored.length]))
  if (sync.updated.length) parts.push(tr("Updated {0}", [sync.updated.length]))
  return parts.length ? parts.join(' · ') : tr("No changes")
}

export default function Settings({ onBack, onApplied, theme, onThemeChange }: Props) {
  const language = useLanguage()
  const [languageError, setLanguageError] = useState('')
  const [section, setSection] = useState<SectionId>('appearance')
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [themeError, setThemeError] = useState('')
  const [logLevel, setLogLevel] = useState<LogLevel>(LogSeverity.Info)
  const [logError, setLogError] = useState('')

  // CLI / skill install state: only read from the filesystem when that section is opened
  const [skill, setSkill] = useState<SkillPayload | null>(null)
  const [skillNotice, setSkillNotice] = useState('')
  const [skillError, setSkillError] = useState('')

  // Agent hook 安装状态：同样只在打开这一节时读真文件
  const [hook, setHook] = useState<HookPlan | null>(null)
  const [hookNotice, setHookNotice] = useState('')
  const [hookError, setHookError] = useState('')

  // 呼出快捷键：注册归主进程（globalShortcut 只在那儿），这里只做录制与显示
  const [hotkey, setHotkey] = useState<{ shortcut: string; fallback: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [hotkeyNotice, setHotkeyNotice] = useState('')
  const [hotkeyError, setHotkeyError] = useState('')

  const [openWith, setOpenWith] = useState<OpenWithPayload | null>(null)
  const [openError, setOpenError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  // 系统通知：只有桌面端有。
  // macOS 的允许/拒绝由系统设置控制，这里只报支持性与投递失败
  const [notify, setNotify] = useState<{ supported: boolean; lastFailure: string } | null>(null)
  const [notifyMode, setNotifyMode] = useState<NotificationMode | null>(null)
  const [notifyNotice, setNotifyNotice] = useState('')
  const [notifyError, setNotifyError] = useState('')

  const loadSettings = useCallback(async () => {
    const s = await api.settings()
    setSettings(s)
    setDraft(s.dataDir)
  }, [])

  useEffect(() => {
    void loadSettings().catch((e: Error) => setError(e.message))
  }, [loadSettings])

  // Esc 返回看板；⌘1..4 切分区；⌘, 再按一次也返回。录制中全部让位给录制框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recording || isComposing(e)) return
      if (shortcut(e, 'settings.back')) {
        e.preventDefault()
        onBack()
        return
      }
      if (shortcut(e, 'settings.section')) {
        const n = Number(e.key)
        if (n >= 1 && n <= SECTIONS.length) {
          e.preventDefault()
          setSection(SECTIONS[n - 1].id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, recording])

  useEffect(() => {
    if (section !== 'skill') return
    void api
      .skill()
      .then(setSkill)
      .catch((e: Error) => setSkillError(tr("Could not read installation status: {0}", [e.message])))
  }, [section])

  useEffect(() => {
    if (section !== 'hook') return
    void api
      .hooks()
      .then(setHook)
      .catch((e: Error) => setHookError(tr("Could not read installation status: {0}", [e.message])))
  }, [section])

  useEffect(() => {
    if (section !== 'log') return
    void api.logLevel().then((result) => setLogLevel(result.logLevel))
      .catch((e: Error) => setLogError(tr("Could not read log level: {0}", [e.message])))
  }, [section])

  useEffect(() => {
    if (section !== 'shortcut') return
    void window.easyFlow
      ?.getShortcut?.()
      .then(setHotkey)
      .catch((e: Error) => setHotkeyError(tr("Could not read shortcut: {0}", [e.message])))
  }, [section])

  useEffect(() => {
    if (section !== 'open') return
    void api
      .openWith()
      .then(setOpenWith)
      .catch((e: Error) => setOpenError(tr("Could not read default application: {0}", [e.message])))
  }, [section])

  useEffect(() => {
    if (section !== 'notify') return
    void window.easyFlow
      ?.notificationInfo?.()
      .then(setNotify)
      .catch((e: Error) => setNotifyError(tr("Could not read notification status: {0}", [e.message])))
  }, [section])

  useEffect(() => {
    if (section !== 'notify') return
    void window.easyFlow
      ?.notificationMode?.()
      .then(setNotifyMode)
      .catch((e: Error) => setNotifyError(tr("Could not read notification mode: {0}", [e.message])))
  }, [section])

  // 失败是异步事件：页面一直开着时也要能收到，
  // 而不是只显示进来那一刻的快照
  useEffect(() => {
    if (section !== 'notify') return
    const off = window.easyFlow?.onNotificationFailed?.((message) => {
      setNotify((prev) => ({ supported: prev?.supported ?? true, lastFailure: message }))
    })
    return () => off?.()
  }, [section])

  // Electron 里可拉起原生目录选择器；浏览器开发时退化到手输
  const canPick = typeof window.easyFlow?.pickDirectory === 'function'
  // 快捷键只对桌面端有意义：web 模式没有全局快捷键，这一节整个不出现
  const canSetShortcut = typeof window.easyFlow?.setShortcut === 'function'
  // 通知同理：web 模式没有 dock 与系统通知
  const canNotify = typeof window.easyFlow?.notificationInfo === 'function'
  const platform = window.easyFlow?.platform ?? ''
  // 应用内键位表在浏览器预览里也有意义，
  // 所以「快捷键」分区不再按平台隐藏；
  // 通知只有桌面端有，web 模式仍然隐藏
  const sections = SECTIONS.filter((s) => s.id !== 'notify' || canNotify)

  // 改绑：主进程注册不上（多半被占用）时把原因带回来
  const applyShortcut = useCallback(
    async (accel: string) => {
      setHotkeyError('')
      setHotkeyNotice('')
      const res = await window.easyFlow?.setShortcut?.(accel)
      if (!res) return
      setRecording(false)
      if (res.ok && res.shortcut) {
        setHotkey((prev) => ({ shortcut: res.shortcut!, fallback: prev?.fallback ?? '' }))
        setHotkeyNotice(tr("Changed to {0}", [formatAccelerator(res.shortcut, platform)]))
        // 注册成功但没写进配置：也报出来，否则下次启动悄悄回到旧值
        if (res.error) setHotkeyError(res.error)
      } else {
        setHotkeyError(res.error ?? tr("Could not change shortcut"))
      }
    },
    [platform],
  )

  const applyOpenWith = useCallback(async (id: string) => {
    setOpenError('')
    try {
      setOpenWith(await api.setOpenWith(id))
    } catch (e) {
      setOpenError(tr("Could not save: {0}", [(e as Error).message]))
    }
  }, [])

  // missing 时打开已退回访达，界面跟着显示访达
  const selected: OpenWithOption | undefined = openWith
    ? openWith.options.find((o) => o.id === (openWith.missing ? '' : openWith.default)) ??
      openWith.options[0]
    : undefined

  const openMenu = useCallback(() => {
    setMenuOpen(true)
    requestAnimationFrame(() => {
      const at = openWith?.options.findIndex((o) => o.id === selected?.id) ?? -1
      optionRefs.current[Math.max(at, 0)]?.focus()
    })
  }, [openWith, selected])

  const closeMenu = useCallback((refocus = false) => {
    setMenuOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])

  const choose = useCallback(
    async (id: string) => {
      closeMenu(true)
      await applyOpenWith(id)
    },
    [closeMenu, applyOpenWith],
  )

  const onMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!openWith) return
      const at = openWith.options.findIndex((o) => o.id === selected?.id)
      const move = (delta: number) => {
        e.preventDefault()
        const next = Math.min(Math.max(at + delta, 0), openWith.options.length - 1)
        optionRefs.current[next]?.focus()
      }
      if (e.key === 'ArrowDown') move(1)
      else if (e.key === 'ArrowUp') move(-1)
      else if (e.key === 'Home') {
        e.preventDefault()
        optionRefs.current[0]?.focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        optionRefs.current[openWith.options.length - 1]?.focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu(true)
      } else if (e.key === 'Tab') {
        closeMenu()
      }
    },
    [openWith, selected, closeMenu],
  )

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  useEffect(() => {
    if (section !== 'open') setMenuOpen(false)
  }, [section])

  // 录制：捕获下一个组合键。Esc 取消；认不出的组合留在录制态让人重按
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setHotkeyError('')
        return
      }
      const accel = acceleratorFromEvent(e, platform)
      if (!accel) {
        setHotkeyError(tr("Use ⌘ / ⌃ / ⌥ with a letter, number, or function key."))
        return
      }
      void applyShortcut(accel)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, platform, applyShortcut])

  // 键位与铅笔都走这里：录制中再点一次就是取消
  function toggleRecording() {
    setRecording((v) => !v)
    setHotkeyError('')
    setHotkeyNotice('')
  }

  async function pick() {
    const picked = await window.easyFlow?.pickDirectory?.()
    if (picked) setDraft(picked)
  }

  async function switchDir() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const res = await api.switchDataDir(draft.trim())
      setMessage(res.unchanged ? tr("Directory unchanged") : tr("Directory switched · {0}", [describeSync(res.sync)]))
      await loadSettings()
      onApplied()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function resync() {
    setBusy(true)
    setError('')
    try {
      const res = await api.resync()
      setMessage(tr("Rescanned · {0}", [describeSync(res.sync)]))
      await loadSettings()
      onApplied()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function install() {
    setBusy(true)
    setSkillNotice('')
    setSkillError('')
    try {
      const res = await api.installSkill()
      setSkill(res)
      setSkillNotice(res.summary)
      setSkillError(res.failed.join('\n'))
    } catch (e) {
      setSkillError(tr("Installation failed: {0}", [(e as Error).message]))
    } finally {
      setBusy(false)
    }
  }

  async function installHooks() {
    setBusy(true)
    setHookNotice('')
    setHookError('')
    try {
      const res = await api.installHooks()
      setHook(res)
      setHookNotice(res.summary)
      setHookError(res.failed.join('\n'))
    } catch (e) {
      setHookError(tr("Installation failed: {0}", [(e as Error).message]))
    } finally {
      setBusy(false)
    }
  }

  async function uninstallHooks() {
    setBusy(true)
    setHookNotice('')
    setHookError('')
    try {
      const res = await api.uninstallHooks()
      setHook(res)
      setHookNotice(res.summary)
      setHookError(res.failed.join('\n'))
    } catch (e) {
      setHookError(tr("Uninstallation failed: {0}", [(e as Error).message]))
    } finally {
      setBusy(false)
    }
  }

  async function testNotification() {
    setNotifyNotice('')
    setNotifyError('')
    try {
      const res = await window.easyFlow?.testNotification?.()
      if (!res) return
      setNotify({ supported: res.supported, lastFailure: res.lastFailure })
      if (!res.supported) setNotifyError(tr("System notifications are not supported"))
      else if (res.lastFailure) setNotifyNotice('')
      else if (res.timedOut) setNotifyNotice(tr("Notification submitted without a system receipt. Check system settings if it did not appear."))
      else if (!res.delivered) setNotifyError(tr("Notification was not sent"))
    } catch (e) {
      setNotifyError(tr("Could not send test notification: {0}", [(e as Error).message]))
    }
  }

  async function changeNotificationMode(next: NotificationMode) {
    const previous = notifyMode
    setNotifyMode(next)
    setNotifyError('')
    setNotifyNotice('')
    try {
      const res = await window.easyFlow?.setNotificationMode?.(next)
      if (!res) {
        setNotifyMode(previous)
        return
      }
      if (!res.ok) {
        setNotifyMode(previous)
        setNotifyError(res.error ?? tr("Could not save notification mode"))
        return
      }
      setNotifyNotice(tr("Changed to “{0}”", [NOTIFICATION_MODE_LABELS[next]]))
    } catch (e) {
      setNotifyMode(previous)
      setNotifyError(tr("Could not save notification mode: {0}", [(e as Error).message]))
    }
  }

  async function changeTheme(next: Theme) {
    const previous = theme
    onThemeChange(next)
    setThemeError('')
    try {
      await api.setTheme(next)
    } catch (e) {
      onThemeChange(previous)
      setThemeError(tr("Could not save appearance: {0}", [(e as Error).message]))
    }
  }

  async function changeLogLevel(next: LogLevel) {
    setLogError('')
    try {
      await api.setLogLevel(next)
      setLogLevel(next)
    } catch (e) {
      setLogError(tr("Could not save log level: {0}", [(e as Error).message]))
    }
  }

  async function openNotificationSettings() {
    setNotifyError('')
    try {
      const res = await window.easyFlow?.openNotificationSettings?.()
      if (res && !res.ok) setNotifyError(tr("Notification settings are unavailable on this platform"))
    } catch (e) {
      setNotifyError(tr("Could not open system settings: {0}", [(e as Error).message]))
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        {/* 顶部占位：让开 macOS 红绿灯，兼作窗口拖拽区 */}
        <div className="settings-nav-head" />
        <div className="settings-nav-title">{tr("Settings")}</div>
        {sections.map((s, i) => (
          <button
            key={s.id}
            className={`settings-nav-item${section === s.id ? ' active' : ''}`}
            title={`${s.label}（⌘${i + 1}）`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="settings-nav-item back" onClick={onBack}>
          {tr("← Back")}</button>
      </aside>

      <main className="settings-main">
        {section === 'log' && (
          <>
            <h1>{tr("Logs")}</h1>
            {logError && <div className="notice">{logError}</div>}
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">{tr("Log level")}</div>
                <div className="settings-row-desc">{tr("Logs are retained for 24 hours")}</div>
              </div>
              <select className="settings-select" value={logLevel}
                onChange={(e) => void changeLogLevel(e.target.value as LogLevel)}>
                {LOG_LEVELS.map((level) => <option key={level} value={level}>{tr(({ debug: 'Debug', info: 'Information', warn: 'Warning', error: 'Error', silent: 'Silent' } as const)[level])}</option>)}
              </select>
            </div>
          </>
        )}
        {section === 'appearance' && (
          <>
            <h1>{tr("Appearance")}</h1>
            {languageError && <div className="notice">{languageError}</div>}
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">{tr('Language')}</div>
                <div className="settings-row-desc">{tr('Language changes apply immediately to both windows and are saved.')}</div>
              </div>
              <select className="settings-select" aria-label={tr('Language')} value={language}
                onChange={(event) => {
                  setLanguageError('')
                  void changeLanguage(event.target.value as Language).catch((error: Error) =>
                    setLanguageError(tr('Could not save language: {0}', [error.message])))
                }}>
                {LANGUAGES.map(value => <option key={value} value={value}>{value === Language.English ? tr('English') : tr('Chinese')}</option>)}
              </select>
            </div>


            {themeError && <div className="notice">{themeError}</div>}

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">{tr("Theme")}</div>
                <div className="settings-row-desc">{tr("System mode follows changes to the system appearance")}</div>
              </div>
              <select
                className="settings-select"
                value={theme}
                onChange={(e) => void changeTheme(e.target.value as Theme)}
              >
                {THEMES.map((t) => (
                  <option key={t} value={t}>
                    {THEME_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {section === 'data' && (
          <>
            <h1>{tr("Data directory")}</h1>

            {error && <div className="notice">{error}</div>}
            {message && <div className="notice ok">{message}</div>}

            <div className="section-label">{tr("Path")}</div>
            <div className="row">
              <input
                className="search wide"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
              {canPick && (
                <button className="btn" onClick={() => void pick()}>
                  {tr("Choose…")}</button>
              )}
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => void switchDir()}>
                {tr("Apply and initialize")}</button>
              <button className="btn" disabled={busy} onClick={() => void resync()}>
                {tr("Rescan")}</button>
            </div>

            <div className="section-label">{tr("Current state")}</div>
            <div className="settings-status">
              {settings
                ? tr("Requirements {0} · Projects {1}", [settings.counts.requirements, settings.counts.projects])
                : tr("Reading…")}
            </div>
          </>
        )}

        {section === 'open' && (
          <>
            <h1>{tr("Open with")}</h1>

            {openError && <div className="notice">{openError}</div>}
            {openWith?.missing && (
              <div className="notice">{tr("The selected application is no longer installed. Directories will open in Finder.")}</div>
            )}

            <div className="settings-row open-setting">
              <div className="settings-row-text">
                <div className="settings-row-title">{tr("Default application")}</div>
              </div>
              <div className={`open-picker${menuOpen ? ' open' : ''}`} ref={pickerRef}>
                <button
                  ref={buttonRef}
                  className="open-picker-btn"
                  disabled={!openWith}
                  aria-haspopup="listbox"
                  aria-expanded={menuOpen}
                  onClick={() => (menuOpen ? closeMenu() : openMenu())}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      openMenu()
                    }
                  }}
                >
                  {selected?.icon ? <img src={selected.icon} alt="" /> : <span className="open-icon-slot" />}
                  <span className="open-picker-name">
                    {selected ? openTargetLabel(selected) : tr("Scanning…")}
                  </span>
                  <span className="open-picker-chevron">
                    <ChevronIcon dir="down" size={12} />
                  </span>
                </button>

                {menuOpen && openWith && (
                  <div className="open-menu" role="listbox" aria-label={tr("Default application")} onKeyDown={onMenuKeyDown}>
                    {openWith.options.map((o, i) => (
                      <Fragment key={o.id || 'finder'}>
                        {i > 0 && openWith.options[i - 1].kind !== o.kind && <div className="open-menu-sep" />}
                        <button
                          ref={(el) => {
                            optionRefs.current[i] = el
                          }}
                          className="open-menu-item"
                          role="option"
                          aria-selected={o.id === selected?.id}
                          tabIndex={-1}
                          onClick={() => void choose(o.id)}
                        >
                          {o.icon ? <img src={o.icon} alt="" /> : <span className="open-icon-slot" />}
                          <span className="open-menu-label">{openTargetLabel(o)}</span>
                          {o.id === selected?.id && <CheckIcon />}
                        </button>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {section === 'shortcut' && (
          <>
            <h1>{tr("Keyboard shortcuts")}</h1>

            {hotkeyError && <div className="notice">{hotkeyError}</div>}
            {hotkeyNotice && <div className="notice ok">{hotkeyNotice}</div>}

            {canSetShortcut ? (
              <div className="settings-row">
                <div className="settings-row-text">
                  <div className="settings-row-title">{tr("Toggle panel")}</div>
                  <div className="settings-row-desc">{tr("Show or hide the panel from any application")}</div>
                </div>
                <button
                  className={`shortcut-key${recording ? ' recording' : ''}`}
                  onClick={toggleRecording}
                >
                  {recording
                    ? tr("Press a shortcut… (Esc to cancel)")
                    : hotkey
                      ? acceleratorKeys(hotkey.shortcut, platform).map((k, i) => (
                          <span className="keycap" key={`${k}-${i}`}>
                            <KeyGlyph mark={k} />
                          </span>
                        ))
                      : tr("Reading…")}
                </button>
                <button className="icon-btn" title={tr("Change shortcut")} onClick={toggleRecording}>
                  <PencilIcon />
                </button>
                <button
                  className="icon-btn"
                  title={tr("Restore default")}
                  disabled={!hotkey || hotkey.shortcut === hotkey.fallback}
                  onClick={() => hotkey && void applyShortcut(hotkey.fallback)}
                >
                  <ResetIcon />
                </button>
              </div>
            ) : (
              <p className="hint">{tr("Browser preview has no global shortcuts. Application shortcuts are listed below.")}</p>
            )}

            <div className="section-label">{tr("Application shortcuts")}</div>
            <div className="shortcut-list">
              {CONTEXT_ORDER.map((ctx) => {
                const items = SHORTCUTS.filter((s) => s.context === ctx && !s.hidden)
                if (!items.length) return null
                return (
                  <section className="shortcut-group" key={ctx}>
                    <div className="shortcut-group-name">{CONTEXT_LABEL[ctx]}</div>
                    {items.map((s) => (
                      <div className="shortcut-row" key={`${ctx}:${s.label}`}>
                        <span className="shortcut-keys">
                          {s.display ??
                            s.keys.map((k) => formatAccelerator(k, platform)).join(' / ')}
                        </span>
                        <span className="shortcut-label">{s.label}</span>
                      </div>
                    ))}
                  </section>
                )
              })}
            </div>
          </>
        )}

        {section === 'notify' && (
          <>
            <h1>{tr("Notifications")}</h1>

            {notifyError && <div className="notice">{notifyError}</div>}
            {notifyNotice && <div className="notice ok">{notifyNotice}</div>}

            <div className="section-label">{tr("Notification mode")}</div>
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">{tr("Show system notifications")}</div>
              </div>
              <select
                className="settings-select"
                value={notifyMode ?? 'unfocused'}
                disabled={!notifyMode}
                onChange={(e) => void changeNotificationMode(e.target.value as NotificationMode)}
              >
                {NOTIFICATION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {NOTIFICATION_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            {notify && !notify.supported && <div className="notice">{tr("System notifications are not supported")}</div>}
            {notify?.lastFailure && (
              <div className="notice">{tr("Most recent delivery failure:")}{notify.lastFailure}</div>
            )}
            <div className="row notify-actions">
              <button className="btn primary" onClick={() => void testNotification()}>
                {tr("Send test notification")}</button>
              <button className="btn" onClick={() => void openNotificationSettings()}>
                {tr("Open system settings")}</button>
            </div>
          </>
        )}

        {section === 'hook' && (
          <>
            <h1>{tr("Hooks")}</h1>

            {hookError && <div className="notice">{hookError}</div>}
            {hookNotice && <div className="notice ok">{hookNotice}</div>}

            <div className="section-label">{tr("Installation status")}</div>
            {hook ? (
              hook.agents.map((a) => (
                <div className="settings-status" key={a.id} title={agentLabel(a.id, a.label)}>
                  <AgentIcon agent={a.id} size={13} />
                  <span>
                    {a.problem ? tr("Cannot read: {0}", [a.problem]) : a.installed ? tr("Installed") : tr("Not installed")}
                  </span>
                </div>
              ))
            ) : (
              <div className="settings-status">{tr("Reading…")}</div>
            )}

            <div className="row">
              <button className="btn primary" disabled={busy || !hook} onClick={() => void installHooks()}>
                {hook?.agents.some((a) => a.installed) ? tr("Reinstall") : tr("Install all")}
              </button>
              <button className="btn" disabled={busy || !hook} onClick={() => void uninstallHooks()}>
                {tr("Uninstall all")}</button>
            </div>
          </>
        )}

        {section === 'skill' && (
          <>
            <h1>{tr("CLI and Skill")}</h1>

            {skillError && <div className="notice">{skillError}</div>}
            {skillNotice && <div className="notice ok">{skillNotice}</div>}
            {skill?.problem && <div className="notice">{skill.problem}</div>}

            <div className="section-label">{tr("Installation status")}</div>
            {skill ? (
              <>
                <div className="settings-status" title={tr("easy-flow command")}>
                  <TerminalIcon />
                  <span>{skill.shim.installed ? tr("Installed") : tr("Not installed")}</span>
                </div>
                {skill.agents.map((a) => (
                  <div className="settings-status" key={a.id} title={agentLabel(a.id, a.label)}>
                    <AgentIcon agent={a.id} size={13} />
                    <span>{!a.available ? tr("This agent is not installed") : a.linked ? tr("Installed") : tr("Not installed")}</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="settings-status">{tr("Reading…")}</div>
            )}

            <div className="row">
              <button
                className="btn primary"
                disabled={busy || !skill?.source}
                onClick={() => void install()}
              >
                {skill?.shim.installed ? tr("Reinstall") : tr("Install")}
              </button>
            </div>

            {!!skill?.legacyMcp.some((m) => m.registered) && (
              <>
                <div className="section-label">{tr("Legacy MCP registrations")}</div>
                <p className="hint">
                  {skill.legacyMcp
                    .filter((m) => m.registered)
                    .map((m) => m.label)
                    .join('、')}
                  {tr("Legacy easy-flow MCP registrations remain. Installation will remove them.")}</p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
