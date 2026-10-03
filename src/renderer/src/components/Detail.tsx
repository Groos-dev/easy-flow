import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import type { ContextPayload, Requirement } from '../lib/types'
import InfoPanel from './InfoPanel'
import SelectMenu from './SelectMenu'
import TerminalPane from './TerminalPane'
import { CodeIcon, InfoIcon, TerminalIcon } from './icons'

/**
 * 详情页的两种挂载点：
 *   requirement —— 需求（含优先级/状态控制）
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
  /** 由服务端下发的状态枚举，避免这里再维护一份 */
  statuses: string[]
  priorities: string[]
  fontFamily: string
  fontSize: number
  onBack: () => void
  /** 改了状态后通知看板刷新 */
  onUpdated: () => void
}

const PRIORITY_DESC: Record<string, string> = {
  p0: '重要且紧急',
  p1: '重要不紧急',
  p2: '紧急不重要',
  p3: '都不',
}

type ViewMode = 'preview' | 'source'

/** 停止输入后多久落盘 */
const AUTOSAVE_DELAY = 600

export default function Detail({
  target,
  statuses,
  priorities,
  fontFamily,
  fontSize,
  onBack,
  onUpdated,
}: Props) {
  const req = target.req
  const isProject = target.kind === 'project'
  const terminalTarget = isProject
    ? { project: target.project }
    : { project: target.project, slug: target.slug! }
  const [docs, setDocs] = useState<string[]>([])
  /** 当前打开的文档；空串表示还没定（列表在异步加载）或这个挂载点没有文档 */
  const [activeDoc, setActiveDoc] = useState('')
  /** draft 是唯一事实源：预览渲染它、源码编辑它、自动保存提交它 */
  const [draft, setDraft] = useState('')
  /** 上次成功保存的内容，用来判断是否真有改动 */
  const savedRef = useRef('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [mode, setMode] = useState<ViewMode>('preview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showTerminal, setShowTerminal] = useState(true)
  /** 需求上下文（含工作区列表）。项目页用不到，保持 null */
  const [ctx, setCtx] = useState<ContextPayload | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const infoRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 文档加载序号：快速切标签时丢弃过期响应 */
  const docSeq = useRef(0)
  /** 保存用的最新值，避免防抖回调闭包过期 */
  const draftRef = useRef('')

  useEffect(() => {
    let alive = true
    if (isProject) setCtx(null)
    const load = isProject
      ? api.projectConvention(target.project).then((r) => (r.content ? ['AGENTS.md'] : []))
      : api
          .context(target.slug!, target.project)
          .then((c) => {
            // 浮窗要用工作区与链接，顺手存下这次载荷，免得再发一次请求
            if (alive) setCtx(c)
            // AGENTS.md / CLAUDE.md 是给 agent 读的指令文件，不是需求文档，不进标签栏
            return c.requirement.docs
              .map((d) => d.name)
              .filter((n) => !/^(AGENTS|CLAUDE)\.md$/i.test(n.split('/').pop() ?? ''))
          })
    void load
      .then((names) => {
        if (!alive) return
        const list = [...new Set(names as string[])]
        setDocs(list)
        // 换了挂载点、或原先打开的那篇不在了，就落到第一篇
        setActiveDoc((cur) => (list.includes(cur) ? cur : (list[0] ?? '')))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [target.project, target.slug, isProject])

  const loadDoc = useCallback(async () => {
    // 需求页在文档列表到位前（或这个需求没有文档）没有可打开的文档
    if (!isProject && !activeDoc) {
      setLoading(false)
      setDraft('')
      draftRef.current = ''
      savedRef.current = ''
      return
    }
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

  // 点浮窗外面关掉它。Esc 不在这里处理——统一走下面那个键盘监听，
  // 否则会与"Esc 返回看板"各关各的
  useEffect(() => {
    if (!infoOpen) return
    const onDown = (e: MouseEvent) => {
      if (!infoRef.current?.contains(e.target as Node)) setInfoOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [infoOpen])

  // ⌘E 在预览/源码间切换；⌘S 立即保存；Esc 返回看板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) {
        // 捕获阶段：终端的 xterm 会在自己身上吃掉按键并阻止冒泡，冒泡阶段轮不到这里。
        // 但终端里的 Esc 归终端管（claude / vim 都要用），焦点在终端时不抢。
        const inTerminal = e.target instanceof Element && e.target.closest('.terminal-pane')
        if (e.key === 'Escape' && !inTerminal) {
          // 浮窗开着时先关浮窗，不然一次 Esc 既关浮窗又退出详情
          if (infoOpen) {
            setInfoOpen(false)
            return
          }
          onBack()
        }
        return
      }
      // ⌘[ 是 macOS 的「返回」：终端里 Esc 归 claude / vim，用这个随时退
      if (e.key === '[') {
        e.preventDefault()
        onBack()
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
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [flushSave, onBack, infoOpen])

  // 源码模式进入时聚焦；预览模式下双击进入编辑
  useEffect(() => {
    if (mode === 'source' && textareaRef.current) {
      const el = textareaRef.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [mode])

  async function apply(patch: { status?: string; priority?: string }) {
    if (!req) return
    setBusy(true)
    setError('')
    try {
      await api.update(req.slug, patch, target.project)
      onUpdated()
    } catch (e) {
      // 失败必须让用户看到：之前只有 finally，失败会变成 unhandled rejection
      setError(`更新失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // 文档列表：只看需求根目录与 docs/ 下的文档。
  // tasks/ 之类的历史目录不进标签栏（同名文件多，且已不是主结构）。
  const docTabs = useMemo(() => {
    const list = docs.filter((n) => !n.includes('/') || n.startsWith('docs/'))

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
        <button className="icon-btn" onClick={onBack} title="返回看板（Esc / ⌘[）">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <div className="detail-title">
          <h1>{target.title}</h1>
        </div>
        <span className="spacer" />
        {/* 需求页不放开目录按钮：那个目录在浮窗里可点（点路径即在访达里打开） */}
        {isProject && (
          <button className="btn" onClick={() => void api.openProject(target.project).catch(() => {})}>
            打开目录
          </button>
        )}
        {!isProject && req && (
          <div className="info-menu" ref={infoRef}>
            <button
              className={`icon-btn${infoOpen ? ' on' : ''}`}
              onClick={() => setInfoOpen((v) => !v)}
              title="需求信息与链接"
              aria-haspopup="dialog"
              aria-expanded={infoOpen}
            >
              <InfoIcon />
            </button>
            {infoOpen && <InfoPanel req={req} ctx={ctx} />}
          </div>
        )}
        <button
          className={`icon-btn${showTerminal ? ' on' : ''}`}
          onClick={() => setShowTerminal((v) => !v)}
          title={showTerminal ? '收起终端' : '展开终端'}
          aria-label={showTerminal ? '收起终端' : '展开终端'}
        >
          <TerminalIcon />
        </button>
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
          value={req.status}
          placeholder="未设状态"
          disabled={busy}
          options={statuses.map((s) => ({ value: s, label: s }))}
          onChange={(s) => void apply({ status: s })}
        />
      </div>
      )}

      <div className={`detail-body${showTerminal ? '' : ' no-terminal'}`}>
        <section className="doc-pane">
          <div className="doc-bar">
            <div className="doc-tabs">
              {docTabs.length === 0 && <span className="doc-empty">暂无文档</span>}
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
            </div>
            {/* 保存状态在左、开关在右：开关是常驻的，让它贴着右上角，
                保存提示出现/消失就不会把它推来推去 */}
            <span className="save-state">
              {saveState === 'saving' && <span className="saving">保存中…</span>}
              {saveState === 'saved' && <span className="saved">已自动保存</span>}
              {saveState === 'error' && <span className="failed">保存失败</span>}
            </span>
            <button
              className="mode-btn"
              onClick={() => setMode((m) => (m === 'source' ? 'preview' : 'source'))}
              title={mode === 'preview' ? '切换到源码（⌘E）' : '切换到预览（⌘E）'}
              aria-label={mode === 'preview' ? '切换到源码' : '切换到预览'}
            >
              <CodeIcon />
            </button>
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

        {/* 一直挂着：收起只是把它藏起来（.no-terminal 里 display:none），
            PTY 会话与滚屏内容都留着，再展开就是原来的终端 */}
        <TerminalPane target={terminalTarget} fontFamily={fontFamily} fontSize={fontSize} />
      </div>
    </div>
  )
}
