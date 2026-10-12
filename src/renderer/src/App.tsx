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
import type { Project, Requirement, Session, Status, Todo, TodoStatus } from './lib/types'
import { badgesOf } from './lib/threads'
import BoardSwitcher, { type BoardView } from './components/BoardSwitcher'
import MindMap from './components/MindMap'
import Card from './components/Card'
import Detail from './components/Detail'
import Settings from './components/Settings'
import TodoBoard from './components/TodoBoard'

interface BoardColumnProps {
  status: Status
  items: Requirement[]
  /** 需求 id → 它名下的会话。卡片角标按需求取用（每个会话各挂一个） */
  sessionsByReq: Map<string, Session[]>
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
          <div className="empty">—</div>
        ) : (
          items.map((r) => (
            <Card
              key={r.slug}
              req={r}
              sessions={badgesOf(sessionsByReq.get(r.id) ?? [])}
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

/** 这一列默认收成窄条：历史只增不减，全铺开会把活跃三列挤窄 */
const DONE_STATUS: Status = '已完成'

/** 同列内按优先级排：p0 在前，没设优先级的排最后 */
const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

/** 未读事件的轮询间隔。够快让人察觉，又不至于把看板变成每秒一次的扫描 */
const SESSION_POLL_MS = 20_000

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
  /** 「已完成」列是否展开。默认收成窄条 */
  const [doneOpen, setDoneOpen] = useState(false)
  /** 需求板块里的视图：看板（默认）或导图；待办板块下不适用 */
  const [reqView, setReqView] = useState<'board' | 'map'>('board')
  /** 详情页挂载点：需求或项目。slugs 用 'project:<slug>' 区分 */
  const [detail, setDetail] = useState<{ project: string; slug: string | null } | null>(null)
  const [priorities, setPriorities] = useState<string[]>([])
  const [items, setItems] = useState<Requirement[]>([])
  /** 全部会话（含实时状态）。卡片角标与详情页的「会话」块共用 */
  const [sessions, setSessions] = useState<Session[]>([])
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

  // Cmd+, 打开设置。Electron 里由应用菜单的加速键触发（见 main/registerMenu），
  // 浏览器开发时没有菜单，这里补一个键盘监听。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    const off = window.easyFlow?.onOpenSettings?.(() => setShowSettings(true))
    return () => {
      window.removeEventListener('keydown', onKey)
      off?.()
    }
  }, [])

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
   * 未读事件靠轮询浮上来：agent 跑完一轮时人在别处，不轮询就只能等他手动刷新——
   * 那就不叫「感知到」了。窗口在后台时不拉（那时也没人看）。
   */
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void loadSessions()
    }
    const timer = setInterval(tick, SESSION_POLL_MS)
    // 切回窗口立刻补一次，别让人盯着过期数据等下一轮
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadSessions])

  /** 看板、待办、项目列表与会话一起重拉：agent 建完目录后不用重启应用就能看到 */
  const refresh = useCallback(() => {
    void load()
    void loadTodos()
    void loadProjects()
    void loadSessions()
  }, [load, loadTodos, loadProjects, loadSessions])

  useEffect(() => {
    void load()
    void loadTodos()
    void loadProjects()
    void loadSessions()
  }, [load, loadTodos, loadProjects, loadSessions])

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
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const byStatus = useMemo(() => {
    const map = new Map<Status, Requirement[]>(
      (statuses ?? []).map((s) => [s, []]),
    )
    for (const r of items) {
      const st = (r.status ?? '澄清') as Status
      if (!map.has(st)) map.set(st, [])
      map.get(st)!.push(r)
    }
    // 优先级只在列内体现：排前面就是更该做，不再上色。同档保持原顺序
    for (const list of map.values()) {
      list.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))
    }
    return map
  }, [items, statuses])

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
                {/* 导图是需求板块里的一种呈现，待办板块下不摆 */}
                {view === 'req' && (
                  <div className="seg">
                    <button
                      className={reqView === 'board' ? 'on' : ''}
                      onClick={() => setReqView('board')}
                    >
                      看板
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
                      onOpen={(slug) => setDetail({ project, slug })}
                      isOver={overStatus === status}
                      collapsed={status === DONE_STATUS && !doneOpen}
                      onToggleCollapsed={() => setDoneOpen((v) => !v)}
                    />
                  ))}
                </div>
                <DragOverlay>{dragItem ? <Card req={dragItem} overlay /> : null}</DragOverlay>
              </DndContext>
            ) : (
              <MindMap
                requirements={items}
                projectName={projectName || project}
                onOpen={(slug) => setDetail({ project, slug })}
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
