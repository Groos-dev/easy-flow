import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import type { Requirement } from '../lib/types'
import TerminalPane from './TerminalPane'

/**
 * 详情页的两种挂载点：
 *   requirement —— 需求（含优先级/阶段控制）
 *   project     —— 项目（展示并编辑项目总规范，终端开在项目根目录）
 */
export interface DocTarget {
  kind: 'requirement' | 'project'
  project: string
  /** 仅 kind === 'requirement' 时有值 */
  slug?: string
  title: string
  /** 仅 requirement 有：用于头部展示与编辑 */
  req?: Requirement
}

interface Props {
  target: DocTarget
  /** 由服务端下发的枚举，避免这里再维护一份 */
  stages: string[]
  priorities: string[]
  fontFamily: string
  fontSize: number
  onBack: () => void
  onOpenSettings: () => void
  /** 改了状态后通知看板刷新 */
  onUpdated: () => void
  /** 侧边栏状态：决定是否显示展开/收起按钮 */
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

const PRIORITY_DESC: Record<string, string> = {
  p0: '重要且紧急',
  p1: '重要不紧急',
  p2: '紧急不重要',
  p3: '都不',
}

/** 预览图标（眼睛） */
function EyeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/** 源码图标（尖括号） */
function CodeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

interface SelectOption {
  value: string
  label: string
  /** 选项前显示优先级色点 */
  dot?: boolean
}

/**
 * 只显示当前值，点击弹出菜单切换。
 * 用自绘而非原生 select：原生控件在暗色主题下样式不可控。
 */
function SelectMenu({
  value,
  options,
  placeholder,
  disabled,
  hint,
  onChange,
}: {
  value: string
  options: SelectOption[]
  placeholder: string
  disabled?: boolean
  hint?: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 点击外部或 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className="select-menu" ref={boxRef}>
      <button
        className="select-trigger"
        disabled={disabled}
        title={hint}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.dot && <span className={`prio ${value}`} />}
        <span className={current ? '' : 'select-placeholder'}>{current?.label ?? placeholder}</span>
        <svg
          className="select-caret"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="select-list" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              className={`select-item${o.value === value ? ' active' : ''}`}
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                setOpen(false)
                if (o.value !== value) onChange(o.value)
              }}
            >
              {o.dot && <span className={`prio ${o.value}`} />}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type ViewMode = 'preview' | 'source'

/** 停止输入后多久落盘 */
const AUTOSAVE_DELAY = 600

