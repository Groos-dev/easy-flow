import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { isComposing, shortcut } from '../lib/keys'
import { AGENT_LABELS, THREAD_STATE_CLASS } from '../lib/labels'
import { buildMiniBlocks, miniTime, sessionActive, type MiniAction } from '../lib/mini'
import { moveKey, resolveKey } from '../lib/selection'
import { badgesOf } from '../lib/threads'
import type { Requirement, Session } from '../lib/types'
import {
  AgentIcon,
  ChevronIcon,
  DocIcon,
  GoIcon,
  LinkIcon,
  MergeIcon,
  SearchIcon,
} from '../components/icons'

type NavItem = { key: string; kind: 'req'; project: string; slug: string } | MiniAction

export default function MiniApp() {
  const [rows, setRows] = useState<Array<{ req: Requirement; projectName: string }>>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [expanded, setExpanded] = useState('')
  const [error, setError] = useState('')
  /** 首份数据到手前画骨架 */
  const [ready, setReady] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const pointer = useRef({ x: -1, y: -1 })
  const syncedAt = useRef(0)
  /** 卡片与动作行的节点：展开、键盘移动时滚进视野 */
  const rowRefs = useRef(new Map<string, HTMLElement>())
  /** 只有键盘挪的选中才跟着滚，鼠标划过不让列表跳 */
  const keyMoved = useRef(false)

  const load = useCallback(async () => {
    try {
      const [tree, sess] = await Promise.all([api.tree(), api.sessions()])
      setRows(
        tree.tree.flatMap((p) =>
          p.requirements.map((req) => ({ req, projectName: p.name || p.slug })),
        ),
      )
      setSessions(sess.sessions)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReady(true)
    }
  }, [])

  /** 先读库画骨架，再让服务端扫目录；两秒内重复呼出不重扫 */
  const refresh = useCallback(async () => {
    await load()
    if (Date.now() - syncedAt.current < 2000) return
    syncedAt.current = Date.now()
    try {
      await api.resync()
    } catch {
      return
    }
    await load()
  }, [load])

  const reset = useCallback(() => {
    setQuery('')
    setExpanded('')
    setSelectedKey('')
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    void refresh()
    inputRef.current?.focus()
    const off = window.easyFlow?.onPanelShown?.(() => {
      void refresh()
      reset()
    })
    return () => off?.()
  }, [refresh, reset])

  const blocks = useMemo(
    () => buildMiniBlocks({ rows, sessions, query, expanded }),
    [rows, sessions, query, expanded],
  )

  const items = useMemo<NavItem[]>(
    () =>
      blocks.flatMap((b) => [
        { key: b.key, kind: 'req' as const, project: b.req.project, slug: b.req.slug },
        ...b.children,
      ]),
    [blocks],
  )
  const keys = useMemo(() => items.map((it) => it.key), [items])
  const selKey = resolveKey(keys, selectedKey)
  const selIdx = keys.indexOf(selKey)

  useEffect(() => {
    setSelectedKey('')
  }, [query])

  // 展开的卡片长高了，只滚到刚好看全
  useEffect(() => {
    if (!expanded) return
    rowRefs.current.get(expanded)?.scrollIntoView({ block: 'nearest' })
  }, [expanded])

  // 鼠标 hover 也写 selectedKey，所以得分清来源
  useEffect(() => {
    if (!selectedKey || !keyMoved.current) return
    keyMoved.current = false
    rowRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])

  function toggle(project: string, slug: string) {
    const key = `${project}:${slug}`
    setExpanded((prev) => (prev === key ? '' : key))
  }

  /**
   * 只认指针真的动过的那种 hover：展开动作行会把下面的行顶到静止的指针底下，
   * 浏览器会为此再发一次 mouseenter，不拦的话按 Enter 展开后选中会跳走。
   */
  function hover(e: React.MouseEvent, key: string) {
    const moved = e.clientX !== pointer.current.x || e.clientY !== pointer.current.y
    pointer.current = { x: e.clientX, y: e.clientY }
    if (moved) setSelectedKey(key)
  }

  function openSession(s: Session) {
    if (!s.link) return
    window.open(s.link, '_blank')
    window.easyFlow?.hidePanel?.()
  }

  function activate(item: NavItem | undefined) {
    if (!item) return
    if (item.kind === 'req') {
      toggle(item.project, item.slug)
      return
    }
    if (item.kind === 'detail') {
      void window.easyFlow?.openRequirement?.({ project: item.project, slug: item.slug })
      window.easyFlow?.hidePanel?.()
      return
    }
    if (item.kind === 'session') {
      openSession(item.session)
      return
    }
    window.open(item.url, '_blank')
    window.easyFlow?.hidePanel?.()
  }

  function openDetail(project: string, slug: string) {
    void window.easyFlow?.openRequirement?.({ project, slug })
    window.easyFlow?.hidePanel?.()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // 输入法选词中的回车 / 方向键归输入法
    if (isComposing(e.nativeEvent)) return
    // ⌘↵ 直接开选中卡片的需求详情；⌘1..9 开第 N 张卡。数字不带 ⌘ 时照常输入搜索词
    if (shortcut(e, 'mini.open-detail')) {
      e.preventDefault()
      const cur = items[selIdx]
      if (!cur) return
      if (cur.kind === 'req') openDetail(cur.project, cur.slug)
      else activate(cur)
      return
    }
    if (shortcut(e, 'mini.nth')) {
      e.preventDefault()
      const block = blocks[Number(e.key) - 1]
      if (block) openDetail(block.req.project, block.req.slug)
      return
    }
    if (shortcut(e, 'mini.next')) {
      e.preventDefault()
      keyMoved.current = true
      setSelectedKey(moveKey(keys, selectedKey, 1))
      return
    }
    if (shortcut(e, 'mini.prev')) {
      e.preventDefault()
      keyMoved.current = true
      setSelectedKey(moveKey(keys, selectedKey, -1))
      return
    }
    if (shortcut(e, 'mini.expand')) {
      e.preventDefault()
      const cur = items[selIdx]
      if (cur?.kind === 'req' && expanded !== `${cur.project}:${cur.slug}`) toggle(cur.project, cur.slug)
      return
    }
    if (shortcut(e, 'mini.collapse')) {
      e.preventDefault()
      const cur = items[selIdx]
      if (!cur) return
      const key = `${cur.project}:${cur.slug}`
      if (cur.kind !== 'req' && expanded === key) setSelectedKey(key)
      else if (cur.kind === 'req' && expanded === key) setExpanded('')
      return
    }
    if (shortcut(e, 'mini.activate')) {
      e.preventDefault()
      activate(items[selIdx])
      return
    }
    if (shortcut(e, 'mini.close')) {
      if (query) setQuery('')
      else if (expanded) setExpanded('')
      else window.easyFlow?.hidePanel?.()
    }
  }

  function actionRow(c: MiniAction, childOn: boolean, title: string, off = false) {
    return (
      <div
        key={c.key}
        ref={(el) => {
          if (el) rowRefs.current.set(c.key, el)
          else rowRefs.current.delete(c.key)
        }}
        className={`mini-act${childOn ? ' on' : ''}${off ? ' off' : ''}`}
        title={title}
        onMouseEnter={(e) => hover(e, c.key)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          activate(c)
        }}
      >
        <span className="mini-ico">{iconOf(c)}</span>
        {c.kind === 'session' ? (
          <>
            <span className={`mini-val${c.session.title ? '' : ' mono'}`}>
              {c.session.title || c.session.session}
            </span>
            <span className="mini-when">{miniTime(sessionActive(c.session))}</span>
          </>
        ) : (
          <span className={`mini-val${c.kind === 'link' && c.type === 'MR' ? ' mono' : ''}`}>
            {c.kind === 'detail' ? '详情' : c.value}
          </span>
        )}
        <span className="mini-go">
          <GoIcon />
        </span>
      </div>
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
            placeholder="搜索需求"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <span className="mini-esc" title="Esc 收起面板">
            esc
          </span>
        </div>
      </div>

      <div className="mini-list">
        {error && <div className="notice">{error}</div>}
        {!error && !ready && <MiniSkeleton />}
        {!error && ready && blocks.length === 0 && <div className="mini-empty">没有匹配的需求</div>}

        {blocks.map((b) => {
          const on = selKey === b.key
          const attention = badgesOf(b.sessions)[0]
          const last = attention ?? b.sessions[0]
          const tint =
            last &&
            (last.status.state === 'done' ||
              last.status.state === 'blocked' ||
              last.status.state === 'failed')
              ? ` ${last.status.state}`
              : ''
          return (
            <div
              key={b.key}
              ref={(el) => {
                if (el) rowRefs.current.set(b.key, el)
                else rowRefs.current.delete(b.key)
              }}
              className={`mini-card${on ? ' on' : ''}`}
              onMouseEnter={(e) => hover(e, b.key)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(b.req.project, b.req.slug)}
            >
              <div className="mini-top">
                <span className="mini-title">{b.req.title || b.req.slug}</span>
                <span className="mini-caret">
                  <ChevronIcon dir={expanded === b.key ? 'down' : 'right'} />
                </span>
              </div>

              {b.children.length > 0 && (
                <div className="mini-acts">
                  {b.children.map((c) => {
                    const childOn = selKey === c.key
                    if (c.kind === 'detail') return actionRow(c, childOn, '打开需求详情')
                    if (c.kind === 'session') {
                      const s = c.session
                      const name = s.title || s.session
                      return actionRow(
                        c,
                        childOn,
                        s.link
                          ? `${AGENT_LABELS[s.agent] ?? s.agent} · ${name}`
                          : `没有会话级链接，会话 id：${s.session}`,
                        !s.link,
                      )
                    }
                    return actionRow(c, childOn, c.url)
                  })}
                </div>
              )}

              <div className="mini-foot">
                <span className="mini-proj">{b.projectName}</span>
                <span className="mini-time">{miniTime(b.active)}</span>
                {last && (
                  <span
                    className={`mini-agent${last.link ? '' : ' off'}${tint}`}
                    title={
                      last.link
                        ? `${AGENT_LABELS[last.agent] ?? last.agent}：${last.title || last.session}（回到这个会话）`
                        : `${AGENT_LABELS[last.agent] ?? last.agent} 没有会话级链接：${last.session}`
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation()
                      openSession(last)
                    }}
                  >
                    {attention && (
                      <span className={`thread-dot ${THREAD_STATE_CLASS[attention.status.state] ?? ''}`} />
                    )}
                    <AgentIcon agent={last.agent} />
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mini-hints">
        <span>↑↓ 选择</span>
        <span>→ 展开</span>
        <span>↵ 打开</span>
        <span>⌘↵ 详情</span>
        <span>esc 收起</span>
      </div>
    </div>
  )
}

function MiniSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div className="mini-card mini-skel" key={i}>
          <div className="mini-top">
            <span className="mini-skel-bar" />
          </div>
          <div className="mini-foot">
            <span className="mini-skel-bar short" />
            <span className="mini-skel-bar tiny" />
          </div>
        </div>
      ))}
    </>
  )
}

function iconOf(c: MiniAction) {
  if (c.kind === 'detail') return <DocIcon />
  if (c.kind === 'session') return <AgentIcon agent={c.session.agent} size={13} />
  return c.type === 'MR' ? <MergeIcon /> : <LinkIcon />
}
