import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api } from '../lib/api'
import { isComposing, isEditableTarget, shortcut } from '../lib/keys'
import { AGENT_LABELS } from '../lib/labels'
import { linkLabel, PIPELINE_ICON, PIPELINE_LABEL, showsPipeline } from '../lib/links'
import { BOARD_POLL_MS } from '../lib/time'
import {
  TODO_STATUS_LABEL,
  type CodeLinkStatus,
  type ContextLive,
  type ContextPayload,
  type Requirement,
  type Session,
  type Todo,
} from '../lib/types'
import { CopyButton, InfoBlock } from './InfoBits'
import { AgentIcon } from './icons'
import LaunchSession from './LaunchSession'

/**
 * 需求详情页的信息浮窗。打开时用详情页已加载的 /api/context 摆第一版，
 * 之后按看板的节奏从 /api/context/live 续——ctx 本身只是一份快照。
 *
 * 待办分两段：登记过的归属与由来源会话推出来的候选，后者行尾标「未确认」。
 */
export default function InfoPanel({
  req,
  ctx,
  onOpenTodo,
  launchSignal = 0,
}: {
  req: Requirement
  ctx: ContextPayload | null
  // 点一条关联待办即在详情页打开它
  onOpenTodo: (id: string) => void
  launchSignal?: number
}) {
  const [live, setLive] = useState<ContextLive | null>(null)
  const liveError = useRef('')
  const slug = req.slug
  const project = req.project

  // 会话、工作区、待办归属会被 CLI 或另一个窗口改掉，所以要每秒续一次
  // 读口只查库：不重扫需求目录，也不读 requirement.md
  useEffect(() => {
    let alive = true
    let inFlight = false
    const tick = async () => {
      // 后台没人看；上一轮没回来不叠发
      if (document.hidden || inFlight) return
      inFlight = true
      try {
        const data = await api.contextLive(slug, project)
        if (alive) setLive(data)
        liveError.current = ''
      } catch (err) {
        // 浮窗继续用上一份数据，但失败必须留痕：静默下去就是「看着新、其实冻住了」
        const message = (err as Error).message
        if (liveError.current !== message) {
          liveError.current = message
          console.warn(`[info-panel] 浮窗刷新失败（${project}/${slug}）：${message}`)
        }
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(tick, BOARD_POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [slug, project])

  const data = live ?? ctx
  const worktrees = data?.worktrees ?? []
  const sessions = data?.sessions ?? []
  // 只列未完成的：已完成 / 已取消的不占版面
  const stillOpen = (t: Todo) => t.status === 'todo' || t.status === 'in_progress'
  const openTodos = (data?.todos ?? []).filter(stillOpen)
  // 由来源会话推出来的归属：没写进库，所以标出来，别让人误以为已经挂上了
  const candidateTodos = (data?.candidateTodos ?? []).filter(stillOpen)

  // 按 URL 列表做依赖：看板轮询换新对象时不重复请求
  const codeUrls = req.linkItems.map((l) => l.url).join('\n')
  const [linkStates, setLinkStates] = useState<Record<string, CodeLinkStatus>>({})
  useEffect(() => {
    if (!codeUrls) return
    let alive = true
    const load = () => {
      api
        .codeLinkStatuses(codeUrls.split('\n'))
        .then((r) => {
          if (alive) setLinkStates(r.statuses)
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [codeUrls])

  const links = req.linkItems.map((l) => ({ label: linkLabel(l), url: l.url, status: linkStates[l.url] }))

  const openDir = () => void api.open(req.slug, req.project).catch(() => {})

  const panelRef = useRef<HTMLDivElement>(null)

  // j/k 移动焦点；Enter 交给元素自己，输入框与编辑器里让位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e) || isEditableTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const dir = shortcut(e, 'info.next') ? 1 : shortcut(e, 'info.prev') ? -1 : 0
      if (!dir) return
      const focused = document.activeElement as HTMLElement | null
      const scope = focused?.closest?.('.new-sess') ?? panelRef.current
      if (!scope) return
      const rows = Array.from(
        scope.querySelectorAll<HTMLElement>('[data-info-row]'),
      ).filter((el) => !el.matches(':disabled'))
      if (!rows.length) return
      e.preventDefault()
      const at = rows.indexOf(document.activeElement as HTMLElement)
      const next = at < 0 ? 0 : Math.min(Math.max(at + dir, 0), rows.length - 1)
      rows[next].focus()
      rows[next].scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="info-panel"
      role="dialog"
      aria-label="需求信息与链接"
      ref={panelRef}
    >
      {/* 数据未到时不能把空列表误当成需求没有会话 */}
      {data && (
        <InfoBlock label="会话" count={sessions.length}>
          {sessions.map((s) => (
            <SessionRow key={`${s.agent}:${s.session}`} session={s} />
          ))}
          {/* 入口跟在会话列表后面 */}
          <LaunchSession req={req} worktrees={worktrees} openSignal={launchSignal} />
        </InfoBlock>
      )}

      {/* 没有工作区就整段不出现——空列表本身不携带信息 */}
      {worktrees.length > 0 && (
        <InfoBlock label="worktree" count={worktrees.length}>
          {worktrees.map((w) => (
            <div
              className={`path-row${w.missing ? ' off' : ''}`}
              key={w.id}
              data-info-row={w.missing ? undefined : ''}
              role={w.missing ? undefined : 'button'}
              tabIndex={w.missing ? undefined : 0}
              title={w.missing ? `目录已失联：${w.path}` : `在目录里打开：${w.path}（右键或 ⌥ 选打开方式）`}
              onClick={
                w.missing
                  ? undefined
                  : (e) => openDirWith(e, w.path, () => void api.openWorktree(w.id).catch(() => {}))
              }
              onContextMenu={
                w.missing
                  ? undefined
                  : (e) => {
                      e.preventDefault()
                      openWithMenu(w.path)
                    }
              }
              onKeyDown={(e) => {
                if (!w.missing && e.key === 'Enter') void api.openWorktree(w.id).catch(() => {})
              }}
            >
              <span className="pr-name">
                <span className="repo line mono">{w.repo}</span>
                <span className="branch line">· {w.branch}</span>
              </span>
              {w.missing ? <span className="wt-missing">目录已失联</span> : <span className="go">↗</span>}
            </div>
          ))}
        </InfoBlock>
      )}

      {/* 关联待办：todo 侧登记了指针的那些。只列未完成的，颜色区分状态 */}
      {openTodos.length > 0 && (
        <InfoBlock label="关联待办" count={openTodos.length}>
          {openTodos.map((t) => (
            <TodoRow key={t.id} todo={t} onOpenTodo={onOpenTodo} />
          ))}
        </InfoBlock>
      )}

      {/*
       * 候选归属：来源会话登记在本需求上、但待办自己没写指针的那些。
       * 与上一段分开摆，因为「推出来的」和「登记过的」不是一回事——合并成一列，
       * 人会把推断当成事实，指针也就再没人回填了。
       */}
      {candidateTodos.length > 0 && (
        <InfoBlock label="待确认归属" count={candidateTodos.length}>
          {candidateTodos.map((t) => (
            <TodoRow key={t.id} todo={t} onOpenTodo={onOpenTodo} candidate />
          ))}
        </InfoBlock>
      )}

      {links.length > 0 && (
        <InfoBlock label="链接" count={links.length}>
          {links.map((it) => (
            <div className="link-line" key={it.url}>
              <a
                className="line info-link"
                data-info-row=""
                href={it.url}
                target="_blank"
                rel="noreferrer"
                title={it.url}
              >
                {it.label}
              </a>
              {it.status && <CodeLinkStatusCell status={it.status} />}
            </div>
          ))}
        </InfoBlock>
      )}

      {/* 一条路径不值得再占一个小标题，压成末行 */}
      <div className="path-row foot">
        <span
          className="foot-path line mono"
          data-info-row=""
          role="button"
          tabIndex={0}
          title={`${req.path}（右键或 ⌥ 选打开方式）`}
          onClick={(e) => openDirWith(e, req.path, openDir)}
          onContextMenu={(e) => {
            e.preventDefault()
            openWithMenu(req.path)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') openDir()
          }}
        >
          {req.path}
        </span>
        <CopyButton text={req.path} label="路径" />
      </div>
    </div>
  )
}

// 链接行末尾的状态：流水线图标（只在 open 时）+ 定宽状态列
export function CodeLinkStatusCell({ status }: { status: CodeLinkStatus }) {
  return (
    <>
      {showsPipeline(status) && status.pipeline && (
        <span
          className="link-pipe"
          data-pipeline={status.pipeline}
          title={`流水线：${PIPELINE_LABEL[status.pipeline]}`}
        >
          {PIPELINE_ICON[status.pipeline]}
        </span>
      )}
      <span className="link-state" data-state={status.state} title={`状态：${status.state}`}>
        <span className="dot" />
        {status.state}
      </span>
    </>
  )
}

/**
 * 一条待办：状态点 + 标题，整行点开。
 * candidate 是推出来的归属，行尾挂一句说明。
 */
function TodoRow({
  todo,
  onOpenTodo,
  candidate = false,
}: {
  todo: Todo
  onOpenTodo: (id: string) => void
  candidate?: boolean
}) {
  const label = TODO_STATUS_LABEL[todo.status] ?? todo.status
  return (
    <div
      className="sess"
      data-info-row=""
      role="button"
      tabIndex={0}
      title={
        candidate
          ? `来源会话在这条需求上，但待办没写归属。确认后补上：easy-flow todo set ${todo.id} --req <req-…>`
          : '在详情页打开这条待办'
      }
      onClick={() => onOpenTodo(todo.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpenTodo(todo.id)
      }}
    >
      <span className="sess-agent">
        <span className="todo-dot" data-status={todo.status} />
        {label}
      </span>
      <span className="sess-title line" title={todo.title}>
        {todo.title}
      </span>
      {candidate && <span className="todo-candidate">未确认</span>}
      <span className="sess-go">↗</span>
    </div>
  )
}

/**
 * 目录那一行的「用什么打开」：右键或 ⌥ 点，弹主进程的原生菜单。
 * 拿不到桥（浏览器开发）就当没这回事——浮窗里不为它多摆任何常驻元素。
 */
function openWithMenu(path: string): void {
  void window.easyFlow?.openWithMenu?.({ path }).catch(() => {})
}

// ⌥ 点 = 自己选打开方式；普通点 = 默认那个（访达）
function openDirWith(e: MouseEvent, path: string, openDefault: () => void): void {
  if (e.altKey) {
    openWithMenu(path)
    return
  }
  openDefault()
}

// 会话没登记标题时的兜底：拿登记目录的末段（通常就是工作区名），比留一行空的强
function sessionTitle(s: Session): string {
  return s.title || s.cwd.split('/').filter(Boolean).pop() || s.session
}

function SessionRow({ session }: { session: Session }) {
  const agent = AGENT_LABELS[session.agent] ?? session.agent
  const title = sessionTitle(session)
  const canFocusWorkspace = session.agent === 'cursor' && !!session.cwd
  const [opening, setOpening] = useState(false)
  const [focusError, setFocusError] = useState('')
  const openWorkspace = () => {
    if (!canFocusWorkspace || opening) return
    setOpening(true)
    setFocusError('')
    void api
      .openSessionWorkspace(session.agent, session.session)
      .catch((error: Error) => setFocusError(error.message || '打开失败'))
      .finally(() => setOpening(false))
  }
  const body = (
    <>
      <span className="sess-agent">
        <AgentIcon agent={session.agent} />
        {agent}
      </span>
      <span className="sess-title line" title={title}>
        {title}
      </span>
      {focusError && <span className="sess-error">{focusError}</span>}
      {(session.link || canFocusWorkspace) && <span className="sess-go">↗</span>}
    </>
  )

  if (!session.link) {
    return (
      <div
        className={`sess ${canFocusWorkspace ? '' : 'sess-off'}`}
        data-info-row=""
        role={canFocusWorkspace ? 'button' : undefined}
        tabIndex={0}
        onClick={openWorkspace}
        onKeyDown={(e) => {
          if (canFocusWorkspace && e.key === 'Enter') openWorkspace()
        }}
        title={
          canFocusWorkspace
            ? `在 Cursor 里打开这条会话所在的工作区（不直达会话）：${session.session}`
            : `这条会话没有会话级链接，去 ${agent} 里找：${session.session}`
        }
      >
        {body}
      </div>
    )
  }

  return (
    <a
      className="sess"
      data-info-row=""
      href={session.link}
      target="_blank"
      rel="noreferrer"
      title={`在 ${agent} 里打开`}
    >
      {body}
    </a>
  )
}
