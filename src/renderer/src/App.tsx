import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { api } from './lib/api'
import { DONE_STATUS, childStatsOf, childrenOf } from './lib/children'
import type { ChildStat, NextUpItem, Project, Requirement, Session, Status, Todo, TodoStatus } from './lib/types'
import BoardSwitcher, { type BoardView } from './components/BoardSwitcher'
import MindMap from './components/MindMap'
import Card from './components/Card'
import NextUp from './components/NextUp'
import Detail from './components/Detail'
import SearchPanel from './components/SearchPanel'
import Settings from './components/Settings'
import TodoBoard from './components/TodoBoard'

/** 空列的一句话：一个「—」说不出这一列是干什么的。认不出的状态回落到通用文案 */
const COLUMN_HINT: Record<string, string> = {
  澄清: '没有待澄清的需求',
  执行中: '没有正在执行的需求',
  Review: '没有等待评审的需求',
  已完成: '还没有完成的需求',
}

interface BoardColumnProps {
  status: Status
  items: Requirement[]
  /** 需求 id → 它名下的会话。卡片角标按需求取用（每个会话各挂一个） */
  sessionsByReq: Map<string, Session[]>
  /** 父需求 id → 子需求完成度。没有子需求的需求不在表里 */
  childStats: Map<string, ChildStat>
  /** 父需求 id → 直接子需求。铺开的父卡片靠它把子需求列出来 */
  childrenByParent: Map<string, Requirement[]>
  /** 点父卡片上的子需求：滚到它在版面上的卡片 */
  onJumpChild: (slug: string) => void
  /** 刚跳过去的那条，闪一下 */
  flashSlug: string | null
  onOpen: (slug: string) => void
  isOver: boolean
  /** 收成窄条（只有「已完成」列会） */
  collapsed: boolean
  onToggleCollapsed: () => void
}

