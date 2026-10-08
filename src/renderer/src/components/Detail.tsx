import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import { TODO_STATUS_LABEL, type ContextPayload, type Requirement, type Todo } from '../lib/types'
import InfoPanel from './InfoPanel'
import SelectMenu from './SelectMenu'
import { CodeIcon, InfoIcon } from './icons'

/**
 * 详情页的三种挂载点：
 *   requirement —— 需求（含优先级/状态控制）
 *   project     —— 项目（展示并编辑项目总规范）
 *   todo        —— 待办（状态控制 + 一份 md；内容源在文件里，编辑即写回）
 */
export interface DocTarget {
  kind: 'requirement' | 'project' | 'todo'
  project: string
  /** 仅 kind === 'requirement' 时有值 */
  slug?: string
  title: string
  /** 仅 requirement 有：用于头部展示与编辑 */
  req?: Requirement
  /** 仅 todo 有 */
  todo?: Todo
}

interface Props {
  target: DocTarget
  /** 由服务端下发的状态枚举，避免这里再维护一份 */
  statuses: string[]
  priorities: string[]
  /** 待办的状态枚举，同样是服务端下发的 */
  todoStatuses: string[]
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

export default function Detail({ target, statuses, priorities, todoStatuses, onBack, onUpdated }: Props) {
  const req = target.req
  const todo = target.todo
  const isProject = target.kind === 'project'
  const isTodo = target.kind === 'todo'
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
  /** 项目页的规范原文。文档列表已经拿到，正文复用它——同一个接口不该拉两次 */
  const projectDoc = useRef<Promise<string> | null>(null)

  useEffect(() => {
    let alive = true
    if (isProject) setCtx(null)
    // 项目页的规范原文在这里先发起，文档列表与正文共用这一次
    const convention = isProject
      ? api.projectConvention(target.project).then((r) => r.content ?? '')
      : null
    projectDoc.current = convention
    // 待办只有一份 md，文件名就是它的 id；没有标签栏可切，列表是固定的
    const load = convention
      ? convention.then((content) => (content ? ['AGENTS.md'] : []))
      : isTodo
        ? Promise.resolve([`${todo!.id}.md`])
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
  }, [target.project, target.slug, isProject, isTodo, todo?.id])

  /** 项目页的规范原文：正常走上面那次请求，挂载顺序有变时兜一次新请求 */
  function projectContent(): Promise<string> {
    return projectDoc.current ?? api.projectConvention(target.project).then((r) => r.content ?? '')
  }

  const loadDoc = useCallback(async () => {
    // 需求页在文档列表到位前（或这个需求没有文档）没有可打开的文档
    if (!isProject && !isTodo && !activeDoc) {
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
        ? { content: await projectContent() }
        : isTodo
          ? await api.todoDoc(todo!.id)
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
  }, [target.project, target.slug, activeDoc, isProject, isTodo, todo?.id])

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
      else if (isTodo) await api.saveTodoDoc(todo!.id, content)
      else await api.saveDoc(target.slug!, activeDoc, content, target.project)
      savedRef.current = content
      setSaveState('saved')
    } catch (e) {
      setSaveState('error')
      setError(`自动保存失败：${(e as Error).message}`)
    }
  }, [target.project, target.slug, activeDoc, isProject, isTodo, todo?.id])

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
        if (e.key === 'Escape') {
          // 浮窗开着时先关浮窗，不然一次 Esc 既关浮窗又退出详情
          if (infoOpen) {
            setInfoOpen(false)
            return
          }
          onBack()
        }
        return
      }
      // ⌘[ 是 macOS 的「返回」
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
    setBusy(true)
    setError('')
    try {
      if (isTodo) await api.updateTodo(todo!.id, patch)
      else if (req) await api.update(req.slug, patch, target.project)
      else return
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
        {isTodo && (
          <button className="btn" onClick={() => void api.openTodo(todo!.id).catch(() => {})}>
            打开 md
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

      {isTodo && todo && (
        <div className="detail-controls">
          <SelectMenu
            value={todo.status}
            placeholder="未设状态"
            disabled={busy}
            options={todoStatuses.map((s) => ({ value: s, label: TODO_STATUS_LABEL[s] ?? s }))}
            onChange={(s) => void apply({ status: s })}
          />
        </div>
      )}
      {isTodo && todo && <TodoMeta todo={todo} />}

      <div className="detail-body">
        <section className="doc-pane">
          <div className="doc-bar">
            <div className="doc-tabs">
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
      </div>
    </div>
  )
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="meta-row">
      <span className="meta-key">{label}</span>
      <span className="meta-value">{children}</span>
    </div>
  )
}

/**
 * 待办的元数据：只归库的那些字段。内容（标题、摘要、进度）在 md 里，
 * 详情页正文就是那份 md，这里只列身份与来路——接手时要知道这条是从哪来的。
 */
function TodoMeta({ todo }: { todo: Todo }) {
  const source = [todo.source, todo.channel].filter(Boolean).join(' · ')
  return (
    <div className="todo-meta">
      <MetaRow label="来源">{source || '（未记）'}</MetaRow>
      {todo.origin && <MetaRow label="来源人">{todo.origin}</MetaRow>}
      {todo.chat && <MetaRow label="上下文">{todo.chat}</MetaRow>}
      {todo.session && (
        <MetaRow label="会话">
          <span className="mono">{todo.session}</span>
        </MetaRow>
      )}
      {todo.ref && (
        <MetaRow label="去重键">
          <span className="mono">{todo.ref}</span>
        </MetaRow>
      )}
      {todo.happened && <MetaRow label="源事件时间">{todo.happened}</MetaRow>}
      {todo.link && (
        <MetaRow label="链接">
          <a href={todo.link} target="_blank" rel="noreferrer">
            {todo.link}
          </a>
        </MetaRow>
      )}
      <MetaRow label="时间线">{`入库 ${todo.created} · 更新 ${todo.updated}`}</MetaRow>
    </div>
  )
}
