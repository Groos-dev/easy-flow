import { useLanguage } from '../lib/language'
import { t as tr } from "../../../shared/i18n.ts"
import { useEffect, useRef, useState } from 'react'
import type { Project } from '../lib/types'
import { shortcutLabel, projectShortcutLabel } from '../lib/keys'
import { projectColor, projectInitial } from '../lib/projectIcon'
import { BellIcon, BoardIcon, CheckIcon, InfoIcon, MapIcon, PinIcon } from './icons'

// 左栏能进的三个视图：board 与 map 由一个按钮循环，agent 焦点单独一个入口
export type RailView = 'board' | 'next' | 'map'

// 进入要防手滑扫过就弹，离开要留出鼠标从图标滑进面板的时间
const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 250

interface LeftRailProps {
  projects: Project[]
  active: string
  pinned: string[]
  view: RailView
  // agent 卡住等你、要人介入的需求数；0 时不显示角标
  agentCount: number
  onSwitchProject: (slug: string) => void
  onTogglePin: (slug: string, pinned: boolean) => void
  onOpenProject: (slug: string) => void
  onSwitchView: (view: 'board' | 'map') => void
  onAgentFocus: () => void
}

export default function LeftRail({
  projects,
  active,
  pinned,
  view,
  agentCount,
  onSwitchProject,
  onTogglePin,
  onOpenProject,
  onSwitchView,
  onAgentFocus,
}: LeftRailProps) {
  useLanguage()
  const [open, setOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    [],
  )

  const openSoon = () => {
    clearTimeout(closeTimer.current)
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS)
  }
  const closeSoon = () => {
    clearTimeout(openTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  // 鼠标落在面板上：撤销倒计时中的关闭——从图标滑进面板的路上会经过这段
  const holdOpen = () => clearTimeout(closeTimer.current)

  const bySlug = new Map(projects.map((p) => [p.slug, p]))
  const current = bySlug.get(active)
  const pinnedProjects = pinned.map((s) => bySlug.get(s)).filter((p): p is Project => !!p)
  const restProjects = projects.filter((p) => !pinned.includes(p.slug))
  const nameOf = (p: Project) => p.name || p.slug
  // 看板、导图共用一个按钮，徽标给按下去会到的那一个
  const viewHint = shortcutLabel(view === 'board' ? 'global.view-map' : 'global.view-board')

  const pick = (slug: string) => {
    setOpen(false)
    if (slug !== active) onSwitchProject(slug)
  }

  const row = (p: Project) => {
    const isCurrent = p.slug === active
    const isPinned = pinned.includes(p.slug)
    return (
      <div
        key={p.slug}
        className={`rail-row${isCurrent ? ' current' : ''}`}
        onClick={() => pick(p.slug)}
      >
        <span className="pico" style={{ background: projectColor(p.slug) }}>
          {projectInitial(nameOf(p))}
        </span>
        <span className="rail-row-name">{nameOf(p)}</span>
        <span className="rail-row-count">{p.requirementCount}</span>
        <span className="rail-row-acts">
          <button
            className={`rail-act${isPinned ? ' on' : ''}`}
            title={isPinned ? tr("Unpin") : tr("Pin to the sidebar")}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin(p.slug, !isPinned)
            }}
          >
            <PinIcon />
          </button>
          <button
            className="rail-act"
            title={tr("Project details")}
            onClick={(e) => {
              e.stopPropagation()
              onOpenProject(p.slug)
            }}
          >
            <InfoIcon />
          </button>
        </span>
        {isCurrent && (
          <span className="rail-row-tick">
            <CheckIcon />
          </span>
        )}
      </div>
    )
  }

  return (
    <div className={`rail${open ? ' open' : ''}`}>
      <div className="rail-col">
        <button
          className="rail-btn cur"
          aria-label={
            current
              ? tr("{0} · Hover to browse all projects ({1} to switch with the keyboard)", [nameOf(current), shortcutLabel('global.project')])
              : tr("Browse all projects ({0})", [shortcutLabel('global.project')])
          }
          onMouseEnter={openSoon}
          onMouseLeave={closeSoon}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className="pico lg"
            style={current ? { background: projectColor(current.slug) } : undefined}
          >
            {current ? projectInitial(nameOf(current)) : '?'}
          </span>
          {current && <span className="rail-tip">{nameOf(current)}</span>}
          <span className="kbd-hint">{shortcutLabel('global.project')}</span>
        </button>

        <div className="rail-sep" />

        {pinnedProjects
          .map((p, i) => ({ project: p, key: projectShortcutLabel(i + 1) }))
          .filter(({ project }) => project.slug !== active)
          .map(({ project: p, key }) => (
            <button
              key={p.slug}
              className="rail-btn"
              aria-label={`${nameOf(p)}（${key}）`}
              onClick={() => pick(p.slug)}
            >
              <span className="pico" style={{ background: projectColor(p.slug) }}>
                {projectInitial(nameOf(p))}
              </span>
              <span className="rail-tip">{nameOf(p)}</span>
              <span className="kbd-hint">{key}</span>
            </button>
          ))}

        <div className="rail-sep" />

        <button
          className="rail-btn"
          title={
            view === 'map'
              ? tr("Mind map · Click to switch to the board ({0})", [shortcutLabel('global.view-board')])
              : view === 'next'
                ? tr("Return to the board ({0})", [shortcutLabel('global.view-board')])
                : tr("Board · Click to switch to the mind map ({0})", [shortcutLabel('global.view-map')])
          }
          onClick={() => onSwitchView(view === 'board' ? 'map' : 'board')}
        >
          {view === 'map' ? <MapIcon /> : <BoardIcon />}
          <span className="kbd-hint">{viewHint}</span>
        </button>

        <button
          className={`rail-btn${view === 'next' ? ' on' : ''}`}
          title={
            view === 'next'
              ? tr("Agent focus: requirements needing your attention ({0})", [shortcutLabel('global.view-next')])
              : tr("Switch to agent focus: requirements needing your attention ({0})", [shortcutLabel('global.view-next')])
          }
          onClick={onAgentFocus}
        >
          <BellIcon />
          {agentCount > 0 && <span className="rail-badge">{agentCount}</span>}
          <span className="kbd-hint">{shortcutLabel('global.view-next')}</span>
        </button>
      </div>

      <div className="rail-panel" onMouseEnter={holdOpen} onMouseLeave={closeSoon}>
        <div className="rail-panel-head">{tr("All projects")}</div>
        <div className="rail-panel-scroll">
          {pinnedProjects.length > 0 && (
            <>
              <div className="rail-group">{tr("Pinned")}</div>
              {pinnedProjects.map(row)}
            </>
          )}
          <div className="rail-group">{tr("All")}</div>
          {restProjects.map(row)}
        </div>
      </div>
    </div>
  )
}
