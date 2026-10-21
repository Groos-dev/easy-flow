import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '../lib/types'
import { projectColor, projectInitial } from '../lib/projectIcon'
import { PinIcon } from './icons'

interface Props {
  projects: Project[]
  active: string
  pinned: string[]
  onPick: (slug: string) => void
  onOpen: (slug: string) => void
  onTogglePin: (slug: string, pinned: boolean) => void
  onClose: () => void
}

/** ⌘P 项目切换面板 */
export default function ProjectSwitcher({
  projects,
  active,
  pinned,
  onPick,
  onOpen,
  onTogglePin,
  onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setCursor(0)
  }, [query])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = projects.filter(
      (p) =>
        !q ||
        (p.name || p.slug).toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q),
    )
    // 置顶的排前面，组内按显示名；与左栏面板的口径一致
    return [...hit].sort((a, b) => {
      const ap = pinned.includes(a.slug) ? 0 : 1
      const bp = pinned.includes(b.slug) ? 0 : 1
      return ap - bp || (a.name || a.slug).localeCompare(b.name || b.slug)
    })
  }, [projects, pinned, query])

  const idx = list.length ? Math.min(cursor, list.length - 1) : -1
  const current = idx >= 0 ? list[idx] : undefined

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(Math.min(idx + 1, list.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(Math.max(idx - 1, 0))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!current) return
      if (e.metaKey || e.ctrlKey) onOpen(current.slug)
      else if (e.altKey) onTogglePin(current.slug, !pinned.includes(current.slug))
      else onPick(current.slug)
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="切换项目"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="切换项目：名称或目录名"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {list.length === 0 ? (
            <div className="palette-hint">没有匹配的项目</div>
          ) : (
            list.map((p, i) => {
              const name = p.name || p.slug
              const isPinned = pinned.includes(p.slug)
              return (
                <div
                  key={p.slug}
                  className={`palette-row${p === current ? ' on' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onPick(p.slug)}
                >
                  <span className="pico" style={{ background: projectColor(p.slug) }}>
                    {projectInitial(name)}
                  </span>
                  <span className="palette-title">
                    {name}
                    {p.slug === active && <span className="palette-active">当前</span>}
                  </span>
                  {isPinned && (
                    <span className="palette-pin" title="已置顶">
                      <PinIcon />
                    </span>
                  )}
                  <span className="palette-slug">{p.requirementCount}</span>
                </div>
              )
            })
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择</span>
          <span>↵ 切换</span>
          <span>⌘↵ 项目详情</span>
          <span>⌥↵ 置顶</span>
          <span>esc 关掉</span>
        </div>
      </div>
    </div>
  )
}
