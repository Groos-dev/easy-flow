import { useLanguageSync, useLanguage } from '../lib/language'
import { t as tr } from "../../../shared/i18n.ts"
import { workspaceOpenHint, workspaceOpenNotice } from '../../../shared/agents.ts'
import type { AgentId } from '../../../shared/domain.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import { reuseRows } from '../lib/rows'
import { isComposing, shortcut } from '../lib/keys'
import { AGENT_LABELS } from '../lib/labels'
import {
  buildMiniBlocks, miniSearchTokens, miniSessionOpenable, miniTime, type MiniAction,
} from '../lib/mini'
import { moveKey, resolveKey } from '../lib/selection'
import { isEventState } from '../lib/threads'
import { PET_LABEL } from '../lib/pets'
import { useTheme } from '../lib/theme'
import type { Requirement, Session } from '../lib/types'
import { AgentIcon, ChevronIcon, GoIcon, LinkIcon, MergeIcon, SearchIcon } from '../components/icons'

type NavItem = { key: string; kind: 'req'; project: string; slug: string } | MiniAction

const PRODUCT_ICONS: Record<string, string> = {
  codex: 'agents/codex.png',
  claude: 'agents/claude.png',
  cursor: 'agents/cursor.png',
  chengxiaobang: 'agents/chengxiaobang.png',
  antigravity: 'agents/antigravity.png',
} satisfies Record<AgentId, string>

