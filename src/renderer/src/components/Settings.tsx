import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SettingsPayload, type SkillPayload } from '../lib/api'
import { detectMonospaceFonts } from '../lib/fonts'
import type { SyncResult } from '../lib/types'

interface Props {
  onBack: () => void
  /** 应用后通知外层重新拉取数据 */
  onApplied: () => void
}

type SectionId = 'data' | 'appearance' | 'skill' | 'about'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'data', label: '数据目录' },
  { id: 'appearance', label: '外观' },
  { id: 'skill', label: 'CLI 与 Skill' },
  { id: 'about', label: '关于' },
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

  // 终端外观
  const [fontFamily, setFontFamily] = useState('')
  const [fontSize, setFontSize] = useState(12.5)
  const [fontNotice, setFontNotice] = useState('')

  const installedFonts = useMemo(() => detectMonospaceFonts(), [])
  const fontTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // CLI / skill install state: only read from the filesystem when that section is opened
  const [skill, setSkill] = useState<SkillPayload | null>(null)
  const [skillNotice, setSkillNotice] = useState('')
  const [skillError, setSkillError] = useState('')

  const loadSettings = useCallback(async () => {
    const s = await api.settings()
    setSettings(s)
    setDraft(s.dataDir)
    setFontFamily(s.terminalFontFamily)
    setFontSize(s.terminalFontSize)
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

  async function applyAppearance(patch: { terminalFontFamily?: string; terminalFontSize?: number }) {
    setFontNotice('')
    try {
      const res = await api.saveAppearance(patch)
      setFontFamily(res.terminalFontFamily)
      setFontSize(res.terminalFontSize)
      setFontNotice('已保存，终端立即生效')
    } catch (e) {
      setFontNotice(`保存失败：${(e as Error).message}`)
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
          ← 返回看板
        </button>
      </aside>

      <main className="settings-main">
        {section === 'data' && (
          <>
            <h1>数据目录</h1>
            <p className="hint">
              需求目录与 <code>easy-flow.db</code> 都放在这里。状态保存在数据库中，
              因此换目录等于换一整套看板数据；切换后会扫描新目录并初始化数据库。
            </p>

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

        {section === 'appearance' && (
          <>
            <h1>外观</h1>
            <p className="hint">
              终端字体影响所有 CLI 的显示效果。如果提示符里的图标、分隔符显示为方块或错位，
              说明当前字体缺少 Nerd Font 字形，从下面挑一个带 Nerd 字形的即可。
            </p>

            {fontNotice && <div className="notice ok">{fontNotice}</div>}

            <div className="section-label">终端字体（检测到 {installedFonts.length} 个等宽字体）</div>
            <div className="font-list">
              {installedFonts.map((f) => (
                <button
                  key={f}
                  // 配置里存的是完整字体栈，只要包含该字体名就算选中
                  className={`font-item${fontFamily.includes(f) ? ' active' : ''}`}
                  onClick={() => void applyAppearance({ terminalFontFamily: f })}
                >
                  <span className="font-name">{f}</span>
                  <span className="font-sample">❯ ~/req  main +2 !2 ?48 ──╮</span>
                </button>
              ))}
              {installedFonts.length === 0 && (
                <div className="hint">未检测到常见等宽字体，可在下方手动填写字体名。</div>
              )}
            </div>

            <div className="section-label">或手动填写 font-family</div>
            <div className="row">
              <input
                className="search wide"
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
                spellCheck={false}
              />
              <button className="btn" onClick={() => void applyAppearance({ terminalFontFamily: fontFamily })}>
                应用
              </button>
            </div>

            <div className="section-label">字号 · {fontSize}px</div>
            <div className="row">
              <input
                type="range"
                min={10}
                max={20}
                step={0.5}
                value={fontSize}
                // 拖动与键盘调整都走 onChange；原先只在 mouseUp 保存，
                // 用方向键调完永远不落盘，返回后会被弹回。
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setFontSize(v)
                  if (fontTimer.current) clearTimeout(fontTimer.current)
                  fontTimer.current = setTimeout(
                    () => void applyAppearance({ terminalFontSize: v }),
                    400,
                  )
                }}
              />
            </div>

            <div className="section-label">预览</div>
            <pre className="font-preview" style={{ fontFamily, fontSize }}>
              {[
                '❯ ~/requirements/tf-meal-b2b-crawler   main +2 !2 ?48',
                '~/req  ──╮  ╰─  ▶  ● ○ ◆  ⚡',
                'const s = "JetBrainsMono 0123456789"',
                '餐食出票 → B2B 爬虫履约｜中文对齐测试',
              ].join('\n')}
            </pre>
          </>
        )}

        {section === 'skill' && (
          <>
            <h1>CLI 与 Skill</h1>
            <p className="hint">
              装一条 <code>easy-flow</code> 命令和一个 skill：人、脚本与 agent 都走这条命令，
              skill 让 agent 在该用时想得起来。安装只动用户环境（PATH 与各 agent 的 skills 目录），
              不往需求目录或 worktree 落任何文件。
            </p>

            {skillError && <div className="notice">{skillError}</div>}
            {skillNotice && <div className="notice ok">{skillNotice}</div>}
            {skill?.problem && <div className="notice">{skill.problem}</div>}

            <div className="section-label">装什么</div>
            <pre>
              {[
                `命令   ${skill?.shim.path ?? '—'}`,
                `skill  ${skill?.source ?? '—'}`,
                skill?.node ? `node   ${skill.node.version}（${skill.node.path}）` : 'node   读不到',
              ].join('\n')}
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
                  还挂着 easy-flow 的 MCP 注册；安装时会自动摘掉——旧的入口文件已删，留着只会让每个会话报错。
                </p>
              </>
            )}
          </>
        )}

        {section === 'about' && (
          <>
            <h1>关于</h1>
            <p className="hint">
              easy-flow —— 以 markdown 为内容事实源、以 SQLite 为状态权威的需求看板。
            </p>
            <div className="section-label">职责划分</div>
            <pre>
              {[
                'md      → 需求内容（需求、方案、决策、踩坑），agent 读写',
                'sqlite  → 机器状态（阶段、优先级、更新日期）与文档索引',
                '',
                '状态不再写在 markdown 里，因此 agent 重写文档不会破坏状态。',
              ].join('\n')}
            </pre>
            <div className="section-label">数据位置</div>
            <pre>{settings ? `${settings.dataDir}/easy-flow.db` : '—'}</pre>
          </>
        )}
      </main>
    </div>
  )
}
