import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { AGENT_LABELS, STATUS_CLASS } from '../lib/labels'
import { codeLinkLabel } from '../lib/links'
import { relTime, parseStamp } from '../lib/time'
import { moveKey, resolveKey } from '../lib/selection'
import type { Requirement, Session } from '../lib/types'
import { AgentIcon } from '../components/icons'

/**
 * 呼出式 mini 面板：launcher 范式，第一层是最近活跃需求，展开是动作视图。
 * 设计见需求 mini-panel 的 docs/mini-panel/design.md。
 */

/** 展开后的动作行 */
type ActionItem =
  | { key: string; kind: 'detail'; project: string; slug: string }
  | { key: string; kind: 'session'; project: string; slug: string; session: Session }
  | { key: string; kind: 'link'; project: string; slug: string; url: string; type: string; value: string }

/** 面板里的一行；键盘选择走这份扁平列表（展开的动作行也在里面） */
type NavItem =
  | { key: string; kind: 'req'; project: string; slug: string }
  | ActionItem

interface Block {
  key: string
  req: Requirement
  projectName: string
  sessions: Session[]
  /** 活跃时间：文档改动与最近一次会话登记里更晚的那个。排序与行尾时间都用它 */
  active: number
  children: ActionItem[]
}

export default function MiniApp() {
  const [rows, setRows] = useState<Array<{ req: Requirement; projectName: string }>>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  /** 展开的需求（project:slug）；同时只展开一个，动作视图不是常驻面板 */
  const [expanded, setExpanded] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  /** 上次 hover 时指针的位置，用来分辨「指针动了」与「行被顶到指针下面了」 */
  const pointer = useRef({ x: -1, y: -1 })

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
    }
  }, [])

  // 每次呼出都回到初始态：清过滤、收起动作、选中第一条，光标回过滤框
  const reset = useCallback(() => {
    setQuery('')
    setExpanded('')
    setSelectedKey('')
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    void load()
    inputRef.current?.focus()
    // 呼出时重拉一次：上次呼出后 agent 可能又动了看板
    const off = window.easyFlow?.onPanelShown?.(() => {
      void load()
      reset()
    })
    return () => off?.()
  }, [load, reset])

  /** 每个需求名下的会话，最近登记的在前（服务端已排好） */
  const sessionsByReq = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const list = map.get(s.requirementId)
      if (list) list.push(s)
      else map.set(s.requirementId, [s])
    }
    return map
  }, [sessions])

  /**
   * 默认视图滤掉已完成；一旦有过滤词就穿透——想回到刚 merge 的需求时，
   * 搜标题就该找得到它（状态点照常着色区分）。
   * 排序按「活跃时间」：文档改动与最近一次会话登记里更晚的那个——
   * 只登记会话、还没写文档的需求（agent 刚开工）也该浮上来。
   */
  const blocks = useMemo<Block[]>(() => {
    const q = query.trim().toLowerCase()
    const matched = rows
      .map(({ req, projectName }) => {
        const ss = sessionsByReq.get(req.id) ?? []
        const active = ss.reduce((t, s) => Math.max(t, parseStamp(s.updated)), req.mtime)
        return { req, projectName, ss, active }
      })
      .filter(({ req, projectName }) =>
        q
          ? `${req.title} ${req.slug} ${req.summary} ${projectName}`.toLowerCase().includes(q)
          : req.status !== '已完成',
      )
      .sort((a, b) => b.active - a.active)

    return matched.map(({ req, projectName, ss, active }) => {
      const key = `${req.project}:${req.slug}`
      const children: ActionItem[] =
        expanded === key
          ? [
              { key: `${key}|detail`, kind: 'detail', project: req.project, slug: req.slug },
              ...ss.map((s) => ({
                key: `${key}|s|${s.agent}|${s.session}`,
                kind: 'session' as const,
                project: req.project,
                slug: req.slug,
                session: s,
              })),
              ...req.codeLinks.map((l) => ({
                key: `${key}|mr|${l.url}`,
                kind: 'link' as const,
                project: req.project,
                slug: req.slug,
                url: l.url,
                type: 'MR',
                value: codeLinkLabel(l),
              })),
              ...req.feishuTaskLinks.map((url) => ({
                key: `${key}|fs|${url}`,
                kind: 'link' as const,
                project: req.project,
                slug: req.slug,
                url,
                type: '链接',
                value: url,
              })),
              ...req.extLinks.map((l) => ({
                key: `${key}|ext|${l.url}`,
                kind: 'link' as const,
                project: req.project,
                slug: req.slug,
                url: l.url,
                type: '链接',
                value: l.detail || l.url,
              })),
            ]
          : []
      return { key, req, projectName, sessions: ss, active, children }
    })
  }, [rows, query, expanded, sessionsByReq])

  const items = useMemo<NavItem[]>(
    () =>
      blocks.flatMap((b) => [
        { key: b.key, kind: 'req' as const, project: b.req.project, slug: b.req.slug },
        ...b.children,
      ]),
    [blocks],
  )
  /** 选中项按 key 记（不按下标，展开别人会把列表插删得下标乱漂）；解析与移动见 lib/selection */
  const keys = useMemo(() => items.map((it) => it.key), [items])
  const selKey = resolveKey(keys, selectedKey)
  const selIdx = keys.indexOf(selKey)

  useEffect(() => {
    setSelectedKey('')
  }, [query])

  function toggle(project: string, slug: string) {
    const key = `${project}:${slug}`
    setExpanded((prev) => (prev === key ? '' : key))
  }

  /**
   * 悬停改选中行，但只认指针真的动了的那种。
   * 展开动作行会把下面的行顶下去，静止的指针就"换"到了别的行上，
   * 浏览器会为此再发一次 mouseenter——不拦的话，按 Enter 展开后选中会莫名跳到别的需求。
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

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedKey(moveKey(keys, selectedKey, 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedKey(moveKey(keys, selectedKey, -1))
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const cur = items[selIdx]
      if (cur?.kind === 'req' && expanded !== `${cur.project}:${cur.slug}`) toggle(cur.project, cur.slug)
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = items[selIdx]
      if (!cur) return
      const key = `${cur.project}:${cur.slug}`
      // 动作行上按左：回到所属需求那一行；需求行上按左：收起
      if (cur.kind !== 'req' && expanded === key) setSelectedKey(key)
      else if (cur.kind === 'req' && expanded === key) setExpanded('')
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activate(items[selIdx])
      return
    }
    if (e.key === 'Escape') {
      // 逐级：清过滤 → 收动作 → 藏面板
      if (query) setQuery('')
      else if (expanded) setExpanded('')
      else window.easyFlow?.hidePanel?.()
    }
  }

  return (
    <div className="mini" onKeyDown={onKeyDown}>
      {/* 无边框窗口的拖动条：位置记忆要能改位置才有意义 */}
      <div className="mini-drag" />

      <div className="mini-search">
        <input
          ref={inputRef}
          className="mini-input"
          placeholder="过滤项目 / 需求…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="mini-list">
        {error && <div className="notice">{error}</div>}
        {!error && blocks.length === 0 && <div className="mini-empty">没有匹配的需求</div>}

        {/* 行上统一 preventDefault：点击不能把焦点从过滤框带走，键盘流要接着能用 */}
        {blocks.map((b) => {
          const on = selKey === b.key
          const last = b.sessions[0]
          return (
            <div key={b.key} className="mini-block">
              <div
                className={`mini-row${on ? ' on' : ''}`}
                onMouseEnter={(e) => hover(e, b.key)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggle(b.req.project, b.req.slug)}
              >
                <span
                  className={`dot ${STATUS_CLASS[b.req.status] ?? ''}`}
                  title={b.req.status}
                />
                <span className="mini-title">{b.req.title || b.req.slug}</span>
                <span className="mini-proj">{b.projectName}</span>
                {last && (
                  <span
                    className={`mini-badge${last.link ? '' : ' off'}`}
                    title={
                      last.link
                        ? `${AGENT_LABELS[last.agent] ?? last.agent}：${last.title || last.session}（回到这个会话）`
                        : `${AGENT_LABELS[last.agent] ?? last.agent} 没有会话级链接：${last.session}`
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      openSession(last)
                    }}
                  >
                    <AgentIcon agent={last.agent} />
                  </span>
                )}
                <span className="mini-time">{relTime(b.active)}</span>
              </div>

              {b.children.map((c) => {
                const childOn = selKey === c.key
                if (c.kind === 'detail') {
                  return (
                    <div
                      key={c.key}
                      className={`mini-row act${childOn ? ' on' : ''}`}
                      onMouseEnter={(e) => hover(e, c.key)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => activate(c)}
                    >
                      <span className="mini-type">详情</span>
                    </div>
                  )
                }
                if (c.kind === 'session') {
                  const s = c.session
                  return (
                    <div
                      key={c.key}
                      className={`mini-row act${childOn ? ' on' : ''}${s.link ? '' : ' off'}`}
                      title={s.link ? `${s.title || s.session}` : `没有会话级链接，会话 id：${s.session}`}
                      onMouseEnter={(e) => hover(e, c.key)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => activate(c)}
                    >
                      <span className="mini-type">会话</span>
                      <span className="mini-value mono">
                        {s.link ? `${s.agent} · ${s.updated.slice(5)}` : s.session}
                      </span>
                    </div>
                  )
                }
                return (
                  <div
                    key={c.key}
                    className={`mini-row act${childOn ? ' on' : ''}`}
                    title={c.url}
                    onMouseEnter={(e) => hover(e, c.key)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => activate(c)}
                  >
                    <span className="mini-type">{c.type}</span>
                    <span className="mini-value">{c.value}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
