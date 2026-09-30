import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Project } from '../lib/api'
import type { Requirement } from '../lib/types'

interface Props {
  /** 折叠侧边栏 */
  onCollapse: () => void
  /** 当前选中的挂载点（用于高亮）；slug 为 null 表示选中了项目本身 */
  selected: { project: string; slug: string | null } | null
  /** 点了项目：切到该项目的看板 */
  onOpenProjectBoard: () => void
  /** 点了项目名旁的「详情」：打开项目详情页（含终端） */
  onOpenProjectDetail: (slug: string) => void
  /** 点了需求：打开需求详情页 */
  onOpenRequirement: (project: string, slug: string) => void
}

interface TreeProject extends Project {
  requirements: Requirement[]
}

export default function Sidebar({
  onCollapse,
  selected,
  onOpenProjectBoard,
  onOpenProjectDetail,
  onOpenRequirement,
}: Props) {
  const [tree, setTree] = useState<TreeProject[]>([])
  const [active, setActive] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newSlug, setNewSlug] = useState('')
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.tree()
      setTree(res.tree)
      setActive(res.active)
      setExpanded((prev) => (prev.size ? prev : new Set([res.active])))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tree
    return tree
      .map((p) => {
        const hitProject = p.slug.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
        const reqs = p.requirements.filter(
          (r) =>
            r.slug.toLowerCase().includes(q) ||
            r.title.toLowerCase().includes(q) ||
            r.summary.toLowerCase().includes(q),
        )
        // 项目名命中就展示它全部需求，否则只展示命中的需求
        return hitProject || reqs.length ? { ...p, requirements: hitProject ? p.requirements : reqs } : null
      })
      .filter((p): p is TreeProject => p !== null)
  }, [tree, query])

  function toggle(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  async function switchProject(slug: string) {
    if (slug !== active) {
      setBusy(true)
      try {
        await api.setActiveProject(slug)
        setActive(slug)
        onOpenProjectBoard()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    } else {
      onOpenProjectBoard()
    }
    setExpanded((prev) => new Set(prev).add(slug))
  }

  async function createProject() {
    setBusy(true)
    setError('')
    try {
      await api.createProject(newSlug.trim(), newName.trim())
      setNewSlug('')
      setNewName('')
      setCreating(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">easy-flow</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onCollapse} title="收起侧边栏">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      </div>

      <div className="sidebar-search">
        <input
          className="search wide"
          placeholder="过滤项目 / 需求…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-tree">
        {error && <div className="notice">{error}</div>}

        {filtered.map((p) => {
          const isOpen = expanded.has(p.slug) || !!query.trim()
          const isActive = p.slug === active
          return (
            <div key={p.slug} className="tree-project">
              <div className={`tree-row project${isActive ? ' active' : ''}`}>
                <button
                  className="tree-caret"
                  onClick={() => toggle(p.slug)}
                  title={isOpen ? '收起' : '展开'}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
                <button className="tree-label" onClick={() => void switchProject(p.slug)} title={p.root}>
                  <span className="tree-name">{p.name}</span>
                  <span className="tree-count">{p.requirements.length}</span>
                </button>
                <button
                  className="tree-action"
                  title="打开项目详情（含终端）"
                  onClick={() => onOpenProjectDetail(p.slug)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              </div>

              {isOpen && (
                <div className="tree-children">
                  {p.requirements.length === 0 ? (
                    <div className="tree-empty">（无需求）</div>
                  ) : (
                    p.requirements.map((r) => {
                      const isSel =
                        selected?.project === p.slug && selected?.slug === r.slug
                      return (
                        <button
                          key={r.slug}
                          className={`tree-row requirement${isSel ? ' selected' : ''}`}
                          onClick={() => onOpenRequirement(p.slug, r.slug)}
                          title={r.title}
                        >
                          <span className={`prio ${r.priority}`} style={{ visibility: r.priority ? 'visible' : 'hidden' }} />
                          <span className="tree-name">{r.title || r.slug}</span>
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )
        })}

        {creating ? (
          <div className="project-create">
            <input
              className="search wide"
              placeholder="标识（英文小写）"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              spellCheck={false}
            />
            <input
              className="search wide"
              placeholder="显示名（可留空）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="row">
              <button className="btn primary" disabled={busy || !newSlug.trim()} onClick={() => void createProject()}>
                创建
              </button>
              <button className="btn" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button className="project-new" onClick={() => setCreating(true)}>
            + 新建项目
          </button>
        )}
      </div>
    </aside>
  )
}
