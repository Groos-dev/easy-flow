import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { SettingsPayload, SkillPayload, SyncResult } from '../lib/types'

interface Props {
  onBack: () => void
  /** 应用后通知外层重新拉取数据 */
  onApplied: () => void
}

type SectionId = 'data' | 'skill'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'data', label: '数据目录' },
  { id: 'skill', label: 'CLI 与 Skill' },
]

function describeSync(sync: SyncResult | null): string {
  if (!sync) return '无需同步'
  const parts: string[] = []
  if (sync.added.length) parts.push(`新增 ${sync.added.length}`)
  if (sync.orphaned.length) parts.push(`失联 ${sync.orphaned.length}`)
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

  const loadSettings = useCallback(async () => {
    const s = await api.settings()
    setSettings(s)
    setDraft(s.dataDir)
  }, [])

  useEffect(() => {
    void loadSettings().catch((e: Error) => setError(e.message))
  }, [loadSettings])

  // Esc 返回看板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  useEffect(() => {
    if (section !== 'skill') return
    void api
      .skill()
      .then(setSkill)
      .catch((e: Error) => setSkillError(`读取安装状态失败：${e.message}`))
  }, [section])

  /** Electron 里可拉起原生目录选择器；浏览器开发时退化到手输 */
  const canPick = typeof window.easyFlow?.pickDirectory === 'function'

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
      if (res.unchanged) {
        setMessage('目录未变化')
      } else {
        const lines = [
          `已切换到 ${res.dataDir}`,
          `数据库：${res.dbFile}`,
          `同步：${describeSync(res.sync)}`,
        ]
        if (res.sync?.added.length) lines.push(`新增：${res.sync.added.join(', ')}`)
        setMessage(lines.join('\n'))
      }
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
      setMessage(`重新扫描完成：${describeSync(res.sync)}`)
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
      setSkillNotice(res.installed.length ? `已完成：${res.installed.join('；')}` : '没有需要安装的')
    } catch (e) {
      setSkillError(`安装失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <div className="settings-nav-title">设置</div>
        {SECTIONS.map((s) => (
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
            {message && <pre className="ok-box">{message}</pre>}

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
            <pre>
              {settings
                ? [
                    `数据目录：${settings.dataDir}`,
                    `数据库：  ${settings.dbFile}`,
                    `需求数：  ${settings.counts.requirements}`,
                  ].join('\n')
                : '读取中…'}
            </pre>
          </>
        )}

        {section === 'skill' && (
          <>
            <h1>CLI 与 Skill</h1>

            {skillError && <div className="notice">{skillError}</div>}
            {skillNotice && <div className="notice ok">{skillNotice}</div>}
            {skill?.problem && <div className="notice">{skill.problem}</div>}

            <div className="section-label">装什么</div>
            <pre>
              {[
                `命令   ${skill?.shim.path ?? '—'}`,
                `skill  ${skill?.source ?? '—'}`,
                skill?.skills.length ? `       ${skill.skills.join('、')}` : '',
                skill?.node ? `node   ${skill.node.version}（${skill.node.path}）` : 'node   读不到',
              ]
                .filter(Boolean)
                .join('\n')}
            </pre>

            <div className="section-label">安装状态</div>
            <div className="row">
              <span>命令行 · {skill?.shim.installed ? '已安装' : '未安装'}</span>
            </div>
            {(skill?.agents ?? []).map((a) => (
              <div className="row" key={a.id}>
                <span>
                  {a.label} · {!a.available ? '未装这个 agent' : a.linked ? '已安装' : '未安装'}
                </span>
              </div>
            ))}
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
