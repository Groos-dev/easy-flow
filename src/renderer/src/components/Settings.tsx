import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { acceleratorFromEvent, acceleratorKeys, formatAccelerator } from '../lib/shortcut'
import type { HookPlan, SettingsPayload, SkillPayload, SyncResult } from '../lib/types'
import { AgentIcon, KeyGlyph, PencilIcon, ResetIcon, TerminalIcon } from './icons'

interface Props {
  onBack: () => void
  /** 应用后通知外层重新拉取数据 */
  onApplied: () => void
}

type SectionId = 'data' | 'shortcut' | 'skill' | 'hook'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'data', label: '数据目录' },
  { id: 'shortcut', label: '快捷键' },
  { id: 'skill', label: 'CLI 与 Skill' },
  { id: 'hook', label: '钩子' },
]

function describeSync(sync: SyncResult | null): string {
  if (!sync) return '无需同步'
  const parts: string[] = []
  if (sync.added.length) parts.push(`新增 ${sync.added.length}`)
  if (sync.missing.length) parts.push(`失联 ${sync.missing.length}`)
  if (sync.restored.length) parts.push(`恢复 ${sync.restored.length}`)
  if (sync.updated.length) parts.push(`更新 ${sync.updated.length}`)
  return parts.length ? parts.join(' · ') : '无变化'
}

