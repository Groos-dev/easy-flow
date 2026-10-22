import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api } from '../lib/api'
import { isComposing, isEditableTarget, shortcut } from '../lib/keys'
import { AGENT_LABELS } from '../lib/labels'
import { codeLinkLabel, feishuTaskLabel, PIPELINE_ICON, PIPELINE_LABEL, showsPipeline } from '../lib/links'
import {
  TODO_STATUS_LABEL,
  type CodeLinkStatus,
  type ContextPayload,
  type Requirement,
  type Session,
} from '../lib/types'
import { CopyButton, InfoBlock } from './InfoBits'
import { AgentIcon } from './icons'
import LaunchSession from './LaunchSession'

/**
 * 需求详情页的信息浮窗。数据来自详情页已加载的 /api/context。
 */
export default function InfoPanel({
  req,
  ctx,
  onOpenTodo,
  launchSignal = 0,
}: {
  req: Requirement
  ctx: ContextPayload | null
  /** 点一条关联待办即在详情页打开它 */
  onOpenTodo: (id: string) => void
  launchSignal?: number
}) {
  const worktrees = ctx?.worktrees ?? []
  const sessions = ctx?.sessions ?? []
  // 只列未完成的：已完成 / 已取消的不占版面
  const openTodos = (ctx?.todos ?? []).filter((t) => t.status === 'todo' || t.status === 'in_progress')

  // 按 URL 列表做依赖：看板轮询换新对象时不重复请求
  const codeUrls = req.codeLinks.map((l) => l.url).join('\n')
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

  const groups: Array<{
    title: string
    items: Array<{ label: string; url: string; status?: CodeLinkStatus }>
  }> = [
    { title: '飞书任务', items: req.feishuTaskLinks.map((url) => ({ label: feishuTaskLabel(url), url })) },
    {
      title: '代码链接',
      items: req.codeLinks.map((l) => ({ label: codeLinkLabel(l), url: l.url, status: linkStates[l.url] })),
    },
    { title: '扩展链接', items: req.extLinks.map((l) => ({ label: l.detail, url: l.url })) },
  ].filter((g) => g.items.length)

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
      {/* ctx 未到时不能把空列表误当成需求没有会话 */}
      {ctx && (
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

      {/* 关联待办：立项时在 todo 侧登记的指针反查出来的。只列未完成的，颜色区分状态 */}
      {openTodos.length > 0 && (
        <InfoBlock label="关联待办" count={openTodos.length}>
          {openTodos.map((t) => {
            const label = TODO_STATUS_LABEL[t.status] ?? t.status
            return (
              <div
                className="sess"
                key={t.id}
                data-info-row=""
                role="button"
                tabIndex={0}
                title="在详情页打开这条待办"
                onClick={() => onOpenTodo(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onOpenTodo(t.id)
                }}
              >
                <span className="sess-agent">
                  <span className="todo-dot" data-status={t.status} />
                  {label}
                </span>
                <span className="sess-title line" title={t.title}>
                  {t.title}
                </span>
                <span className="sess-go">↗</span>
              </div>
            )
          })}
        </InfoBlock>
      )}

      {groups.length > 0 && (
        <InfoBlock label="链接" count={groups.reduce((n, g) => n + g.items.length, 0)}>
          {groups.map((g) =>
            g.items.map((it, index) => (
              <div className="link-line" key={`${g.title}:${it.url}`}>
                {/* 一组只标一次名，同组的其余几条跟着对齐 */}
                <span className="k">{index === 0 ? g.title : ''}</span>
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
            )),
          )}
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

/** 链接行末尾的状态：流水线图标（只在 open 时）+ 定宽状态列 */
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
 * 目录那一行的「用什么打开」：右键或 ⌥ 点，弹主进程的原生菜单。
 * 拿不到桥（浏览器开发）就当没这回事——浮窗里不为它多摆任何常驻元素。
 */
function openWithMenu(path: string): void {
  void window.easyFlow?.openWithMenu?.({ path }).catch(() => {})
}

/** ⌥ 点 = 自己选打开方式；普通点 = 默认那个（访达） */
function openDirWith(e: MouseEvent, path: string, openDefault: () => void): void {
  if (e.altKey) {
    openWithMenu(path)
    return
  }
  openDefault()
}

/** 会话没登记标题时的兜底：拿登记目录的末段（通常就是工作区名），比留一行空的强 */
function sessionTitle(s: Session): string {
  return s.title || s.cwd.split('/').filter(Boolean).pop() || s.session
}

/**
 * 没有 deeplink 的会话（终端里的 claude、cursor）不给假链接，整行只是"有这么条会话"。
 */
function SessionRow({ session }: { session: Session }) {
  const agent = AGENT_LABELS[session.agent] ?? session.agent
  const title = sessionTitle(session)
  const body = (
    <>
      <span className="sess-agent">
        <AgentIcon agent={session.agent} />
        {agent}
      </span>
      <span className="sess-title line" title={title}>
        {title}
      </span>
      {session.link && <span className="sess-go">↗</span>}
    </>
  )

  if (!session.link) {
    return (
      <div
        className="sess sess-off"
        data-info-row=""
        tabIndex={0}
        title={`这条会话没有会话级链接，去 ${agent} 里找：${session.session}`}
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
