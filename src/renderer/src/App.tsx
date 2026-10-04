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
import type { Requirement, Status, Todo, TodoStatus } from './lib/types'
import BoardSwitcher, { type BoardView } from './components/BoardSwitcher'
import MindMap from './components/MindMap'
import Card from './components/Card'
import Detail from './components/Detail'
import Settings from './components/Settings'
import Sidebar from './components/Sidebar'
import TodoBoard from './components/TodoBoard'

interface BoardColumnProps {
  status: Status
  items: Requirement[]
  onOpen: (slug: string) => void
  isOver: boolean
}

function ColumnView({ status, items, onOpen, isOver }: BoardColumnProps) {
  const { setNodeRef } = useDroppable({ id: status, data: { status } })
  return (
    <div ref={setNodeRef} className={`column${isOver ? ' over' : ''}`}>
      <div className="column-head">
        <span>{status}</span>
        <span className="n">{items.length}</span>
      </div>
      <div className="column-body">
        {items.length === 0 ? (
          <div className="empty">—</div>
        ) : (
          items.map((r) => <Card key={r.slug} req={r} onOpen={onOpen} />)
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

export default function App() {
  const [statuses, setStatuses] = useState<Status[]>([])
  /** 当前看板：需求与待办是平级的两个看板 */
  const [view, setView] = useState<BoardView>('req')
  /** 当前项目：看板数据按项目隔离 */
  const [project, setProject] = useState('')
  /** 当前项目显示名，取自项目根 AGENTS.md 的 frontmatter；缺省是目录名 */
  const [projectName, setProjectName] = useState('')
  /** 侧边栏展开状态 */
  const [sidebarOpen, setSidebarOpen] = useState(true)
  /** 需求板块里的视图：看板（默认）或导图；待办板块下不适用 */
  const [reqView, setReqView] = useState<'board' | 'map'>('board')
  /** 详情页挂载点：需求或项目。slugs 用 'project:<slug>' 区分 */
  const [detail, setDetail] = useState<{ project: string; slug: string | null } | null>(null)
  const [priorities, setPriorities] = useState<string[]>([])
  const [items, setItems] = useState<Requirement[]>([])
  /** 待办：全局的，不分项目 */
  const [todos, setTodos] = useState<Todo[]>([])
  const [todoStatuses, setTodoStatuses] = useState<string[]>([])
  /** 打开的待办详情。只存 id，对象从 todos 里取——改完状态详情页跟着变 */
  const [todoId, setTodoId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** 搜索命中的 slug 集合；null 表示未搜索 */
  const [hits, setHits] = useState<Set<string> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  /** 侧边栏可能点开非当前项目的需求，这里单独持有 */
  const [crossReq, setCrossReq] = useState<Requirement | null>(null)
  const [overStatus, setOverStatus] = useState<Status | null>(null)
  /** 每加一就重拉侧边栏树。agent 在文件系统里建完目录后靠它刷新 */
  const [refreshSeq, setRefreshSeq] = useState(0)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const searchSeq = useRef(0)

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

  /** 看板与侧边栏一起重拉：agent 建完目录后不用重启应用就能看到 */
  const refresh = useCallback(() => {
    void load()
    void loadTodos()
    setRefreshSeq((n) => n + 1)
  }, [load, loadTodos])

  useEffect(() => {
    void load()
    void loadTodos()
  }, [load, loadTodos])

  // 搜索交给服务端（md 与索引都在那边），防抖 + 序号防乱序
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    const seq = ++searchSeq.current
    const timer = setTimeout(async () => {
      try {
        const res = await api.search(q)
        if (seq === searchSeq.current) setHits(new Set(res.requirements.map((r) => r.slug)))
      } catch (err) {
        if (seq === searchSeq.current) setError((err as Error).message)
      }
    }, 220)
    return () => clearTimeout(timer)
  }, [query])

  const filtered = useMemo(
    () => (hits ? items.filter((r) => hits.has(r.slug)) : items),
    [items, hits],
  )

  const byStatus = useMemo(() => {
    const map = new Map<Status, Requirement[]>(
      (statuses ?? []).map((s) => [s, []]),
    )
    for (const r of filtered) {
      const st = (r.status ?? '澄清') as Status
      if (!map.has(st)) map.set(st, [])
      map.get(st)!.push(r)
    }
    return map
  }, [filtered, statuses])

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
          // 当前项目里找不到时用 crossReq（侧边栏可点开别的项目的需求）。
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
    <div className={`shell${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      {/* 侧边栏开关固定在窗口左上角：跟随窗口而不是布局，展开/折叠都在同一位置 */}
      <button
        className="icon-btn sidebar-toggle"
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>

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

      {sidebarOpen && (
        <Sidebar
          selected={detail}
          refreshKey={refreshSeq}
          onOpenProjectBoard={() => {
            // Sidebar 内部已调 setActiveProject，这里只需重新拉数据
            setDetail(null)
            setView('req')
            void load()
          }}
          onOpenProjectDetail={(slug) => {
            setDetail({ project: slug, slug: null })
            setView('req')
          }}
          onOpenRequirement={(proj, slug) => {
            setDetail({ project: proj, slug })
            // 从侧边栏点需求就是回到需求看板，别把详情页叠在待办看板上
            setView('req')
            // 不在当前项目的需求需要单独取，否则详情页会静默退回看板
            const local = items.find((r) => r.slug === slug && r.project === proj)
            setCrossReq(local ?? null)
            if (!local) {
              void api
                .context(slug, proj)
                .then((c) => setCrossReq(c.requirement))
                .catch((e: Error) => setError(e.message))
            }
          }}
        />
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
          />
        ) : (
          <div className="app">
            <div className="topbar">
              <div className="topbar-side">
                {/* 看板切换在左上角：需求与待办是平级的两个看板，都从这儿进 */}
                <BoardSwitcher value={view} project={projectName || project} onChange={setView} />
                <span className="count">
                  {view === 'todo' ? todos.length : `${filtered.length} / ${items.length}`}
                </span>
              </div>

              {/* 搜索框居中，放大镜贴在它左边。两边各占一半，中间才是真的居中。
                  它只搜需求与文档全文，待办看板下不摆（搜不到会让人以为没结果） */}
              {view === 'req' && (
                <div className="search-box">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="16.5" y1="16.5" x2="21" y2="21" />
                  </svg>
                  <input
                    className="search-input"
                    aria-label="搜索需求 / 文档全文"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setQuery('')
                    }}
                  />
                </div>
              )}

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
                      onOpen={(slug) => setDetail({ project, slug })}
                      isOver={overStatus === status}
                    />
                  ))}
                </div>
                <DragOverlay>{dragItem ? <Card req={dragItem} overlay /> : null}</DragOverlay>
              </DndContext>
            ) : (
              // 导图拿全量 items + hits，祖先链由 layoutTree 自己补：
              // 喂 filtered 会把命中节点的父需求整条切掉，树就断了
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
    </div>
  )
}
