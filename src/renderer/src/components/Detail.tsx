import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { isComposing, isEditableTarget, shortcut, shortcutLabel } from '../lib/keys'
import { type ContextPayload, type Requirement, type Todo } from '../lib/types'
import InfoPanel from './InfoPanel'
import MarkdownEditor from './MarkdownEditor'
import TodoPanel from './TodoPanel'
import { InfoIcon } from './icons'

/**
 * 详情页的三种挂载点：
 *   requirement —— 需求（一份 md 标签栏 + 只读的信息浮窗）
 *   project     —— 项目（展示并编辑项目总规范）
 *   todo        —— 待办（一份 md；内容源在文件里，编辑即写回）
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
  onBack: () => void
  /** 需求页的「关联待办」块：点一条即在详情页打开它 */
  onOpenTodo: (id: string) => void
  /** 待办页浮窗的「需求」段：点一下跳到它挂的需求 */
  onOpenRequirement: (project: string, slug: string) => void
  projectRoot?: string
}

/** 停止输入后多久落盘 */
const AUTOSAVE_DELAY = 600

export default function Detail({
  target,
  onBack,
  onOpenTodo,
  onOpenRequirement,
  projectRoot,
}: Props) {
  const req = target.req
  const todo = target.todo
  const isProject = target.kind === 'project'
  const isTodo = target.kind === 'todo'
  const [docs, setDocs] = useState<string[]>([])
  /** 当前打开的文档；空串表示还没定（列表在异步加载）或这个挂载点没有文档 */
  const [activeDoc, setActiveDoc] = useState('')
  /** draft 是唯一事实源：编辑器渲染它、自动保存提交它 */
  const [draft, setDraft] = useState('')
  /** 上次成功保存的内容，用来判断是否真有改动 */
  const savedRef = useRef('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 需求上下文（含工作区列表）。项目页用不到，保持 null */
  const [ctx, setCtx] = useState<ContextPayload | null>(null)
  /** 待办挂的需求：待办上只有 id，标题与跳转目标要按它换回来 */
  const [todoReq, setTodoReq] = useState<Requirement | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [hint, setHint] = useState('')
  // ⌘⇧N 每按一次加一，让「新建会话」表单展开
  const [launchSignal, setLaunchSignal] = useState(0)
  const infoRef = useRef<HTMLDivElement>(null)
  const infoBtnRef = useRef<HTMLButtonElement>(null)
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
    // 换挂载点就收掉浮窗：详情页之间是同一个组件实例，状态会跟着走，
    // 不然从需求点进待办后，第一下 Esc 会被"关掉浮窗"吃掉
    setInfoOpen(false)
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

  // 待办挂的需求：查不到（需求被删了）就只显示 id，不给一个点不开的链接
  useEffect(() => {
    const id = todo?.requirementId
    setTodoReq(null)
    if (!id) return
    let alive = true
    api
      .requirementById(id)
      .then((r) => {
        if (alive) setTodoReq(r)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [todo?.requirementId])

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
      setSaveState('idle')
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

  const goTab = useCallback(
    (index: number) => {
      const tab = docTabs[index]
      if (tab) setActiveDoc(tab.name)
    },
    [docTabs],
  )

  const stepTab = useCallback(
    (delta: 1 | -1) => {
      if (!docTabs.length) return
      const at = docTabs.findIndex((t) => t.name === activeDoc)
      const index = ((at < 0 ? 0 : at) + delta + docTabs.length) % docTabs.length
      setActiveDoc(docTabs[index].name)
    },
    [docTabs, activeDoc],
  )

  function openTargetDir() {
    if (isProject) {
      void api.openProject(target.project).catch((e: Error) => setError(e.message))
    } else if (req) {
      void api.open(req.slug, req.project).catch((e: Error) => setError(e.message))
    }
  }

  // 待办是文件，取它所在的目录
  function copyTargetPath() {
    const path = req?.path || (todo ? todo.path.replace(/\/[^/]+$/, '') : projectRoot)
    if (!path) return
    void navigator.clipboard
      ?.writeText(path)
      .then(() => setHint(`已复制：${path}`))
      .catch(() => {})
  }

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(''), 1600)
    return () => clearTimeout(timer)
  }, [hint])

  // 捕获阶段先于编辑器拿到 Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e)) return

      // 不 preventDefault：编辑器可以先用 Esc（例如关补全）
      if (shortcut(e, 'detail.close')) {
        // 焦点在新建会话表单里时这一下归表单：先收表单，再收浮窗
        if ((e.target as HTMLElement | null)?.closest?.('.new-sess')) return
        if (infoOpen) {
          setInfoOpen(false)
          // 浮窗是被键盘关掉的，焦点别掉到 body 上
          requestAnimationFrame(() => infoBtnRef.current?.focus())
          return
        }
        onBack()
        return
      }

      // 单键 i：编辑器里要能正常打字
      if (shortcut(e, 'detail.info') && !isEditableTarget(e.target)) {
        e.preventDefault()
        setInfoOpen((v) => !v)
        return
      }

      if (shortcut(e, 'detail.back')) {
        e.preventDefault()
        onBack()
        return
      }
      if (shortcut(e, 'detail.tab-prev')) {
        e.preventDefault()
        stepTab(-1)
        return
      }
      if (shortcut(e, 'detail.tab-next')) {
        e.preventDefault()
        stepTab(1)
        return
      }
      if (shortcut(e, 'detail.tab-n')) {
        e.preventDefault()
        goTab(Number(e.key) - 1)
        return
      }
      if (shortcut(e, 'detail.save')) {
        e.preventDefault()
        if (saveTimer.current) clearTimeout(saveTimer.current)
        void flushSave()
        return
      }
      if (shortcut(e, 'detail.open-dir')) {
        e.preventDefault()
        openTargetDir()
        return
      }
      if (shortcut(e, 'detail.copy-path')) {
        e.preventDefault()
        copyTargetPath()
        return
      }
      if (shortcut(e, 'detail.new-session') && req) {
        e.preventDefault()
        setInfoOpen(true)
        setLaunchSignal((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [flushSave, onBack, infoOpen, goTab, stepTab, req, todo, isProject, projectRoot, target.project])

  /** 编辑器改一次就收一次：draft 仍是唯一事实源 */
  const onDraftChange = useCallback((next: string) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  return (
    <div className="detail-page">
      <header className="detail-head">
        <button
          className="icon-btn"
          onClick={onBack}
          title={`返回（${shortcutLabel('detail.close')} / ${shortcutLabel('detail.back')}）`}
        >
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
          <button
            className="btn"
            title={`在访达打开项目目录（${shortcutLabel('detail.open-dir')}）`}
            onClick={() => void api.openProject(target.project).catch(() => {})}
          >
            打开目录
          </button>
        )}
        {!isProject && (req || todo) && (
          <div className="info-menu" ref={infoRef}>
            <button
              className={`icon-btn${infoOpen ? ' on' : ''}`}
              ref={infoBtnRef}
              onClick={() => setInfoOpen((v) => !v)}
              title={`${req ? '需求信息与链接' : '待办信息'}（${shortcutLabel('detail.info')}）`}
              aria-haspopup="dialog"
              aria-expanded={infoOpen}
            >
              <InfoIcon />
            </button>
            {infoOpen && req && (
              <InfoPanel
                req={req}
                ctx={ctx}
                onOpenTodo={onOpenTodo}
                launchSignal={launchSignal}
              />
            )}
            {infoOpen && !req && todo && (
              <TodoPanel todo={todo} req={todoReq} onOpenRequirement={onOpenRequirement} />
            )}
          </div>
        )}
      </header>

      {hint && <div className="notice ok">{hint}</div>}

      <div className="detail-body">
        <section className="doc-pane">
          <div className="doc-bar">
            <div className="doc-tabs">
              {docTabs.map((tab, i) => (
                <button
                  key={tab.name}
                  className={`doc-tab${tab.name === activeDoc ? ' active' : ''}`}
                  onClick={() => setActiveDoc(tab.name)}
                  title={i < 9 ? `${tab.name}（⌘${i + 1}）` : tab.name}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {/* 只在「正在存」和「存不下」时出现；存好了不必报，版面也别被推来推去 */}
            <span className="save-state">
              {saveState === 'saving' && <span className="saving">保存中…</span>}
              {saveState === 'error' && <span className="failed">保存失败</span>}
            </span>
          </div>

          {error && <div className="notice">{error}</div>}

          {loading ? (
            <div className="loading">读取中…</div>
          ) : (
            <MarkdownEditor value={draft} onChange={onDraftChange} />
          )}
        </section>
      </div>
    </div>
  )
}