export default function MiniApp() {
  useLanguageSync()
  const [rows, setRows] = useState<Array<{ req: Requirement; projectName: string }>>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [expanded, setExpanded] = useState('')
  const [expandedSessions, setExpandedSessions] = useState(false)
  const [expandedLinks, setExpandedLinks] = useState(false)
  const [error, setError] = useState('')
  const [openNotice, setOpenNotice] = useState('')
  const [ready, setReady] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const pointer = useRef({ x: -1, y: -1 })
  const syncedAt = useRef(0)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const keyMoved = useRef(false)

  const load = useCallback(async () => {
    try {
      const [tree, sess] = await Promise.all([api.tree(), api.sessions()])
      const rows = tree.tree.flatMap(p => p.requirements.map(req => ({ req, projectName: p.name || p.slug })))
      setRows(previous => reuseRows(previous, rows, r => `${r.req.project}:${r.req.slug}`))
      setSessions(previous => reuseRows(previous, sess.sessions, s => `${s.agent}:${s.session}`))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReady(true)
    }
  }, [])

  const refresh = useCallback(async () => {
    await load()
    if (Date.now() - syncedAt.current < 2000) return
    syncedAt.current = Date.now()
    try {
      const { sync } = await api.resync()
      if (sync.projects?.length || sync.added.length || sync.updated.length || sync.missing.length || sync.restored.length) await load()
    } catch {
      // 当前快照继续可用，后续巡检重试同步。
    }
  }, [load])

  const reset = useCallback(() => {
    setQuery('')
    setExpanded('')
    setExpandedSessions(false)
    setExpandedLinks(false)
    setSelectedKey('')
    inputRef.current?.focus()
  }, [])
  const { reloadTheme } = useTheme()

  useEffect(() => {
    void reloadTheme()
    void refresh()
    inputRef.current?.focus()
    const off = window.easyFlow?.onPanelShown?.(() => {
      void reloadTheme()
      void refresh()
      reset()
    })
    return () => off?.()
  }, [reloadTheme, refresh, reset])

  const words = useMemo(() => miniSearchTokens(query), [query])
  const blocks = useMemo(
    () => buildMiniBlocks({ rows, sessions, query, expanded, expandedSessions, expandedLinks }),
    [rows, sessions, query, expanded, expandedSessions, expandedLinks],
  )
  const items = useMemo<NavItem[]>(() => blocks.flatMap((b) => [
    { key: b.key, kind: 'req' as const, project: b.req.project, slug: b.req.slug },
    ...b.children.filter((c) => c.kind !== 'session' || miniSessionOpenable(c.session)),
  ]), [blocks])
  const keys = useMemo(() => items.map((it) => it.key), [items])
  const selKey = resolveKey(keys, selectedKey)
  const selected = items.find((it) => it.key === selKey)

  useEffect(() => { setSelectedKey('') }, [query])

  useEffect(() => {
    if (expanded) rowRefs.current.get(expanded)?.scrollIntoView({ block: 'nearest' })
  }, [expanded])

  useEffect(() => {
    if (!selectedKey || !keyMoved.current) return
    keyMoved.current = false
    rowRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])

  function toggle(project: string, slug: string) {
    const key = `${project}:${slug}`
    setExpanded((prev) => prev === key ? '' : key)
    setExpandedSessions(false)
    setExpandedLinks(false)
  }

  // 展开把行推到静止的指针下方时，不覆盖键盘选中。
  function hover(e: React.MouseEvent, key: string) {
    const moved = e.clientX !== pointer.current.x || e.clientY !== pointer.current.y
    pointer.current = { x: e.clientX, y: e.clientY }
    if (moved) setSelectedKey(key)
  }

  async function openSession(session: Session) {
    if (!miniSessionOpenable(session)) return
    setError('')
    setOpenNotice('')
    try {
      if (session.link) {
        if (window.easyFlow?.openExternal) await window.easyFlow.openExternal(session.link)
        else window.open(session.link, '_blank')
      } else {
        const opened = await api.openSessionWorkspace(session.agent, session.session)
        const notice = workspaceOpenNotice(opened)
        setOpenNotice(notice)
        if (opened.manualWorkspaceSelection || notice) return
      }
      // 已查看登记失败不阻断打开会话。
      void api.markSessionClicked(session.agent, session.session).catch(() => {})
      window.easyFlow?.hidePanel?.()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function activate(item: NavItem | undefined) {
    if (!item) return
    if (item.kind === 'req') toggle(item.project, item.slug)
    else if (item.kind === 'more') {
      if (item.group === 'sessions') setExpandedSessions((prev) => !prev)
      else setExpandedLinks((prev) => !prev)
    } else if (item.kind === 'session') void openSession(item.session)
    else {
      window.open(item.url, '_blank')
      window.easyFlow?.hidePanel?.()
    }
  }

  function openDetail(project: string, slug: string) {
    void window.easyFlow?.openRequirement?.({ project, slug })
    window.easyFlow?.hidePanel?.()
  }

  function close() {
    if (query) setQuery('')
    else if (expanded) setExpanded('')
    else window.easyFlow?.hidePanel?.()
    inputRef.current?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (isComposing(e.nativeEvent)) return
    if (shortcut(e, 'mini.open-detail')) {
      e.preventDefault()
      if (selected) openDetail(selected.project, selected.slug)
      return
    }
    if (shortcut(e, 'mini.nth')) {
      e.preventDefault()
      const block = blocks[Number(e.key) - 1]
      if (block) openDetail(block.req.project, block.req.slug)
      return
    }
    if (shortcut(e, 'mini.next') || shortcut(e, 'mini.prev')) {
      e.preventDefault()
      keyMoved.current = true
      setSelectedKey(moveKey(keys, selectedKey, shortcut(e, 'mini.next') ? 1 : -1))
      inputRef.current?.focus()
      return
    }
    // 搜索文字的左右键交给输入框移动光标。
    if (e.target === inputRef.current && query && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
    if (shortcut(e, 'mini.expand')) {
      e.preventDefault()
      if (selected?.kind === 'req' && expanded !== selected.key) toggle(selected.project, selected.slug)
      return
    }
    if (shortcut(e, 'mini.collapse')) {
      e.preventDefault()
      if (!selected) return
      const key = `${selected.project}:${selected.slug}`
      if (selected.kind !== 'req') setSelectedKey(key)
      else if (expanded === key) setExpanded('')
      inputRef.current?.focus()
      return
    }
    if (shortcut(e, 'mini.activate')) {
      e.preventDefault()
      if (e.target === inputRef.current) activate(selected)
      else if (e.target instanceof HTMLElement) e.target.closest('button')?.click()
      return
    }
    if (shortcut(e, 'mini.close')) {
      e.preventDefault()
      close()
    }
  }

  function highlight(text: string) {
    if (!words.length) return text
    const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    return text.split(new RegExp(`(${pattern})`, 'ig')).map((part, i) =>
      words.includes(part.toLowerCase()) ? <mark key={i}>{part}</mark> : part,
    )
  }

  function actionRow(action: MiniAction) {
    const on = selKey === action.key
    const off = action.kind === 'session' && !miniSessionOpenable(action.session)
    let title: string | undefined
    let content: ReactNode
    if (action.kind === 'session') {
      const session = action.session
      const attention = isEventState(session.status.state)
      const parts = [AGENT_LABELS[session.agent] ?? session.agent, session.title || session.session]
      if (attention) parts.push(session.status.needsAction || PET_LABEL[session.status.state])
      if (off) parts.push(tr("No session link is available"))
      // 能打开却没有链接，只剩打开工作区这一条路
      else if (!session.link) parts.push(workspaceOpenHint(session))
      title = parts.join(' · ')
      const image = PRODUCT_ICONS[session.agent]
      content = <>
        <span className={`mini-agent-icon${attention ? ' mini-needs-input' : ''}`}>
          {image
            ? <img src={image} alt="" aria-hidden="true" />
            : <AgentIcon agent={session.agent} size={18} />}
        </span>
        <span className={`mini-val${session.title ? '' : ' mono'}`}>
          {session.title || session.session}
        </span>
      </>
    } else if (action.kind === 'link') {
      title = action.url
      content = <>
        <span className="mini-ico">{action.type === 'MR' ? <MergeIcon /> : <LinkIcon />}</span>
        <span className="mini-val">{action.value}</span>
        <span className="mini-go"><GoIcon /></span>
      </>
    } else {
      content = action.expanded ? tr("Collapse") : tr("{0} more", [action.remaining])
    }
    return (
      <button
        type="button"
        key={action.key}
        ref={(el) => {
          if (el) rowRefs.current.set(action.key, el)
          else rowRefs.current.delete(action.key)
        }}
        className={`${action.kind === 'more' ? 'mini-more' : 'mini-act'}${on ? ' on' : ''}`}
        title={title}
        aria-label={action.kind === 'session' ? title : undefined}
        aria-expanded={action.kind === 'more' ? action.expanded : undefined}
        disabled={off}
        onFocus={() => setSelectedKey(action.key)}
        onMouseEnter={(e) => { if (!off) hover(e, action.key) }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setSelectedKey(action.key)
          activate(action)
        }}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="mini" onKeyDown={onKeyDown}>
      <div className="mini-drag" />
      <div className="mini-head">
        <div className="mini-search">
          <SearchIcon />
          <input
            ref={inputRef}
            aria-label={tr("Search requirements or projects")}
            aria-controls="mini-results"
            placeholder={tr("Search requirements, projects…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button type="button" className="mini-esc" aria-label={query ? tr("Clear search") : expanded ? tr("Collapse actions") : tr("Hide panel")} onClick={close}>esc</button>
        </div>
        <div className="mini-scope">
          <span>{words.length ? tr("Search results") : tr("Recent tasks")}</span>
          {ready && <span aria-live="polite">{blocks.length} {blocks.length === 1 ? tr("item") : tr("items")}</span>}
        </div>
      </div>
      <div className="mini-list" id="mini-results">
        {error && <div className="notice" role="alert">{error}</div>}
        {openNotice && <div className="notice" role="status">{openNotice}</div>}
        {!error && !ready && <MiniSkeleton />}
        {!error && ready && blocks.length === 0 && <div className="mini-empty">{tr("No matching requirements")}</div>}
        {blocks.map((block) => {
          const open = expanded === block.key
          return (
            <section
              key={block.key}
              ref={(el) => {
                if (el) rowRefs.current.set(block.key, el)
                else rowRefs.current.delete(block.key)
              }}
              className={`mini-card${selKey === block.key || selKey.startsWith(`${block.key}|`) ? ' on' : ''}${open ? ' expanded' : ''}`}
            >
              <button
                type="button"
                className="mini-top"
                title={`${block.req.title}${!open && block.needsHuman ? tr(" · A session needs attention") : ''}`}
                aria-expanded={open}
                aria-controls={`mini-actions-${block.req.id}`}
                onFocus={() => setSelectedKey(block.key)}
                onMouseEnter={(e) => hover(e, block.key)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSelectedKey(block.key)
                  toggle(block.req.project, block.req.slug)
                }}
              >
                <span className="mini-title">{highlight(block.req.title || block.req.slug)}</span>
                <span className={`mini-caret${!open && block.needsHuman ? ' mini-needs-input' : ''}`}>
                  <ChevronIcon dir={open ? 'down' : 'right'} />
                </span>
              </button>
              <div className="mini-foot">
                <span className="mini-proj">{highlight(block.projectName)}</span>
                <span className="mini-time">{miniTime(block.active)}</span>
              </div>
              <div id={`mini-actions-${block.req.id}`} hidden={!open}>
                {open && (['sessions', 'links'] as const).map((group) => {
                  const actions = block.children.filter((c) => c.kind === 'more' ? c.group === group : c.kind === (group === 'sessions' ? 'session' : 'link'))
                  if (!actions.length) return null
                  return (
                    <div className="mini-acts" key={group}>
                      <div className="mini-group">
                        <span>{group === 'sessions' ? tr("Sessions") : tr("Links")}</span>
                        {actions.filter((c) => c.kind === 'more').map(actionRow)}
                      </div>
                      {actions.filter((c) => c.kind !== 'more').map(actionRow)}
                    </div>
                  )
                })}
                {open && block.children.length === 0 && <div className="mini-empty">{tr("No sessions or links yet")}</div>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function MiniSkeleton() {
  useLanguage()
  return <>{[0, 1, 2].map((i) => (
    <div className="mini-card mini-skel" key={i}>
      <div className="mini-top"><span className="mini-skel-bar" /></div>
      <div className="mini-foot">
        <span className="mini-skel-bar short" /><span className="mini-skel-bar tiny" />
      </div>
    </div>
  ))}</>
}
