import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type ContextPayload } from '../lib/api'
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

/** 终端图标：一个提示符窗口 */
function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="7 10 10 12.5 7 15" />
      <line x1="12.5" y1="15" x2="17" y2="15" />
    </svg>
  )
}

/** 信息浮窗图标：带侧栏的面板 */
function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9.5" y1="9" x2="9.5" y2="20" />
    </svg>
  )
}

/** 复制图标：两个叠起来的方框 */
function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

/** 复制成功的短暂反馈：换成勾 */
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 12.5 9.5 18 20 6.5" />
    </svg>
  )
}

/**
 * 浮窗里的一段：标题行点一下收起/展开，右边跟一个计数。
 * 默认展开——浮窗的作用就是一眼看到东西，收起是内容多了之后的减法。
 */
function InfoBlock({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="info-block">
      <button className="info-block-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="info-block-label">{label}</span>
        {count !== undefined && <span className="info-count">· {count}</span>}
        <svg
          className={`info-caret${open ? ' open' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {open && <div className="info-block-body">{children}</div>}
    </section>
  )
}

/**
 * 长文本一律占一行：放不下就截断成省略号，完整内容挂在 title 上，
 * 悬停时由系统提示给出（原生行为，够用且不额外占地方）。
 * 传了 href 就当外链渲染（新窗口打开），传了 onClick 就是可点的一行。
 */
function OneLine(props: {
  text: string
  className: string
  title?: string
  href?: string
  disabled?: boolean
  onClick?: () => void
}) {
  const cls = `line ${props.className}${props.disabled ? ' disabled' : ''}`

  if (props.href) {
    return (
      <a className={cls} href={props.href} target="_blank" rel="noreferrer" title={props.title}>
        {props.text}
      </a>
    )
  }

  const clickable = !!props.onClick && !props.disabled
  return (
    <div
      className={cls}
      title={props.title}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? props.onClick : undefined}
      onKeyDown={(e) => {
        if (clickable && e.key === 'Enter') props.onClick?.()
      }}
    >
      {props.text}
    </div>
  )
}

/**
 * 头部浮窗：需求的工作区与链接。
 *
 * 数据全部来自详情页已经拉过的两份载荷（列表里的 Requirement + /api/context），
 * 所以打开它不产生新请求。工作区那段只有服务端知道——归属存在 sqlite 里。
 */
function InfoPanel({ req, ctx }: { req: Requirement; ctx: ContextPayload | null }) {
  const [copied, setCopied] = useState('')
  const worktrees = ctx?.worktrees ?? []

  /** 复制到剪贴板。失败就什么也不说，别谎报"已复制" */
  function copy(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(text)
        setTimeout(() => setCopied(''), 1200)
      })
      .catch(() => {})
  }

  /** 复制按钮：图标按钮，复制成功后短暂变勾 */
  const copyButton = (text: string, label: string) => (
    <button
      className="info-action"
      onClick={() => copy(text)}
      title={`复制${label}`}
      aria-label={`复制${label}`}
    >
      {copied === text ? <CheckIcon /> : <CopyIcon />}
    </button>
  )

  const groups = [
    { title: '飞书任务', items: req.feishuTaskLinks.map((url) => ({ label: url, url })) },
    { title: '代码链接', items: req.codeLinks.map((url) => ({ label: url, url })) },
    { title: '扩展链接', items: req.extLinks.map((l) => ({ label: l.detail, url: l.url })) },
  ].filter((g) => g.items.length)

  // md 里的那段（解析器把「链接」「相关链接」「文档索引」都收了进来）。
  // 但「文档索引」常常只是一张文件/内容表——那是文档清单，文档标签栏已经有了，
  // 不该冒充链接：整段里一个 http 都没有就不展示。
  const mdLinks = /https?:\/\//i.test(req.links) ? req.links : ''

  return (
    <div className="info-panel" role="dialog" aria-label="需求信息与链接">
      <InfoBlock label="目录">
        <div className="info-row">
          <OneLine
            className="info-path mono"
            text={req.path}
            title={req.path}
            onClick={() => void api.open(req.slug, req.project).catch(() => {})}
          />
          {copyButton(req.path, '路径')}
        </div>
      </InfoBlock>

      {/* 没有工作区就整段不出现——空列表本身不携带信息 */}
      {worktrees.length > 0 && (
        <InfoBlock label="worktree" count={worktrees.length}>
          {worktrees.map((w) => (
            <div className="wt" key={w.id}>
              <div className="wt-head">
                <span className="v mono">{w.repo}</span>
                {w.orphan && <span className="wt-orphan">目录已失联</span>}
                <span className="spacer" />
                {copyButton(w.path, '路径')}
              </div>
              <div className="wt-meta">
                <OneLine className="mono" text={w.branch} title={w.branch} />
              </div>
              <OneLine
                className="info-path mono"
                text={w.path}
                title={w.orphan ? `目录已失联：${w.path}` : w.path}
                disabled={w.orphan}
                onClick={() => void api.openWorktree(w.id).catch(() => {})}
              />
            </div>
          ))}
        </InfoBlock>
      )}

      {(groups.length > 0 || mdLinks) && (
        <InfoBlock
          label="链接"
          count={groups.reduce((n, g) => n + g.items.length, 0) + (mdLinks ? 1 : 0)}
        >
          {groups.map((g) => (
            <div className="info-row" key={g.title}>
              <span className="k">{g.title}</span>
              <span className="v">
                {g.items.map((it) => (
                  <OneLine
                    key={it.url}
                    className="info-link"
                    text={it.label}
                    title={it.url}
                    href={it.url}
                  />
                ))}
              </span>
            </div>
          ))}
          {mdLinks && (
            <article className="markdown-body info-md">
              {/* 外链必须带 target：不带的话会在应用窗口里直接跳走 */}
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{ a: (props) => <a href={props.href} target="_blank" rel="noreferrer">{props.children}</a> }}
              >
                {mdLinks}
              </Markdown>
            </article>
          )}
        </InfoBlock>
      )}
    </div>
  )
}

/**
 * 详情页头部的下拉选择（优先级 / 状态）。
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