export default function Settings({ onBack, onApplied }: Props) {
  const [section, setSection] = useState<SectionId>('data')
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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

  const loadSettings = useCallback(async () => {
    const s = await api.settings()
    setSettings(s)
    setDraft(s.dataDir)
  }, [])

  useEffect(() => {
    void loadSettings().catch((e: Error) => setError(e.message))
  }, [loadSettings])

  // Esc 返回看板。录制中要让位给「Esc 取消录制」
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !recording) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, recording])

  useEffect(() => {
    if (section !== 'skill') return
    void api
      .skill()
      .then(setSkill)
      .catch((e: Error) => setSkillError(`读取安装状态失败：${e.message}`))
  }, [section])

  useEffect(() => {
    if (section !== 'hook') return
    void api
      .hooks()
      .then(setHook)
      .catch((e: Error) => setHookError(`读取安装状态失败：${e.message}`))
  }, [section])

  useEffect(() => {
    if (section !== 'shortcut') return
    void window.easyFlow
      ?.getShortcut?.()
      .then(setHotkey)
      .catch((e: Error) => setHotkeyError(`读取快捷键失败：${e.message}`))
  }, [section])

  /** Electron 里可拉起原生目录选择器；浏览器开发时退化到手输 */
  const canPick = typeof window.easyFlow?.pickDirectory === 'function'
  /** 快捷键只对桌面端有意义：web 模式没有全局快捷键，这一节整个不出现 */
  const canSetShortcut = typeof window.easyFlow?.setShortcut === 'function'
  const platform = window.easyFlow?.platform ?? ''
  const sections = SECTIONS.filter((s) => s.id !== 'shortcut' || canSetShortcut)

  /** 改绑：主进程注册不上（多半被占用）时把原因带回来 */
  const applyShortcut = useCallback(
    async (accel: string) => {
      setHotkeyError('')
      setHotkeyNotice('')
      const res = await window.easyFlow?.setShortcut?.(accel)
      if (!res) return
      setRecording(false)
      if (res.ok && res.shortcut) {
        setHotkey((prev) => ({ shortcut: res.shortcut!, fallback: prev?.fallback ?? '' }))
        setHotkeyNotice(`已改为 ${formatAccelerator(res.shortcut, platform)}`)
        // 注册成功但没写进配置：也报出来，否则下次启动悄悄回到旧值
        if (res.error) setHotkeyError(res.error)
      } else {
        setHotkeyError(res.error ?? '改绑失败')
      }
    },
    [platform],
  )

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
        setHotkeyError('这个组合不行：要带 ⌘ / ⌃ / ⌥，键用字母、数字或功能键')
        return
      }
      void applyShortcut(accel)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, platform, applyShortcut])

  /** 键位与铅笔都走这里：录制中再点一次就是取消 */
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
      setMessage(res.unchanged ? '目录未变化' : `已切换 · ${describeSync(res.sync)}`)
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
      setMessage(`已重新扫描 · ${describeSync(res.sync)}`)
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
      setSkillError(`安装失败：${(e as Error).message}`)
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
      setHookError(`安装失败：${(e as Error).message}`)
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
      setHookError(`卸载失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        {/* 顶部占位：让开 macOS 红绿灯，兼作窗口拖拽区 */}
        <div className="settings-nav-head" />
        <div className="settings-nav-title">设置</div>
        {sections.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item${section === s.id ? ' active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="settings-nav-item back" onClick={onBack}>
          ← 返回
        </button>
      </aside>

      <main className="settings-main">
        {section === 'data' && (
          <>
            <h1>数据目录</h1>

            {error && <div className="notice">{error}</div>}
            {message && <div className="notice ok">{message}</div>}

            <div className="section-label">路径</div>
            <div className="row">
              <input
                className="search wide"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
              {canPick && (
                <button className="btn" onClick={() => void pick()}>
                  选择…
                </button>
              )}
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => void switchDir()}>
                应用并初始化
              </button>
              <button className="btn" disabled={busy} onClick={() => void resync()}>
                重新扫描
              </button>
            </div>

            <div className="section-label">当前状态</div>
            <div className="settings-status">
              {settings
                ? `需求 ${settings.counts.requirements} · 项目 ${settings.counts.projects}`
                : '读取中…'}
            </div>
          </>
        )}

        {section === 'shortcut' && (
          <>
            <h1>快捷键</h1>

            {hotkeyError && <div className="notice">{hotkeyError}</div>}
            {hotkeyNotice && <div className="notice ok">{hotkeyNotice}</div>}

            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">呼出面板</div>
                <div className="settings-row-desc">在任意应用里呼出 / 收起面板</div>
              </div>
              <button
                className={`shortcut-key${recording ? ' recording' : ''}`}
                onClick={toggleRecording}
              >
                {recording
                  ? '按下组合键…（Esc 取消）'
                  : hotkey
                    ? acceleratorKeys(hotkey.shortcut, platform).map((k, i) => (
                        <span className="keycap" key={`${k}-${i}`}>
                          <KeyGlyph mark={k} />
                        </span>
                      ))
                    : '读取中…'}
              </button>
              <button className="icon-btn" title="改绑" onClick={toggleRecording}>
                <PencilIcon />
              </button>
              <button
                className="icon-btn"
                title="恢复默认"
                disabled={!hotkey || hotkey.shortcut === hotkey.fallback}
                onClick={() => hotkey && void applyShortcut(hotkey.fallback)}
              >
                <ResetIcon />
              </button>
            </div>
          </>
        )}


        {section === 'hook' && (
          <>
            <h1>钩子</h1>

            {hookError && <div className="notice">{hookError}</div>}
            {hookNotice && <div className="notice ok">{hookNotice}</div>}

            <p className="hint">
              把 easy-flow 的 hook 装进两个 agent 的用户配置，会话状态才能细到每次工具调用。
              只往事件数组里追加自己那条，卸载只摘自己那条——别人的 hook 原样不动；改配置前会留一份 .bak。
              端口变了，装出来的地址会跟着更新。
            </p>

            <div className="section-label">安装状态</div>
            {hook ? (
              hook.agents.map((a) => (
                <div className="settings-status" key={a.id} title={a.label}>
                  <AgentIcon agent={a.id} size={13} />
                  <span>
                    {a.problem ? `读不了：${a.problem}` : a.installed ? '已安装' : '未安装'}
                  </span>
                </div>
              ))
            ) : (
              <div className="settings-status">读取中…</div>
            )}

            <div className="row">
              <button className="btn primary" disabled={busy || !hook} onClick={() => void installHooks()}>
                {hook?.agents.some((a) => a.installed) ? '重新安装' : '一键安装'}
              </button>
              <button className="btn" disabled={busy || !hook} onClick={() => void uninstallHooks()}>
                一键卸载
              </button>
            </div>
          </>
        )}

        {section === 'skill' && (
          <>
            <h1>CLI 与 Skill</h1>

            {skillError && <div className="notice">{skillError}</div>}
            {skillNotice && <div className="notice ok">{skillNotice}</div>}
            {skill?.problem && <div className="notice">{skill.problem}</div>}

            <div className="section-label">安装状态</div>
            {skill ? (
              <>
                <div className="settings-status" title="easy-flow 命令">
                  <TerminalIcon />
                  <span>{skill.shim.installed ? '已安装' : '未安装'}</span>
                </div>
                {skill.agents.map((a) => (
                  <div className="settings-status" key={a.id} title={a.label}>
                    <AgentIcon agent={a.id} size={13} />
                    <span>{!a.available ? '未装这个 agent' : a.linked ? '已安装' : '未安装'}</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="settings-status">读取中…</div>
            )}

            <div className="row">
              <button
                className="btn primary"
                disabled={busy || !skill?.source}
                onClick={() => void install()}
              >
                {skill?.shim.installed ? '重新安装' : '安装'}
              </button>
            </div>

            {!!skill?.legacyMcp.some((m) => m.registered) && (
              <>
                <div className="section-label">旧的 MCP 注册</div>
                <p className="hint">
                  {skill.legacyMcp
                    .filter((m) => m.registered)
                    .map((m) => m.label)
                    .join('、')}
                  还挂着 easy-flow 的 MCP 注册，安装时会自动摘掉。
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
