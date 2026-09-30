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
import type { Column, Requirement } from './lib/types'
import Card from './components/Card'
import Detail from './components/Detail'
import Settings from './components/Settings'
import Sidebar from './components/Sidebar'

interface ColumnProps {
  stage: Column
  items: Requirement[]
  onOpen: (slug: string) => void
  isOver: boolean
}

function ColumnView({ stage, items, onOpen, isOver }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id: stage, data: { type: 'column', stage } })
  return (
    <div ref={setNodeRef} className={`column${isOver ? ' over' : ''}`}>
      <div className="column-head">
        <span>{stage}</span>
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
function stageOf(over: DragOverEvent['over']): Column | undefined {
  const data = over?.data.current as { stage?: Column } | undefined
  return data?.stage
}

export default function App() {
  const [columns, setColumns] = useState<Column[]>([])
  /** 当前项目：看板数据按项目隔离 */
  const [project, setProject] = useState('')
  /** 侧边栏展开状态 */
  const [sidebarOpen, setSidebarOpen] = useState(true)
  /** 详情页挂载点：需求或项目。slugs 用 'project:<slug>' 区分 */
  const [detail, setDetail] = useState<{ project: string; slug: string | null } | null>(null)
  const [stages, setStages] = useState<string[]>([])
  const [priorities, setPriorities] = useState<string[]>([])
  const [items, setItems] = useState<Requirement[]>([])
  const [query, setQuery] = useState('')
  // 终端外观（来自设置），改完设置页返回时会重新拉取
  const [fontFamily, setFontFamily] = useState('monospace')
  const [fontSize, setFontSize] = useState(12.5)
  /** 搜索命中的 slug 集合；null 表示未搜索 */
  const [hits, setHits] = useState<Set<string> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  /** 侧边栏可能点开非当前项目的需求，这里单独持有 */
  const [crossReq, setCrossReq] = useState<Requirement | null>(null)
  const [overStage, setOverStage] = useState<Column | null>(null)

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
      setColumns(data.columns)
      setStages(data.stages)
      setPriorities(data.priorities)
      setProject(data.project)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 外观配置只在启动与离开设置页时拉取
  const loadAppearance = useCallback(async () => {
    try {
      const s = await api.settings()
      setFontFamily(s.terminalFontFamily)
      setFontSize(s.terminalFontSize)
    } catch {
      /* 设置读不到时用默认字体，不阻断看板 */
    }
  }, [])

  useEffect(() => {
    void load()
    void loadAppearance()
  }, [load, loadAppearance])

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

  const byColumn = useMemo(() => {
    // 列的唯一来源是 r.column（服务端给的就是列名），不要从 stage 推导
    const map = new Map<Column, Requirement[]>((columns ?? []).map((c) => [c, []]))
    for (const r of filtered) {
      const col = (r.column ?? '澄清') as Column
      if (!map.has(col)) map.set(col, [])
      map.get(col)!.push(r)
    }
    return map
  }, [filtered, columns])

  async function handleDragEnd({ active, over }: DragEndEvent) {
    setDragSlug(null)
    setOverStage(null)
    if (!over) return

    const slug = String(active.id)
    const target = stageOf(over) ?? (over.id as Column)
    const req = items.find((r) => r.slug === slug)
    if (!req || req.column === target) return

    // 乐观更新：先动卡片，再落盘；失败回滚
    const previous = items
    setItems((list) => list.map((r) => (r.slug === slug ? { ...r, column: target } : r)))
    try {
      const updated = await api.move(slug, target)
      // 用服务端返回的完整对象回填，顺带纠正 stage 与 updated
      setItems((list) => list.map((r) => (r.slug === slug ? updated : r)))
    } catch (err) {
      setItems(previous)
      setError(`移动失败：${(err as Error).message}`)
    }
  }

  const dragItem = items.find((r) => r.slug === dragSlug) ?? null

  if (loading) return <div className="loading">加载中…</div>

  // 详情页挂载点：需求（带 slug）或项目（slug 为 null）
  const detailTarget = detail
    ? detail.slug === null
      ? { kind: 'project' as const, project: detail.project, title: detail.project }
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

  return (
    <div className={`shell${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      {sidebarOpen && (
        <Sidebar
          onCollapse={() => setSidebarOpen(false)}
          selected={detail}
          onOpenProjectBoard={() => {
            // Sidebar 内部已调 setActiveProject，这里只需重新拉数据
            setDetail(null)
            void load()
          }}
          onOpenProjectDetail={(slug) => setDetail({ project: slug, slug: null })}
          onOpenRequirement={(proj, slug) => {
            setDetail({ project: proj, slug })
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
          <Settings
            onBack={() => setShowSettings(false)}
            onApplied={() => {
              void load()
              void loadAppearance()
            }}
          />
        ) : detailTarget ? (
          <Detail
            target={detailTarget}
            stages={stages}
            priorities={priorities}
            fontFamily={fontFamily}
            fontSize={fontSize}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onBack={() => {
              setDetail(null)
              void load()
            }}
            onOpenSettings={() => setShowSettings(true)}
            onUpdated={() => void load()}
          />
        ) : (
          <div className="app">
            <div className="topbar">
              {!sidebarOpen && (
                <button className="icon-btn" onClick={() => setSidebarOpen(true)} title="展开侧边栏">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>
              )}
              <span className="brand">{project || 'easy-flow'}</span>
              <span className="count">
                {filtered.length} / {items.length}
              </span>
              <span className="spacer" />
              <input
                className="search"
                placeholder="搜索需求 / 文档全文…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="btn" onClick={() => void load()}>
                刷新
              </button>
              {sidebarOpen && (
                <button className="icon-btn" onClick={() => setSidebarOpen(false)} title="收起侧边栏">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>
              )}
            </div>

            {error && <div className="notice">{error}</div>}

            <DndContext
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={({ active }: DragStartEvent) => setDragSlug(String(active.id))}
              onDragOver={({ over }: DragOverEvent) => setOverStage(stageOf(over) ?? null)}
              onDragEnd={(e) => void handleDragEnd(e)}
            >
              <div className="board">
                {columns.map((stage) => (
                  <ColumnView
                    key={stage}
                    stage={stage}
                    items={byColumn.get(stage) ?? []}
                    onOpen={(slug) => setDetail({ project, slug })}
                    isOver={overStage === stage}
                  />
                ))}
              </div>
              <DragOverlay>{dragItem ? <Card req={dragItem} overlay /> : null}</DragOverlay>
            </DndContext>

            {!sidebarOpen && (
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
          </div>
        )}
      </main>
    </div>
  )
}