function ColumnView({
  status,
  items,
  sessionsByReq,
  childStats,
  childrenByParent,
  onJumpChild,
  flashSlug,
  onOpen,
  isOver,
  collapsed,
  onToggleCollapsed,
}: BoardColumnProps) {
  const { setNodeRef } = useDroppable({ id: status, data: { status } })

  if (collapsed) {
    // 窄条也接拖拽：把卡片拖到它上面就是移进这一列
    return (
      <div
        ref={setNodeRef}
        className={`column collapsed${isOver ? ' over' : ''}`}
        onClick={onToggleCollapsed}
        title={`展开「${status}」（${items.length}）`}
      >
        <span className="column-fold-name">{status}</span>
        <span className="n">{items.length}</span>
      </div>
    )
  }

  // 「已完成」列的列头整行是收起入口：与折叠条对称，不必去找那个小图标
  const foldable = status === DONE_STATUS

  return (
    <div ref={setNodeRef} className={`column${isOver ? ' over' : ''}`}>
      <div
        className={`column-head${foldable ? ' foldable' : ''}`}
        onClick={foldable ? onToggleCollapsed : undefined}
        title={foldable ? '收成窄条' : undefined}
      >
        <span>{status}</span>
        <span className="n">{items.length}</span>
        {foldable && (
          <svg className="column-fold-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="13 6 19 12 13 18" />
          </svg>
        )}
      </div>
      <div className="column-body">
        {items.length === 0 ? (
          <div className="empty">{COLUMN_HINT[status] ?? '没有需求'}</div>
        ) : (
          items.map((r) => (
            <Card
              key={r.slug}
              req={r}
              sessions={sessionsByReq.get(r.id) ?? []}
              childStat={childStats.get(r.id)}
              kids={childrenByParent.get(r.id)}
              onJumpChild={onJumpChild}
              flash={flashSlug === r.slug}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** dnd-kit 的 data 是 unknown，这里收窄一次 */
function statusOf(over: DragOverEvent['over']): Status | undefined {
  const data = over?.data.current as { status?: Status } | undefined
  return data?.status
}

/** 同列内按优先级排：p0 在前，没设优先级的排最后 */
const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

/**
 * 会话状态的轮询间隔。对齐 clawd 的 1.5s：细粒度 activity（思考 / 干活）要跟着每次工具调用动，
 * 20s 一轮就只能看见它在跑，看不出在干什么。接口只读、单次实测 8~10ms，这个频率不占什么。
 */
const SESSION_POLL_MS = 1_500

export default function App() {
  const [statuses, setStatuses] = useState<Status[]>([])
  /** 当前看板：需求与待办是平级的两个看板 */
  const [view, setView] = useState<BoardView>('req')
  /** 当前项目：看板数据按项目隔离 */
  const [project, setProject] = useState('')
  /** 当前项目显示名，取自项目根 AGENTS.md 的 frontmatter；缺省是目录名 */
  const [projectName, setProjectName] = useState('')
  /** 项目列表：顶栏的 chip 行用它。agent 在文件系统里建完目录后靠刷新带出来 */
  const [projects, setProjects] = useState<Project[]>([])
  /** 「已完成」列是否展开。默认收成窄条：历史只增不减，全铺开会把活跃三列挤窄 */
  const [doneOpen, setDoneOpen] = useState(false)
  /** 从父卡片点过来的那条子需求：等它在版面上出现再滚过去 */
  const [pendingJump, setPendingJump] = useState<string | null>(null)
  /** 刚跳到的卡片：闪一下，好在一屏卡片里认出落点 */
  const [flashSlug, setFlashSlug] = useState<string | null>(null)
  /** 需求板块里的视图：看板（默认）/ 下一步 / 导图；待办板块下不适用 */
  const [reqView, setReqView] = useState<'board' | 'next' | 'map'>('board')
  /** 详情页挂载点：需求或项目。slugs 用 'project:<slug>' 区分 */
  const [detail, setDetail] = useState<{ project: string; slug: string | null } | null>(null)
  const [priorities, setPriorities] = useState<string[]>([])
  const [items, setItems] = useState<Requirement[]>([])
  /** 全部会话（含实时状态）。卡片角标与详情页的「会话」块共用 */
  const [sessions, setSessions] = useState<Session[]>([])
  /** 「下一步」的排名（服务端算好，每条带理由），只在「下一步」视图里读 */
  const [nextItems, setNextItems] = useState<NextUpItem[]>([])
  /** 上次算排名失败的原话；空串表示最近一次是成功的 */
  const [nextError, setNextError] = useState('')
  /** 待办：全局的，不分项目 */
  const [todos, setTodos] = useState<Todo[]>([])
  const [todoStatuses, setTodoStatuses] = useState<string[]>([])
  /** 打开的待办详情。只存 id，对象从 todos 里取——改完状态详情页跟着变 */
  const [todoId, setTodoId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  /** mini 面板可能点开非当前项目的需求，这里单独持有 */
  const [crossReq, setCrossReq] = useState<Requirement | null>(null)
  const [overStatus, setOverStatus] = useState<Status | null>(null)
  /**
   * ⌘K 搜索。「面板开着」与「筛选词还在」是两件事：关掉面板筛选留着，
   * 否则刚搜出来的那几张卡在眼前一闪就没了，看板与导图上的过滤等于白做。
   */
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** 命中集合；null 表示没在筛。看板的过滤与导图的 hits 共用它 */
  const [hits, setHits] = useState<Set<string> | null>(null)
  /** 正在等服务端返回：用来区分「还没查」与「查了没有」 */
  const [searching, setSearching] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  /** 待打开的需求只取一次（主窗口刚重建时的那份交接） */
  const tookPending = useRef(false)

  /**
   * 打开某条需求的详情页。mini 面板与详情页里的跳转都走这里：
   * 不在当前项目的需求要单独取，否则详情页会静默退回看板。
   */
  const openRequirement = useCallback(
    (proj: string, slug: string) => {
      setDetail({ project: proj, slug })
      // 从别处点需求就是回到需求看板，别把详情页叠在待办看板上
      setView('req')
      // 待办详情上也有跳需求的入口：那一层要摘掉，否则详情页被它盖着
      setTodoId(null)
      const local = items.find((r) => r.slug === slug && r.project === proj)
      setCrossReq(local ?? null)
      if (!local) {
        void api
          .context(slug, proj)
          .then((c) => setCrossReq(c.requirement))
          .catch((e: Error) => setError(e.message))
      }
    },
    [items],
  )

  // mini 面板点「详情」会发事件过来。窗口刚重建时事件早于订阅，
  // 所以再主动取一次待打开的需求兜底
  useEffect(() => {
    const off = window.easyFlow?.onOpenRequirement?.((p) => openRequirement(p.project, p.slug))
    if (!tookPending.current) {
      tookPending.current = true
      void window.easyFlow?.takePendingOpen?.().then((p) => {
        if (p) openRequirement(p.project, p.slug)
      })
    }
    return () => off?.()
  }, [openRequirement])

  /**
   * 搜索面板只在看板与导图上开（它筛的就是这两处）。详情页、设置页、待办板，
   * 以及不认筛选的「下一步」都不给这个入口——从那些地方开出来，人看到的是一个
   * 筛掉了卡片的界面自己却不在上面，不如不开。
   */
  const onBoard = !showSettings && !detail && !todoId && view === 'req' && reqView !== 'next'

  // 窗口级快捷键。⌘, 打开设置——Electron 里由应用菜单的加速键触发（见 main/registerMenu），
  // 浏览器开发时没有菜单，这里补一个键盘监听；⌘K 开合搜索面板。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      } else if (e.key === 'k' && onBoard) {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    const off = window.easyFlow?.onOpenSettings?.(() => setShowSettings(true))
    return () => {
      window.removeEventListener('keydown', onKey)
      off?.()
    }
  }, [onBoard])

  /**
   * 搜索交给服务端：它连文档正文一起搜（见 db.search），渲染层不做遍历。
   * 防抖只是别让每个按键都发一次请求；换了项目就重查，命中集合是按项目算的。
   */
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const timer = setTimeout(() => {
      void api
        .search(q)
        .then((r) => {
          if (alive) setHits(new Set(r.requirements.map((x) => x.slug)))
        })
        // 搜挂了不该把看板一起弄坏：维持上一次的命中集合，界面照常能用
        .catch(() => {})
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, project])

  const load = useCallback(async () => {
    try {
      const data = await api.list()
      setItems(data.requirements)
      setStatuses(data.statuses)
      setPriorities(data.priorities)
      setProject(data.project)
      setProjectName(data.projectName)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTodos = useCallback(async () => {
    try {
      const data = await api.todos()
      setTodos(data.todos)
      setTodoStatuses(data.statuses)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const data = await api.projects()
      setProjects(data.projects)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  /**
   * 会话状态读不到不该让看板报错——角标本来就只是提示，少了它看板照常能用。
   * 所以这里失败不写全局 error，只把上次的数据留着。
   */
  const loadSessions = useCallback(async () => {
    try {
      const data = await api.sessions()
      setSessions(data.sessions)
    } catch {
      /* 读不到就维持现状 */
    }
  }, [])

  /**
   * 名次与理由在服务端算（要会话实时状态，渲染层拿不到同一份），这里只拉一份。
   * 失败时留着上一次的列表、记下原话——空列表分不清「没事」和「没算出来」。
   */
  const loadNextUp = useCallback(async () => {
    try {
      const data = await api.nextUp()
      setNextItems(data.items)
      setNextError('')
    } catch (err) {
      setNextError((err as Error).message)
    }
  }, [])

  /**
   * 未读事件靠轮询浮上来：agent 跑完一轮时人在别处，不轮询就只能等他手动刷新——
   * 那就不叫「感知到」了。窗口在后台时不拉（那时也没人看）。
   */
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
      void loadSessions()
      // 会话状态是「下一步」的输入之一，跟着一起刷新
      void loadNextUp()
    }
    const timer = setInterval(tick, SESSION_POLL_MS)
    // 切回窗口立刻补一次，别让人盯着过期数据等下一轮
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadSessions, loadNextUp])

  /** 看板、待办、项目列表与会话一起重拉：agent 建完目录后不用重启应用就能看到 */
  const refresh = useCallback(() => {
    void load()
    void loadTodos()
    void loadProjects()
    void loadSessions()
    void loadNextUp()
  }, [load, loadTodos, loadProjects, loadSessions, loadNextUp])

  useEffect(() => {
    void load()
    void loadTodos()
    void loadProjects()
    void loadSessions()
    void loadNextUp()
  }, [load, loadTodos, loadProjects, loadSessions, loadNextUp])

  /** 需求 id → 名下的会话。需求没有 id 时不可能有会话，取不到正好 */
  const sessionsByReq = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const list = map.get(s.requirementId)
      if (list) list.push(s)
      else map.set(s.requirementId, [s])
    }
    return map
  }, [sessions])

  /** 切项目：写回 activeProject，再把看板换成新项目的数据 */
  async function switchProject(slug: string) {
    if (slug === project) {
      setDetail(null)
      return
    }
    try {
      await api.setActiveProject(slug)
      setDetail(null)
      await load()
      await loadProjects()
      await loadNextUp()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** 搜索时看板只留命中的卡片。导图不在这里筛——它要留着祖先链，见 filterByHits */
  const shown = useMemo(
    () => (hits ? items.filter((r) => hits.has(r.slug)) : items),
    [items, hits],
  )

  const byStatus = useMemo(() => {
    const map = new Map<Status, Requirement[]>(
      (statuses ?? []).map((s) => [s, []]),
    )
    for (const r of shown) {
      const st = (r.status ?? '澄清') as Status
      if (!map.has(st)) map.set(st, [])
      map.get(st)!.push(r)
    }
    // 优先级只在列内体现：排前面就是更该做，不再上色。同档保持原顺序
    for (const list of map.values()) {
      list.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))
    }
    return map
  }, [shown, statuses])

  /**
   * 父需求的子需求完成度。父子在版面上散在各列（`byStatus` 只按状态分列），
   * 卡片上这一行是唯一能看出「这串活还剩几块」的地方。
   */
  const childStats = useMemo(() => childStatsOf(items), [items])

  /** 同上，铺开的父卡片要把子需求本身列出来：知道还剩几块，也得知道它们在哪 */
  const childrenByParent = useMemo(() => childrenOf(items), [items])

  /**
   * 从父卡片点过来的那条子需求。等它出现在版面上再滚过去——子需求可能落在
   * 收起的「已完成」列里，或者被搜索筛掉，那样这一轮还找不到它。
   */
  useEffect(() => {
    if (!pendingJump) return
    const el = document.querySelector(`.card[data-slug="${pendingJump}"]`)
    if (!el) {
      // 被筛选挡掉了：点它就是要过去，先把筛选清掉，下一轮再滚
      if (hits) {
        setQuery('')
        setHits(null)
        return
      }
      setPendingJump(null)
      return
    }
    // 直接跳，不用 smooth：平滑滚动在预览环境里根本不滚（scrollTop 不动），
    // 落到哪儿由卡片闪一下告诉人
    el.scrollIntoView({ block: 'center' })
    setFlashSlug(pendingJump)
    setPendingJump(null)
  }, [pendingJump, hits])

  /** 落点闪一下就好：它是「到了」的提示，不是常驻标记 */
  useEffect(() => {
    if (!flashSlug) return
    const timer = setTimeout(() => setFlashSlug(null), 1400)
    return () => clearTimeout(timer)
  }, [flashSlug])

  /** 点父卡片上的子需求：先把它所在的那一列铺开，滚动交给上面的 effect */
  function jumpToChild(slug: string) {
    const child = items.find((r) => r.slug === slug)
    if (child?.status === DONE_STATUS && !doneOpen) setDoneOpen(true)
    setPendingJump(slug)
  }

  async function handleDragEnd({ active, over }: DragEndEvent) {
    setDragSlug(null)
    setOverStatus(null)
    if (!over) return

    const slug = String(active.id)
    const target = statusOf(over) ?? (over.id as Status)
    const req = items.find((r) => r.slug === slug)
    if (!req || req.status === target) return

    // 乐观更新：先动卡片，再落盘；失败回滚
    const previous = items
    setItems((list) => list.map((r) => (r.slug === slug ? { ...r, status: target } : r)))
    try {
      const updated = await api.move(slug, target)
      // 用服务端返回的完整对象回填，顺带纠正 status 与 updated
      setItems((list) => list.map((r) => (r.slug === slug ? updated : r)))
    } catch (err) {
      setItems(previous)
      setError(`移动失败：${(err as Error).message}`)
    }
  }

  const dragItem = items.find((r) => r.slug === dragSlug) ?? null

  /** 待办拖到别的列：与需求一样先动卡片再落盘，失败回滚 */
  async function handleTodoMove(id: string, status: string) {
    const previous = todos
    setTodos((list) => list.map((t) => (t.id === id ? { ...t, status: status as TodoStatus } : t)))
    try {
      const updated = await api.updateTodo(id, { status })
      setTodos((list) => list.map((t) => (t.id === id ? updated : t)))
    } catch (err) {
      setTodos(previous)
      setError(`移动失败：${(err as Error).message}`)
    }
  }

  if (loading) return <div className="loading">加载中…</div>

  // 详情页挂载点：需求（带 slug）或项目（slug 为 null）
  const detailTarget = detail
    ? detail.slug === null
      ? { kind: 'project' as const, project: detail.project, title: (detail.project === project && projectName) || detail.project }
      : (() => {
          // 必须同时匹配项目：不同项目可能存在同名 slug。
          // 当前项目里找不到时用 crossReq（mini 面板可点开别的项目的需求）。
          const item =
            items.find((r) => r.slug === detail.slug && r.project === detail.project) ??
            (crossReq?.slug === detail.slug && crossReq.project === detail.project
              ? crossReq
              : undefined)
          return item
            ? {
                kind: 'requirement' as const,
                project: item.project,
                slug: item.slug,
                title: item.title,
                req: item,
              }
            : null
        })()
    : null

  // 待办详情：对象从列表里取，改完状态详情页跟着变
  const todoTarget = todoId
    ? (() => {
        const item = todos.find((t) => t.id === todoId)
        return item ? { kind: 'todo' as const, project: '', title: item.title, todo: item } : null
      })()
    : null

  return (
    <div className={`shell${showSettings ? ' settings-open' : ''}`}>
      {/* 设置入口固定在窗口左下角：跟着窗口而不是布局，看板与详情页都在同一位置 */}
      {!showSettings && (
        <button
          className="gear-btn"
          title="设置（⌘,）"
          aria-label="设置"
          onClick={() => setShowSettings(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

      <main className="main-area">
        {showSettings ? (
          <Settings onBack={() => setShowSettings(false)} onApplied={refresh} />
        ) : todoTarget ? (
          <Detail
            target={todoTarget}
            statuses={statuses}
            priorities={priorities}
            todoStatuses={todoStatuses}
            onBack={() => {
              setTodoId(null)
              refresh()
            }}
            onUpdated={() => void loadTodos()}
            onOpenTodo={setTodoId}
            onOpenRequirement={openRequirement}
          />
        ) : detailTarget ? (
          <Detail
            target={detailTarget}
            statuses={statuses}
            priorities={priorities}
            todoStatuses={todoStatuses}
            onBack={() => {
              setDetail(null)
              refresh()
            }}
            onUpdated={refresh}
            onOpenTodo={setTodoId}
            onOpenRequirement={openRequirement}
          />
        ) : (
          <div className="app">
            <div className="topbar">
              <div className="topbar-side">
                {/* 看板切换在左上角：需求与待办是平级的两个看板，都从这儿进 */}
                <BoardSwitcher value={view} onChange={setView} />
                {/* 项目切换：chip 常驻可见，点一下直接切；项目多了横向滚动 */}
                {view === 'req' && (
                  <>
                    <div className="proj-chips">
                      {projects.map((p) => (
                        <button
                          key={p.slug}
                          className={`proj-chip${p.slug === project ? ' on' : ''}`}
                          title={p.root}
                          onClick={() => void switchProject(p.slug)}
                        >
                          {p.name || p.slug}
                        </button>
                      ))}
                    </div>
                    <button
                      className="icon-btn"
                      title="项目详情（总规范）"
                      aria-label="项目详情"
                      onClick={() => setDetail({ project, slug: null })}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <line x1="12" y1="11" x2="12" y2="16" />
                        <line x1="12" y1="8" x2="12" y2="8" />
                      </svg>
                    </button>
                  </>
                )}
              </div>

              <div className="topbar-side right">
                {/* 筛选标记常驻：关掉面板后看板上少了卡片，得有个东西解释为什么少。
                    待办板不按需求筛，「下一步」也不吃这套筛，两处都不摆 */}
                {view === 'req' && reqView !== 'next' && query.trim() && (
                  <button
                    className="filter-chip"
                    title="点一下继续改筛选词"
                    onClick={() => setSearchOpen(true)}
                  >
                    <span className="filter-chip-q">{query.trim()}</span>
                    <span className="n">{hits ? shown.length : ''}</span>
                    <svg
                      className="filter-chip-x"
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      onClick={(e) => {
                        e.stopPropagation()
                        setQuery('')
                      }}
                    >
                      <title>清掉筛选</title>
                      <line x1="6" y1="6" x2="18" y2="18" />
                      <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                  </button>
                )}
                {/* 看板 / 下一步 / 导图是需求板块里的三种呈现，待办板块下不摆 */}
                {view === 'req' && (
                  <div className="seg">
                    <button
                      className={reqView === 'board' ? 'on' : ''}
                      onClick={() => setReqView('board')}
                    >
                      看板
                    </button>
                    <button className={reqView === 'next' ? 'on' : ''} onClick={() => setReqView('next')}>
                      下一步
                    </button>
                    <button className={reqView === 'map' ? 'on' : ''} onClick={() => setReqView('map')}>
                      导图
                    </button>
                  </div>
                )}
                <button className="icon-btn" title="刷新（重扫目录）" aria-label="刷新" onClick={refresh}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </button>
              </div>
            </div>

            {error && <div className="notice">{error}</div>}

            {view === 'todo' ? (
              <TodoBoard
                todos={todos}
                statuses={todoStatuses}
                onOpen={setTodoId}
                onMove={(id, status) => void handleTodoMove(id, status)}
              />
            ) : reqView === 'board' ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={({ active }: DragStartEvent) => setDragSlug(String(active.id))}
                onDragOver={({ over }: DragOverEvent) => setOverStatus(statusOf(over) ?? null)}
                onDragEnd={(e) => void handleDragEnd(e)}
              >
                <div className="board">
                  {statuses.map((status) => (
                    <ColumnView
                      key={status}
                      status={status}
                      items={byStatus.get(status) ?? []}
                      sessionsByReq={sessionsByReq}
                      childStats={childStats}
                      childrenByParent={childrenByParent}
                      onJumpChild={jumpToChild}
                      flashSlug={flashSlug}
                      onOpen={(slug) => setDetail({ project, slug })}
                      isOver={overStatus === status}
                      collapsed={status === DONE_STATUS && !doneOpen}
                      onToggleCollapsed={() => setDoneOpen((v) => !v)}
                    />
                  ))}
                </div>
                <DragOverlay>{dragItem ? <Card req={dragItem} overlay /> : null}</DragOverlay>
              </DndContext>
            ) : reqView === 'next' ? (
              <NextUp
                items={nextItems}
                error={nextError}
                onOpenRequirement={openRequirement}
              />
            ) : (
              <MindMap
                requirements={items}
                projectName={projectName || project}
                hits={hits}
                onOpen={(slug) => setDetail({ project, slug })}
              />
            )}
          </div>
        )}
      </main>

      {/* 面板挂在最外层：它得盖住看板整块，而不是被某个分支的布局裁掉 */}
      {searchOpen && onBoard && (
        <SearchPanel
          query={query}
          onQuery={setQuery}
          results={hits ? shown : []}
          pending={searching}
          onPick={(slug) => {
            setSearchOpen(false)
            openRequirement(project, slug)
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  )
}