export default function Detail({
  target,
  stages,
  priorities,
  fontFamily,
  fontSize,
  onBack,
  onOpenSettings,
  onUpdated,
  sidebarOpen,
  onToggleSidebar,
}: Props) {
  const req = target.req
  const isProject = target.kind === 'project'
  const terminalTarget = isProject
    ? { project: target.project }
    : { project: target.project, slug: target.slug! }
  const [docs, setDocs] = useState<string[]>(['AGENTS.md'])
  const [activeDoc, setActiveDoc] = useState('AGENTS.md')
  /** draft 是唯一事实源：预览渲染它、源码编辑它、自动保存提交它 */
  const [draft, setDraft] = useState('')
  /** 上次成功保存的内容，用来判断是否真有改动 */
  const savedRef = useRef('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [mode, setMode] = useState<ViewMode>('preview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showTerminal, setShowTerminal] = useState(true)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 文档加载序号：快速切标签时丢弃过期响应 */
  const docSeq = useRef(0)
  /** 保存用的最新值，避免防抖回调闭包过期 */
  const draftRef = useRef('')

  useEffect(() => {
    let alive = true
    const load =
      isProject
        ? api.projectConvention(target.project).then((r) => (r.content ? ['AGENTS.md'] : []))
        : api
            .context(target.slug!, target.project)
            .then((c) => ['AGENTS.md', ...c.requirement.docs.map((d) => d.name)])
    void load
      .then((names) => {
        if (alive) setDocs([...new Set(names as string[])])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [target.project, target.slug, isProject])

  const loadDoc = useCallback(async () => {
    const seq = ++docSeq.current
    setLoading(true)
    setError('')
    setSaveState('idle')
    try {
      const res = isProject
        ? await api.projectConvention(target.project).then((r) => ({
            content: r.content ?? '',
          }))
        : await api.doc(target.slug!, activeDoc, target.project)
      if (seq !== docSeq.current) return // 已被更新的请求取代
      setDraft(res.content)
      draftRef.current = res.content
      savedRef.current = res.content
    } catch (e) {
      if (seq !== docSeq.current) return
      setError((e as Error).message)
      setDraft('')
      draftRef.current = ''
      savedRef.current = ''
    } finally {
      if (seq === docSeq.current) setLoading(false)
    }
  }, [target.project, target.slug, activeDoc, isProject])

  useEffect(() => {
    void loadDoc()
  }, [loadDoc])

  /** 落盘。用 ref 取最新内容，避免防抖回调里的闭包过期。 */
  const flushSave = useCallback(async () => {
    const content = draftRef.current
    if (content === savedRef.current) return
    setSaveState('saving')
    try {
      if (isProject) await api.saveProjectConvention(target.project, content)
      else await api.saveDoc(target.slug!, activeDoc, content, target.project)
      savedRef.current = content
      setSaveState('saved')
    } catch (e) {
      setSaveState('error')
      setError(`自动保存失败：${(e as Error).message}`)
    }
  }, [target.project, target.slug, activeDoc, isProject])

  // 自动保存：停止输入 AUTOSAVE_DELAY 后落盘
  useEffect(() => {
    if (loading) return
    if (draft === savedRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flushSave(), AUTOSAVE_DELAY)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [draft, loading, flushSave])

  // 离开前把未落盘的改动刷出去（切文档 / 返回看板）。
  // 用 ref 判断，避免把 loading 放进依赖导致清理函数反复触发；
  // flushSave 内部有「内容未变则跳过」的守卫，重复调用是安全的。
  const loadingRef = useRef(false)
  loadingRef.current = loading
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (!loadingRef.current) void flushSave()
    }
  }, [flushSave])

  // ⌘E 在预览/源码间切换；⌘S 立即保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) {
        if (e.key === 'Escape') onBack()
        return
      }
      if (e.key === 's') {
        e.preventDefault()
        if (saveTimer.current) clearTimeout(saveTimer.current)
        void flushSave()
      } else if (e.key === 'e') {
        e.preventDefault()
        setMode((m) => (m === 'source' ? 'preview' : 'source'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flushSave, onBack])

  // 源码模式进入时聚焦；预览模式下双击进入编辑
  useEffect(() => {
    if (mode === 'source' && textareaRef.current) {
      const el = textareaRef.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [mode])

  async function apply(patch: { stage?: string; priority?: string }) {
    setBusy(true)
    try {
      if (!req) return
      await api.update(req.slug, patch, target.project)
      onUpdated()
    } finally {
      setBusy(false)
    }
  }

  // 文档列表：只看需求根目录与 docs/ 下的文档。
  // tasks/ 之类的历史目录不进标签栏（同名文件多，且已不是主结构）。
  const docTabs = useMemo(() => {
    const picked = docs.filter((n) => !n.includes('/') || n.startsWith('docs/'))
    const list = ['AGENTS.md', ...picked.filter((n) => n !== 'AGENTS.md')]

    const baseOf = (n: string) => n.split('/').pop() ?? n
    const counts = new Map<string, number>()
    for (const n of list) counts.set(baseOf(n), (counts.get(baseOf(n)) ?? 0) + 1)

    return list.map((n) => {
      const base = baseOf(n)
      const dup = (counts.get(base) ?? 0) > 1
      const label = dup ? n.replace(/^docs\//, '') : base
      return { name: n, label: label.length > 24 ? `${label.slice(0, 22)}…` : label }
    })
  }, [docs])

  return (
    <div className="detail-page">
      <header className="detail-head">
        {!sidebarOpen && (
          <button className="icon-btn" onClick={onToggleSidebar} title="展开侧边栏">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        )}
        <button className="btn" onClick={onBack} title="返回看板（Esc）">
          ← 看板
        </button>
        <div className="detail-title">
          <h1>{target.title}</h1>
        </div>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() =>
            void (isProject
              ? api.openProject(target.project).catch(() => {})
              : api.open(target.slug!, target.project).catch(() => {}))
          }
        >
          打开目录
        </button>
        <button
          className={`btn${showTerminal ? ' primary' : ''}`}
          onClick={() => setShowTerminal((v) => !v)}
        >
          终端
        </button>
        <button className="btn" onClick={onOpenSettings}>
          设置
        </button>
        {sidebarOpen && (
          <button className="icon-btn" onClick={onToggleSidebar} title="收起侧边栏">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        )}
      </header>

      {!isProject && req && (
      <div className="detail-controls">
        <SelectMenu
          value={req.priority}
          placeholder="未设优先级"
          disabled={busy}
          options={priorities.map((p) => ({
            value: p,
            label: `${p.toUpperCase()} · ${PRIORITY_DESC[p] ?? ''}`,
            dot: true,
          }))}
          onChange={(p) => void apply({ priority: p })}
        />
        <SelectMenu
          value={req.stage}
          placeholder="未设阶段"
          disabled={busy}
          hint="拖卡片只切到该列的首个阶段，细粒度在这里改"
          options={stages.map((s) => ({ value: s, label: s }))}
          onChange={(s) => void apply({ stage: s })}
        />
      </div>
      )}

      <div className={`detail-body${showTerminal ? '' : ' no-terminal'}`}>
        <section className="doc-pane">
          <div className="doc-bar">
            {docTabs.map((tab) => (
              <button
                key={tab.name}
                className={`doc-tab${tab.name === activeDoc ? ' active' : ''}`}
                onClick={() => setActiveDoc(tab.name)}
                title={tab.name}
              >
                {tab.label}
              </button>
            ))}
            <span className="spacer" />
            <button
              className="mode-btn"
              onClick={() => setMode((m) => (m === 'source' ? 'preview' : 'source'))}
              title={mode === 'preview' ? '切换到源码（⌘E）' : '切换到预览（⌘E）'}
              aria-label={mode === 'preview' ? '切换到源码' : '切换到预览'}
            >
              {mode === 'preview' ? <CodeIcon /> : <EyeIcon />}
            </button>
            <span className="save-state">
              {saveState === 'saving' && <span className="saving">保存中…</span>}
              {saveState === 'saved' && <span className="saved">已自动保存</span>}
              {saveState === 'error' && <span className="failed">保存失败</span>}
            </span>
          </div>

          {error && <div className="notice">{error}</div>}

          {mode === 'source' ? (
            <textarea
              ref={textareaRef}
              className="md-editor"
              value={draft}
              onChange={(e) => {
                const next = e.target.value
                draftRef.current = next
                setDraft(next)
              }}
              spellCheck={false}
            />
          ) : (
            <div
              className="doc-scroll"
              onDoubleClick={() => setMode('source')}
              title="双击进入源码编辑"
            >
              {loading && <div className="loading">读取中…</div>}
              {!loading && (
                <article className="markdown-body">
                  <Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown>
                </article>
              )}
            </div>
          )}
        </section>

        {showTerminal && (
          <TerminalPane target={terminalTarget} fontFamily={fontFamily} fontSize={fontSize} />
        )}
      </div>
    </div>
  )
}
