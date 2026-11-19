import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { api } from './lib/api'
import { reuseRows } from './lib/rows'
import { DONE_STATUS, childStatsOf, childrenOf } from './lib/children'
import {
  nextCandidateInDirection,
  nextPetStop,
  posOf,
  type BoardColumn,
  type BoardDir,
  type FocusCandidate,
  type PetRef,
} from './lib/board-focus'
import { lastActiveByReq, orderColumn } from './lib/board-order'
import { badgesOf, isEventState } from './lib/threads'
import {
  isEditableTarget,
  isInteractiveTarget,
  isPetTarget,
  projectSlot,
  shortcut,
  shortcutLabel,
  shouldIgnore,
} from './lib/keys'
import { BOARD_POLL_MS } from './lib/time'
import { useTheme } from './lib/theme'
import type { ChildStat, NextUpItem, Project, Requirement, Session, Status, Todo } from './lib/types'
import MindMap from './components/MindMap'
import Card from './components/Card'
import { PinIcon } from './components/icons'
import NextUp from './components/NextUp'
import Detail from './components/Detail'
import SearchPanel from './components/SearchPanel'
import ProjectSwitcher from './components/ProjectSwitcher'
import Settings from './components/Settings'
import LeftRail from './components/LeftRail'

// 空列的一句话：一个「—」说不出这一列是干什么的。认不出的状态回落到通用文案
const COLUMN_HINT: Record<string, string> = {
  澄清: '没有待澄清的需求',
  执行中: '没有正在执行的需求',
  Review: '没有等待评审的需求',
  已完成: '还没有完成的需求',
}

interface BoardColumnProps {
  status: Status
  items: Requirement[]
  // 需求 id → 它名下的会话。卡片角标按需求取用（每个会话各挂一个）
  sessionsByReq: Map<string, Session[]>
  // 父需求 id → 子需求完成度。没有子需求的需求不在表里
  childStats: Map<string, ChildStat>
  // 父需求 id → 直接子需求。铺开的父卡片靠它把子需求列出来
  childrenByParent: Map<string, Requirement[]>
  // 点父卡片上的子需求：滚到它在版面上的卡片
  onJumpChild: (slug: string) => void
  // 刚跳过去的那条，闪一下
  flashSlug: string | null
  kidsOpen: Set<string>
  onToggleKids: (slug: string) => void
  onFocusCard: (slug: string) => void
  onOpen: (slug: string) => void
  onTag: (tag: string) => void
  onTogglePin: (req: Requirement, next: boolean) => void
  isOver: boolean
  // 收成窄条（只有「已完成」列会）
  collapsed: boolean
  onToggleCollapsed: () => void
}

const EMPTY_SESSIONS: Session[] = []
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } }
const PIN_STATUS = '置顶'
const PIN_DROP_ID = 'pinned-drop'

function visibleInBoard(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  let left = 0
  let top = 0
  let right = window.innerWidth
  let bottom = window.innerHeight
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const box = node.getBoundingClientRect()
    left = Math.max(left, box.left)
    top = Math.max(top, box.top)
    right = Math.min(right, box.right)
    bottom = Math.min(bottom, box.bottom)
  }
  return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
}

const collisionDetection: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates
  const pinned = args.droppableContainers.find((c) => c.id === PIN_DROP_ID)
  const rect = pinned ? args.droppableRects.get(pinned.id) : undefined
  if (
    pointer &&
    rect &&
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom
  ) {
    return [{ id: PIN_DROP_ID }]
  }
  return closestCorners({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => c.id !== PIN_DROP_ID),
  })
}

const ColumnView = memo(function ColumnView({
  status,
  items,
  sessionsByReq,
  childStats,
  childrenByParent,
  onJumpChild,
  flashSlug,
  kidsOpen,
  onToggleKids,
  onFocusCard,
  onOpen,
  onTag,
  onTogglePin,
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
              sessions={sessionsByReq.get(r.id) ?? EMPTY_SESSIONS}
              childStat={childStats.get(r.id)}
              kids={childrenByParent.get(r.id)}
              onJumpChild={onJumpChild}
              flash={flashSlug === r.slug}
              kidsOpen={kidsOpen.has(r.slug)}
              onToggleKids={onToggleKids}
              onFocusCard={onFocusCard}
              onOpen={onOpen}
              onTag={onTag}
              onTogglePin={onTogglePin}
            />
          ))
        )}
      </div>
    </div>
  )
})

ColumnView.displayName = 'ColumnView'

function PinnedSection({ className, children }: { className: string; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: PIN_DROP_ID })
  return (
    <section ref={setNodeRef} className={className}>
      {children}
    </section>
  )
}

// dnd-kit 的 data 是 unknown，这里收窄一次
function statusOf(over: DragOverEvent['over']): Status | undefined {
  const data = over?.data.current as { status?: Status } | undefined
  return data?.status
}

// pin 的项目存浏览器本地：它是「这台机器上常看哪几个」，不是看板数据
const PINNED_KEY = 'easy-flow.pinned-projects'

// 按住 ⌘ 满这么久才浮出键位：顺手按下的组合键不该闪一下
const HINT_HOLD_MS = 1000

function readPinned(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

export default function App() {
  const [statuses, setStatuses] = useState<Status[]>([])
  // 当前项目：看板数据按项目隔离
  const [project, setProject] = useState('')
  // 当前项目显示名，取自项目根 AGENTS.md 的 frontmatter；缺省是目录名
  const [projectName, setProjectName] = useState('')
  // 项目列表：左侧栏用它。agent 在文件系统里建完目录后靠刷新带出来
  const [projects, setProjects] = useState<Project[]>([])
  // 常驻左侧栏的项目（pin 的），顺序即栏里的顺序
  const [pinned, setPinned] = useState<string[]>(readPinned)
  // 「已完成」列是否展开。默认收成窄条：历史只增不减，全铺开会把活跃三列挤窄
  const [doneOpen, setDoneOpen] = useState(false)
  const [pinsOpen, setPinsOpen] = useState(true)
  const [petFocus, setPetFocus] = useState<{ project: string; slug: string; session: string } | null>(null)
  const petFocusRef = useRef(petFocus)
  petFocusRef.current = petFocus
  // 从父卡片点过来的那条子需求：等它在版面上出现再滚过去
  const [pendingJump, setPendingJump] = useState<string | null>(null)
  // 刚跳到的卡片：闪一下，好在一屏卡片里认出落点
  const [flashSlug, setFlashSlug] = useState<string | null>(null)
  // 需求板块里的视图：看板（默认）/ 下一步 / 导图
  const [reqView, setReqView] = useState<'board' | 'next' | 'map'>('board')
  // 详情页挂载点：需求或项目。slugs 用 'project:<slug>' 区分
  const [detail, setDetail] = useState<{ project: string; slug: string | null } | null>(null)
  const [items, setItems] = useState<Requirement[]>([])
  const currentItems = useRef(items)
  currentItems.current = items
  // 全部会话（含实时状态）。卡片角标与详情页的「会话」块共用
  const [sessions, setSessions] = useState<Session[]>([])
  // 「下一步」的排名（服务端算好，每条带理由），只在「下一步」视图里读
  const [nextItems, setNextItems] = useState<NextUpItem[]>([])
  // 上次算排名失败的原话；空串表示最近一次是成功的
  const [nextError, setNextError] = useState('')
  // 待办：全局的，不分项目
  const [todos, setTodos] = useState<Todo[]>([])
  // 打开的待办详情。只存 id，对象从 todos 里取——改完状态详情页跟着变
  const [todoId, setTodoId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const { theme, setTheme } = useTheme()
  const [dragSlug, setDragSlug] = useState<string | null>(null)
  // mini 面板可能点开非当前项目的需求，这里单独持有
  const [crossReq, setCrossReq] = useState<Requirement | null>(null)
  const [overStatus, setOverStatus] = useState<Status | null>(null)
  /**
   * ⌘K 搜索。「面板开着」与「筛选词还在」是两件事：关掉面板筛选留着，
   * 否则刚搜出来的那几张卡在眼前一闪就没了，看板与导图上的过滤等于白做。
   */
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  // 命中集合；null 表示没在筛。看板的过滤与导图的 hits 共用它
  const [hits, setHits] = useState<Set<string> | null>(null)
  // 正在等服务端返回：用来区分「还没查」与「查了没有」
  const [searching, setSearching] = useState(false)
  // 默认常开，第一次按键落到第一列第一张
  const [kidsOpen, setKidsOpen] = useState<Set<string>>(new Set())
  const [projectPicker, setProjectPicker] = useState(false)
  const [hint, setHint] = useState('')
  // 按住 ⌘ 时左栏浮出键位，键盘事件照常派发
  const [cmdHeld, setCmdHeld] = useState(false)
  /**
   * 选中态落在哪张卡是 DOM 状态，不进 React：j/k/h/l 只切卡上的 `data-focused`
   * 与 DOM 焦点，看板本身不重渲染（43 张卡、48 只 pet 全量渲染一次就是一次卡顿）。
   */
  const focusSlug = useRef<string | null>(null)
  const focusedEl = useRef<HTMLElement | null>(null)
  // 目标卡还没渲染出来（收起的「已完成」列要先展开）时，等下一次渲染再落焦点
  const pendingFocus = useRef<string | null>(null)
  // 要落的是卡里哪只 pet
  // 卡渲染出来后再把焦点从卡挪到那一格
  const pendingPet = useRef<PetRef | null>(null)
  // 置顶卡接住焦点后再收「已完成」列，收早了会把待落焦点清掉
  const pendingFold = useRef(false)

  useEffect(() => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(pinned))
  }, [pinned])

  // 已删除的项目还留在置顶里：左栏不画它，键位也不给它编号
  const pinnedLive = useMemo(
    () => pinned.filter((s) => projects.some((p) => p.slug === s)),
    [pinned, projects],
  )

  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS))
  // 待打开的需求只取一次（主窗口刚重建时的那份交接）
  const tookPending = useRef(false)

  /**
   * 打开某条需求的详情页。mini 面板与详情页里的跳转都走这里：
   * 不在当前项目的需求要单独取，否则详情页会静默退回看板。
   */
  const openRequirement = useCallback(
    (proj: string, slug: string) => {
      setDetail({ project: proj, slug })
      // 待办详情上也有跳需求的入口：那一层要摘掉，否则详情页被它盖着
      setTodoId(null)
      const local = items.find((r) => r.slug === slug && r.project === proj)
      setCrossReq(local ?? null)
      if (!local) {
        void api
          .detail(slug, proj)
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
   * 搜索面板只在看板与导图上开（它筛的就是这两处）。详情页、设置页，
   * 以及不认筛选的「下一步」都不给这个入口——从那些地方开出来，人看到的是一个
   * 筛掉了卡片的界面自己却不在上面，不如不开。
   */
  const inMain = !showSettings && !detail && !todoId
  const onBoard = inMain && reqView !== 'next'

  // 进详情 / 设置时收起项目面板，回来不再弹
  useEffect(() => {
    if (!inMain) setProjectPicker(false)
  }, [inMain])

  /**
   * 按住 ⌘ 满一秒才浮出键位，组合键照常派发。
   * 焦点在输入控件里不算：那时 ⌘ 是打给编辑器的。
   * ⌘Tab 切走收不到 keyup，靠 blur 收尾。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      clearTimeout(timer)
      timer = undefined
      setCmdHeld(false)
    }
    const down = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      // 按住 ⌘ 又按了别的键：这一下是在打组合键，别把提示带出来
      if (e.key !== 'Meta') {
        if (timer) settle()
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        setCmdHeld(true)
      }, HINT_HOLD_MS)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || !e.metaKey) settle()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', settle)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', settle)
      clearTimeout(timer)
    }
  }, [])

  // 窗口级快捷键。⌘, 打开设置——Electron 里由应用菜单的加速键触发（见 main/registerMenu），
  // 浏览器开发没有菜单，这里补 ⌘,；其余组合只在主界面生效
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (shortcut(e, 'global.settings')) {
        e.preventDefault()
        setShowSettings((v) => !v)
        return
      }
      if (!inMain) return
      if (shortcut(e, 'global.clear-filter')) {
        e.preventDefault()
        setQuery('')
        setHits(null)
        return
      }
      if (shortcut(e, 'global.search') && onBoard) {
        e.preventDefault()
        setProjectPicker(false)
        setSearchOpen((v) => !v)
        return
      }
      const view = shortcut(e, 'global.view-board')
        ? 'board'
        : shortcut(e, 'global.view-next')
          ? 'next'
          : shortcut(e, 'global.view-map')
            ? 'map'
            : null
      if (view) {
        e.preventDefault()
        setProjectPicker(false)
        setReqView(view)
        return
      }
      if (shortcut(e, 'global.project')) {
        e.preventDefault()
        setSearchOpen(false)
        setProjectPicker((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    const off = window.easyFlow?.onOpenSettings?.(() => setShowSettings(true))
    return () => {
      window.removeEventListener('keydown', onKey)
      off?.()
    }
  }, [inMain, onBoard])

  /**
   * 搜索交给服务端：它连文档正文一起搜（见 db.search），渲染层不做遍历。
   * 防抖只是别让每个按键都发一次请求；换了项目就重查，命中集合是按项目算的。
   */
  useEffect(() => {
    const q = deferredQuery.trim()
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void api
        .search(q, controller.signal)
        .then((r) => {
          if (alive) startTransition(() => setHits(new Set(r.requirements.map((x) => x.slug))))
        })
        // 搜挂了不该把看板一起弄坏：维持上一次的命中集合，界面照常能用
        .catch(() => {})
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 120)
    return () => {
      alive = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [deferredQuery, project])

  /**
   * 轮询是每秒一次的，但内容多数时候没变：服务端给每份数据算了个版本，
   * 版本相同就不提交——否则每秒都是一次整板重渲染。
   */
  const revs = useRef<Record<string, string>>({})
  const applyIfChanged = useCallback((key: string, rev: string) => {
    if (revs.current[key] === rev) return false
    revs.current[key] = rev
    return true
  }, [])

  const detailMode = useRef(!inMain)
  detailMode.current = !inMain
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const snapshot = await api.snapshot(detailMode.current)
      if (seq !== loadSeq.current) return
      startTransition(() => {
        const { board, projects: projectData, todos: todoData, sessions: sessionData, nextUp } = snapshot
        if (applyIfChanged('requirements', board.rev)) {
          setItems(previous => reuseRows(previous, board.requirements, r => `${r.project}/${r.slug}`))
          setStatuses(previous => previous.join() === board.statuses.join() ? previous : board.statuses)
          setProject(board.project)
          setProjectName(board.projectName)
        }
        if (applyIfChanged('projects', projectData.rev)) {
          setProjects(previous => reuseRows(previous, projectData.projects, p => p.slug))
        }
        if (applyIfChanged('todos', todoData.rev)) {
          setTodos(previous => reuseRows(previous, todoData.todos, t => t.id))
        }
        if (sessionData && applyIfChanged('sessions', sessionData.rev)) {
          setSessions(previous => reuseRows(previous, sessionData.sessions, s => `${s.agent}:${s.session}`))
        }
        if (nextUp && applyIfChanged('next-up', nextUp.rev)) setNextItems(nextUp.items)
        setNextError('')
        setError('')
        setLoading(false)
      })
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError((err as Error).message)
      setNextError((err as Error).message)
      setLoading(false)
    }
  }, [applyIfChanged])

  useEffect(() => {
    let inFlight = false
    const tick = () => {
      if (document.hidden || inFlight) return
      inFlight = true
      void load().finally(() => { inFlight = false })
    }
    tick()
    const timer = setInterval(tick, BOARD_POLL_MS * (inMain ? 1 : 3))
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load, inMain])

  const refresh = useCallback(() => { void load() }, [load])

  // 切项目：写回 activeProject，再把看板换成新项目的数据
  const switchProject = useCallback(
    async (slug: string) => {
      if (slug === project) {
        setDetail(null)
        return
      }
      petFocusRef.current = null
      setPetFocus(null)
      try {
        await api.setActiveProject(slug)
        setDetail(null)
        await load()
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [project, load],
  )

  // ⌘1..9 直接切置顶项目，编号与左栏徽标同一份顺序
  useEffect(() => {
    if (!inMain) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const slot = projectSlot(e)
      if (!slot) return
      const target = pinnedLive[slot - 1]
      if (target) {
        e.preventDefault()
        setProjectPicker(false)
        setSearchOpen(false)
        void switchProject(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inMain, pinnedLive, switchProject])

  // 铃铛角标：agent 卡住等你、要人介入的需求数（档位 1 就是 level now）
  const agentCount = useMemo(() => nextItems.filter((i) => i.level === 'now').length, [nextItems])

  // 需求 id → 名下的会话。需求没有 id 时不可能有会话，取不到正好
  const sessionsByReq = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const list = map.get(s.requirementId)
      if (list) list.push(s)
      else map.set(s.requirementId, [s])
    }
    return map
  }, [sessions])

  // 需求 id → 名下 agent 最后活跃的时刻，列内排序靠它
  // 会话每秒拉一次，卡片顺序跟着动（BOARD_POLL_MS）
  const lastActive = useMemo(() => lastActiveByReq(sessionsByReq), [sessionsByReq])

  // pin 只动左栏常驻哪几个，不切当前项目
  function togglePin(slug: string, next: boolean) {
    setPinned((list) =>
      next ? (list.includes(slug) ? list : [...list, slug]) : list.filter((s) => s !== slug),
    )
  }

  // 点卡片标签与 ⌘K 共用同一个筛选词；再点同一个标签就是取消
  const filterByTag = useCallback((tag: string) => {
    setQuery((q) => (q.trim() === `#${tag}` ? '' : `#${tag}`))
  }, [])

  // 搜索时看板只留命中的卡片。导图不在这里筛——它要留着祖先链，见 filterByHits
  const shown = useMemo(
    () => (hits ? items.filter((r) => hits.has(r.slug)) : items),
    [items, hits],
  )

  const pinnedItems = useMemo(() => shown.filter((r) => r.pinned), [shown])

  const byStatus = useMemo(() => {
    const map = new Map<Status, Requirement[]>(
      (statuses ?? []).map((s) => [s, []]),
    )
    for (const r of shown) {
      if (r.pinned) continue
      const st = (r.status ?? '澄清') as Status
      if (!map.has(st)) map.set(st, [])
      map.get(st)!.push(r)
    }
    // 顺序只在列内体现：最近动过的排在前面，没动过的按优先级沉底
    for (const [status, list] of map) map.set(status, orderColumn(list, lastActive))
    return map
  }, [shown, statuses, lastActive])

  const pinColumn = useMemo<BoardColumn | null>(
    () =>
      pinnedItems.length > 0
        ? { status: PIN_STATUS, slugs: pinnedItems.map((r) => r.slug) }
        : null,
    [pinnedItems],
  )

  const statusColumns = useMemo<BoardColumn[]>(
    () => statuses.map((s) => ({ status: s, slugs: (byStatus.get(s) ?? []).map((r) => r.slug) })),
    [statuses, byStatus],
  )

  const focusColumns = useMemo<BoardColumn[]>(
    () => (pinsOpen && pinColumn ? [pinColumn, ...statusColumns] : statusColumns),
    [pinsOpen, pinColumn, statusColumns],
  )

  const attentionColumns = useMemo<BoardColumn[]>(
    () => (pinColumn ? [pinColumn, ...statusColumns] : statusColumns),
    [pinColumn, statusColumns],
  )

  // 要人处理的 pet：会话落在事件三档
  // 判据与卡片角标同一份
  // 一张卡可能挂好几只
  const attention = useMemo(() => {
    const bySlug = new Map<string, string[]>()
    for (const r of shown) {
      const ids = badgesOf(sessionsByReq.get(r.id) ?? [])
        .filter((s) => isEventState(s.status.state))
        .map((s) => s.session)
      if (ids.length) bySlug.set(r.slug, ids)
    }
    return bySlug
  }, [shown, sessionsByReq])

  const childrenByParent = useMemo(() => childrenOf(items), [items])

  const toggleKids = useCallback((slug: string) => {
    setKidsOpen((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])

  // 这一列是按焦点自动展开的，还是人点开的
  const doneAutoOpen = useRef(false)

  // 焦点要落进「已完成」列时先展开，否则卡还没渲染出来
  const revealDone = useCallback(() => {
    if (doneOpen) return
    doneAutoOpen.current = true
    setDoneOpen(true)
  }, [doneOpen])

  // 只收自动展开的那一次：人点开的列由人自己收
  const foldDone = useCallback(() => {
    if (!doneAutoOpen.current) return
    doneAutoOpen.current = false
    setDoneOpen(false)
  }, [])

  const toggleDone = useCallback(() => {
    doneAutoOpen.current = false
    setDoneOpen((v) => !v)
  }, [])

  const cardEl = (slug: string): HTMLElement | null =>
    Array.from(document.querySelectorAll<HTMLElement>('.card')).find(
      (node) => node.dataset.slug === slug,
    ) ?? null

  // 选中态与 DOM 焦点一起挪：旧卡摘属性、新卡挂属性，各只有一次属性切换
  const moveFocus = useCallback((slug: string) => {
    if (petFocusRef.current && petFocusRef.current.slug !== slug) {
      petFocusRef.current = null
      setPetFocus(null)
    }
    const el = cardEl(slug)
    if (!el) {
      // 收起的「已完成」列里的卡还没渲染，等展开后的下一次渲染再落
      pendingFocus.current = slug
      return
    }
    const prev = focusedEl.current
    if (prev && prev !== el) prev.removeAttribute('data-focused')
    el.setAttribute('data-focused', '')
    focusedEl.current = el
    focusSlug.current = slug
    // 焦点已经在这张卡里（比如停在它的 agent 头像上）就别抢回来
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
    setFlashSlug((cur) => (cur && cur !== slug ? null : cur))
  }, [])

  const dropFocus = useCallback(() => {
    pendingFold.current = false
    if (petFocusRef.current) {
      petFocusRef.current = null
      setPetFocus(null)
    }
    const prev = focusedEl.current
    if (prev) {
      prev.removeAttribute('data-focused')
      if (prev.contains(document.activeElement)) prev.blur()
    }
    focusedEl.current = null
    focusSlug.current = null
    pendingFocus.current = null
    pendingPet.current = null
    // 焦点收掉就是离开「已完成」列：跟着焦点展开的那次列也一起收回去
    foldDone()
  }, [foldDone])

  // 鼠标点进卡片、Tab 落回卡片时同步选中态；焦点本来就在这张卡里就不动
  const handleCardFocus = useCallback(
    (slug: string) => {
      if (focusSlug.current !== slug) moveFocus(slug)
    },
    [moveFocus],
  )

  // 焦点落到卡里的某一格 pet 上
  // 按 data-session 找到那一格，回车由那一格自己接
  // 这一格不能聚焦时焦点留在卡上，回车打开需求
  const focusPetStop = useCallback(
    (slug: string, session: string) => {
      pendingPet.current = { slug, session }
      const card = cardEl(slug)
      if (!card) {
        moveFocus(slug)
        return
      }
      moveFocus(slug)
      pendingPet.current = null
      const slot = Array.from(card.querySelectorAll<HTMLElement>('.slot[data-session]')).find(
        (el) => el.dataset.session === session,
      )
      if (slot && slot.tabIndex >= 0) slot.focus({ preventScroll: true })
    },
    [moveFocus],
  )

  // 卡片被筛掉、换列重挂、从详情页回来之后：焦点跟着走，卡没了就收掉选中态。
  // 不挂依赖数组——看板重挂时 focusColumns 不一定变，只有查一下 DOM 才知道框还在不在
  useEffect(() => {
    const slug = focusSlug.current
    if (!slug) return
    if (!posOf(focusColumns, slug)) {
      dropFocus()
      return
    }
    if (focusedEl.current?.isConnected) return
    // 卡还在版面上（换列重挂）就接着跟；整列收成窄条后卡没渲染，选中到此为止
    if (cardEl(slug)) moveFocus(slug)
    else dropFocus()
  })

  // 等一张还没渲染出来的卡（展开收起列、跳子需求）
  useEffect(() => {
    const slug = pendingFocus.current
    if (!slug || !cardEl(slug)) return
    pendingFocus.current = null
    const pet = pendingPet.current
    if (pet?.slug === slug) focusPetStop(pet.slug, pet.session)
    else moveFocus(slug)
    if (pendingFold.current) {
      pendingFold.current = false
      foldDone()
    }
  })

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(''), 1600)
    return () => clearTimeout(timer)
  }, [hint])

  const jumpToChild = useCallback((slug: string) => {
    const child = currentItems.current.find((r) => r.slug === slug)
    if (child?.pinned) setPinsOpen(true)
    else if (child?.status === DONE_STATUS) revealDone()
    moveFocus(slug)
    setPendingJump(slug)
  }, [revealDone, moveFocus])

  const toggleRequirementPin = useCallback(async (req: Requirement, next: boolean) => {
    if (petFocusRef.current?.project === req.project && petFocusRef.current.slug === req.slug) {
      petFocusRef.current = null
      setPetFocus(null)
    }
    if (next) setPinsOpen(true)
    setItems((list) =>
      list.map((r) => (r.project === req.project && r.slug === req.slug ? { ...r, pinned: next } : r)),
    )
    try {
      const updated = await api.update(req.slug, { pinned: next }, req.project)
      setItems((list) =>
        list.map((r) =>
          r.project === req.project && r.slug === req.slug ? { ...r, pinned: updated.pinned } : r,
        ),
      )
    } catch (err) {
      setItems((list) =>
        list.map((r) =>
          r.project === req.project && r.slug === req.slug ? { ...r, pinned: req.pinned } : r,
        ),
      )
      setError(`置顶失败：${(err as Error).message}`)
    }
  }, [])

  const boardKeyboard = inMain && reqView === 'board' && !searchOpen

  useEffect(() => {
    if (!boardKeyboard) return
    // 详情页按 Esc 关闭时，这一层监听是在同一个 keydown 里新挂上的，Chrome 会把还没走完的
    // 这次按键也投给它——关详情不该顺手把选中态清掉。只接挂上之后发生的按键
    const attachedAt = performance.now()
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp < attachedAt) return
      if (shouldIgnore(e)) return
      const cur = posOf(focusColumns, focusSlug.current ?? '')
      // 带 ⌘⇧ 的组合键在控件上也接管
      if (shortcut(e, 'board.attention')) {
        e.preventDefault()
        const slot = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.slot')
        const hit = nextPetStop(attentionColumns, (slug) => attention.get(slug) ?? [], {
          pos: cur,
          session: slot?.dataset.session ?? '',
        })
        if (!hit) return
        pendingFold.current = false
        const at = posOf(attentionColumns, hit.slug)
        if (at?.status === PIN_STATUS) {
          const card = cardEl(hit.slug)
          const visible =
            !!card &&
            Array.from(card.querySelectorAll<HTMLElement>('.slot[data-session]')).some(
              (el) => el.dataset.session === hit.session,
            )
          const focus = { project, slug: hit.slug, session: hit.session }
          petFocusRef.current = focus
          setPetFocus(focus)
          setPinsOpen(true)
          if (!pinsOpen || !visible) {
            pendingFocus.current = hit.slug
            pendingPet.current = focus
            pendingFold.current = true
            return
          }
        } else if (at?.status === DONE_STATUS) {
          revealDone()
        } else {
          foldDone()
        }
        focusPetStop(hit.slug, hit.session)
        if (at?.status === PIN_STATUS) foldDone()
        return
      }
      // 卡片也带 role=button，但它就是这里要接管的
      const el = e.target as HTMLElement | null
      // 焦点停在卡片里的 agent 头像上：这时在头像之间走，单键不该把人带回卡片层
      if (isPetTarget(el)) return
      if (!el?.closest?.('.card') && isInteractiveTarget(el)) return
      let dir: BoardDir | null = null
      if (shortcut(e, 'board.next')) dir = 'down'
      else if (shortcut(e, 'board.prev')) dir = 'up'
      else if (shortcut(e, 'board.left')) dir = 'left'
      else if (shortcut(e, 'board.right')) dir = 'right'
      if (dir) {
        const settleDone = (slug: string) => {
          const req = currentItems.current.find((r) => r.slug === slug)
          if (req?.pinned) foldDone()
          else if (req?.status === DONE_STATUS) revealDone()
          else foldDone()
        }
        const focusDone = () => {
          revealDone()
          const first = byStatus.get(DONE_STATUS)?.[0]
          if (first) pendingFocus.current = first.slug
        }
        const focusedCard = focusSlug.current ? cardEl(focusSlug.current) : null
        const currentEl = focusedCard && visibleInBoard(focusedCard) ? focusedCard : null
        const cards = Array.from(
          document.querySelectorAll<HTMLElement>('.board-wrap .card[data-slug]'),
        ).filter(
          (node) =>
            node !== currentEl && !node.classList.contains('dragging') && visibleInBoard(node),
        )
        const targets: FocusCandidate[] = cards.map((node) => ({
          kind: 'card',
          slug: node.dataset.slug ?? '',
          rect: node.getBoundingClientRect(),
        }))
        const doneBar = document.querySelector<HTMLElement>('.board-wrap .column.collapsed')
        if (doneBar && visibleInBoard(doneBar) && (byStatus.get(DONE_STATUS)?.length ?? 0) > 0) {
          targets.push({ kind: 'done-bar', rect: doneBar.getBoundingClientRect() })
        }
        if (!currentEl) {
          const first = targets.find((t) => t.kind === 'card')
          if (first && first.kind === 'card') {
            e.preventDefault()
            settleDone(first.slug)
            moveFocus(first.slug)
          } else if (targets.some((t) => t.kind === 'done-bar')) {
            e.preventDefault()
            focusDone()
          }
          return
        }
        const target = nextCandidateInDirection(currentEl.getBoundingClientRect(), targets, dir)
        if (!target) return
        e.preventDefault()
        if (target.kind === 'done-bar') {
          focusDone()
          return
        }
        settleDone(target.slug)
        moveFocus(target.slug)
        return
      }
      const slug = focusSlug.current
      if (shortcut(e, 'board.open') && slug) {
        e.preventDefault()
        setDetail({ project, slug })
        return
      }
      if (shortcut(e, 'board.kids') && slug) {
        e.preventDefault()
        toggleKids(slug)
        return
      }
      if (shortcut(e, 'board.kid-n') && slug) {
        const parent = items.find((r) => r.slug === slug)
        const kids = parent ? childrenByParent.get(parent.id) : undefined
        const kid = kidsOpen.has(slug) ? kids?.[Number(e.key) - 1] : undefined
        if (kid) {
          e.preventDefault()
          jumpToChild(kid.slug)
        }
        return
      }
      if (shortcut(e, 'board.copy-slug') && slug) {
        e.preventDefault()
        void navigator.clipboard
          ?.writeText(slug)
          .then(() => setHint(`已复制 slug：${slug}`))
          .catch(() => {})
        return
      }
      if (shortcut(e, 'board.pin') && slug) {
        e.preventDefault()
        const req = currentItems.current.find((r) => r.slug === slug)
        if (req) void toggleRequirementPin(req, !req.pinned)
        return
      }
      if (shortcut(e, 'board.clear') && slug) {
        e.preventDefault()
        dropFocus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    boardKeyboard,
    jumpToChild,
    focusColumns,
    attentionColumns,
    byStatus,
    attention,
    project,
    toggleKids,
    items,
    childrenByParent,
    kidsOpen,
    moveFocus,
    focusPetStop,
    dropFocus,
    revealDone,
    foldDone,
    toggleRequirementPin,
    pinsOpen,
  ])

  /**
   * 父需求的子需求完成度。父子在版面上散在各列（`byStatus` 只按状态分列），
   * 卡片上这一行是唯一能看出「这串活还剩几块」的地方。
   */
  const childStats = useMemo(() => childStatsOf(items), [items])

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

  // 落点闪一下就好：它是「到了」的提示，不是常驻标记
  useEffect(() => {
    if (!flashSlug) return
    const timer = setTimeout(() => setFlashSlug(null), 1400)
    return () => clearTimeout(timer)
  }, [flashSlug])

  useEffect(() => {
    if (focusSlug.current && flashSlug && focusSlug.current !== flashSlug) setFlashSlug(null)
  }, [flashSlug])

  // 点父卡片上的子需求：先把它所在的那一列铺开，滚动交给上面的 effect


  const clearDrag = useCallback(() => {
    setDragSlug(null)
    setOverStatus(null)
  }, [])

  const handleDragEnd = useCallback(async ({ active, over }: DragEndEvent) => {
    clearDrag()
    if (!over || over.id === PIN_DROP_ID) return

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
  }, [clearDrag, items])

  const openCard = useCallback((slug: string) => setDetail({ project, slug }), [project])

  const dragItem = items.find((r) => r.slug === dragSlug) ?? null

  const boardView = useMemo(() => {
    if (!inMain || reqView !== 'board') return null
    return (
              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                onDragStart={({ active }: DragStartEvent) => {
                  setDragSlug(String(active.id))
                  moveFocus(String(active.id))
                }}
                onDragOver={({ over }: DragOverEvent) => setOverStatus(statusOf(over) ?? null)}
                onDragEnd={(e) => void handleDragEnd(e)}
                onDragCancel={clearDrag}
              >
                <div className="board-wrap">
                  {pinnedItems.length > 0 && (
                    <PinnedSection className={`pinned${pinsOpen ? '' : ' collapsed'}`}>
                      <button
                        type="button"
                        className="pinned-head"
                        aria-expanded={pinsOpen}
                        onClick={() => setPinsOpen((open) => !open)}
                        title={pinsOpen ? '收起置顶区' : '展开置顶区'}
                      >
                        <PinIcon />
                        <span>置顶</span>
                        <span className="n">{pinnedItems.length}</span>
                        {pinsOpen && <span className="pinned-hint">长期需求</span>}
                        <svg
                          className="pinned-fold"
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="6 15 12 9 18 15" />
                        </svg>
                      </button>
                      {pinsOpen && (
                        <div className="pinned-body">
                          {pinnedItems.map((r) => (
                            <Card
                              key={r.slug}
                              req={r}
                              sessions={sessionsByReq.get(r.id) ?? EMPTY_SESSIONS}
                              childStat={childStats.get(r.id)}
                              kids={childrenByParent.get(r.id)}
                              onJumpChild={jumpToChild}
                              flash={flashSlug === r.slug}
                              kidsOpen={kidsOpen.has(r.slug)}
                              onToggleKids={toggleKids}
                              onFocusCard={handleCardFocus}
                              onOpen={openCard}
                              onTag={filterByTag}
                              focusSession={
                                petFocus?.project === r.project && petFocus.slug === r.slug
                                  ? petFocus.session
                                  : undefined
                              }
                              onTogglePin={toggleRequirementPin}
                            />
                          ))}
                        </div>
                      )}
                    </PinnedSection>
                  )}
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
                        kidsOpen={kidsOpen}
                        onToggleKids={toggleKids}
                        onFocusCard={handleCardFocus}
                        onOpen={openCard}
                        onTag={filterByTag}
                        onTogglePin={toggleRequirementPin}
                        isOver={overStatus === status}
                        collapsed={status === DONE_STATUS && !doneOpen}
                        onToggleCollapsed={toggleDone}
                      />
                    ))}
                  </div>
                </div>
                <DragOverlay>
                  {dragItem ? (
                    <Card req={dragItem} sessions={sessionsByReq.get(dragItem.id) ?? []} overlay />
                  ) : null}
                </DragOverlay>
              </DndContext>
    )
  }, [inMain, reqView, sensors, moveFocus, handleDragEnd, clearDrag, statuses, byStatus,
    sessionsByReq, childStats, childrenByParent, jumpToChild, flashSlug, kidsOpen,
    toggleKids, handleCardFocus, openCard, filterByTag, overStatus, doneOpen, toggleDone, dragItem,
    pinnedItems, pinsOpen, toggleRequirementPin, petFocus])

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
    <div className={`shell${showSettings ? ' settings-open' : ''}${cmdHeld ? ' cmd-hints' : ''}`}>
      <main className="main-area">
        {showSettings ? (
          <Settings
            onBack={() => setShowSettings(false)}
            onApplied={refresh}
            theme={theme}
            onThemeChange={setTheme}
          />
        ) : todoTarget ? (
          <Detail
            target={todoTarget}
            onBack={() => {
              setTodoId(null)
              refresh()
            }}
            onOpenTodo={setTodoId}
            onOpenRequirement={openRequirement}
            projectRoot={projects.find((p) => p.slug === todoTarget.project)?.root}
          />
        ) : detailTarget ? (
          <Detail
            target={detailTarget}
            onBack={() => {
              setDetail(null)
              refresh()
            }}
            onOpenTodo={setTodoId}
            onOpenRequirement={openRequirement}
            projectRoot={projects.find((p) => p.slug === detailTarget.project)?.root}
          />
        ) : (
          <div className="app">
            <LeftRail
              projects={projects}
              active={project}
              pinned={pinnedLive}
              view={reqView}
              agentCount={agentCount}
              onSwitchProject={(slug) => void switchProject(slug)}
              onTogglePin={togglePin}
              onOpenProject={(slug) => setDetail({ project: slug, slug: null })}
              onSwitchView={(v) => setReqView(v)}
              onAgentFocus={() => setReqView((v) => (v === 'next' ? 'board' : 'next'))}
            />

            <div className="topbar">
              <div className="topbar-side" />

              <div className="topbar-side right">
                {/* 筛选标记常驻：关掉面板后看板少了卡片，得有东西解释为什么少；「下一步」不吃这套筛 */}
                {reqView !== 'next' && query.trim() && (
                  <button
                    className="filter-chip"
                    title={`点一下继续改筛选词（${shortcutLabel('global.clear-filter')} 清掉）`}
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
              </div>
            </div>

            {error && <div className="notice">{error}</div>}
            {hint && <div className="notice ok">{hint}</div>}

            {reqView === 'board' ? (
              boardView
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
                onOpen={openCard}
                onBack={() => setReqView('board')}
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
          onPick={(slug, clear) => {
            setSearchOpen(false)
            if (clear) {
              setQuery('')
              setHits(null)
            }
            openRequirement(project, slug)
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {projectPicker && inMain && (
        <ProjectSwitcher
          projects={projects}
          active={project}
          pinned={pinned}
          onPick={(slug) => {
            setProjectPicker(false)
            void switchProject(slug)
          }}
          onOpen={(slug) => {
            setProjectPicker(false)
            setDetail({ project: slug, slug: null })
          }}
          onTogglePin={togglePin}
          onClose={() => setProjectPicker(false)}
        />
      )}
    </div>
  )
}
