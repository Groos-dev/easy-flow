import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { isComposing, isEditableTarget, shortcut } from '../lib/keys'
import type { Requirement } from '../lib/types'
import { STATUS_CLASS } from '../lib/labels'
import { buildTree, layoutTree, type LaidNode } from '../lib/mindmap'

// 顶层分支的连线颜色，循环取用；刻意避开状态色，免得两种颜色打架
const BRANCH_COLORS = ['#a78bfa', '#f472b6', '#22d3ee', '#eab308', '#fb7185', '#2dd4bf']

const MIN_ZOOM = 0.4
const MAX_ZOOM = 2.5
const FIT_MARGIN = 24

interface Props {
  requirements: Requirement[]
  // 项目显示名，画在根节点上
  projectName: string
  // 搜索命中集合；不传表示没在搜索。当前没有搜索入口，留给以后的搜索面板
  hits?: Set<string> | null
  onOpen: (slug: string) => void
  onBack: () => void
}

interface NodeProps {
  node: LaidNode
  onOpen: (slug: string) => void
  onToggle: (slug: string) => void
}

function MapNodeBox({ node, onOpen, onToggle }: NodeProps) {
  const { req, hidden, collapsible } = node
  return (
    <div
      className="map-node"
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      tabIndex={0}
      onClick={() => onOpen(req.slug)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen(req.slug)
        } else if ((e.key === ' ' || e.key === 'Spacebar') && collapsible) {
          e.preventDefault()
          onToggle(req.slug)
        }
      }}
    >
      <span className={`dot ${STATUS_CLASS[req.status] ?? 's-clarify'}`} />
      <span className="map-node-title">{req.title}</span>
      {collapsible && (
        <button
          className={`map-node-toggle${hidden > 0 ? ' more' : ''}`}
          title={hidden > 0 ? `展开 ${hidden} 个子需求` : '收起子需求'}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(req.slug)
          }}
        >
          {hidden > 0 ? `+${hidden}` : '−'}
        </button>
      )}
      <div className="map-node-tip">
        <div className="tip-title">{req.slug}</div>
        {req.summary && <div className="tip-summary">{req.summary}</div>}
        <div className="tip-meta">
          {[req.repos.map((r) => r.short).join(' · '), req.updated ? req.updated.slice(5) : '']
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </div>
  )
}

export default function MindMap({ requirements, projectName, hits, onOpen, onBack }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [size, setSize] = useState({ w: 0, h: 0 })
  // 画布位移与缩放；容器坐标，transform-origin 是左上角
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })

  const layout = useMemo(
    () => layoutTree(buildTree(requirements), { collapsed, hits }),
    [requirements, collapsed, hits],
  )

  // 容器尺寸变了就重新适应窗口——挂载时、拖窗口时都走这里
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const read = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])

  /**
   * 适应窗口只认画布的尺寸，不认 layout 对象本身：看板每秒轮询一次，
   * requirements 每次都换新引用，依赖它等于每秒把正在拖的图拽回适应窗口。
   */
  const layoutW = layout.width
  const layoutH = layout.height

  const fit = useCallback(() => {
    if (!size.w || !size.h) return
    const zoom = Math.min(1, Math.min((size.w - FIT_MARGIN) / layoutW, (size.h - FIT_MARGIN) / layoutH))
    setView({
      zoom,
      x: (size.w - layoutW * zoom) / 2,
      y: (size.h - layoutH * zoom) / 2,
    })
  }, [size.w, size.h, layoutW, layoutH])

  // 换项目、搜索、改折叠、拖窗口，都重新摆一次
  useEffect(() => {
    fit()
  }, [fit, projectName])

  // 键盘缩放以画布中心为锚点，和滚轮同一个手感
  const zoomBy = useCallback(
    (factor: number) => {
      setView((v) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
        const k = zoom / v.zoom
        const px = size.w / 2
        const py = size.h / 2
        return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    },
    [size.w, size.h],
  )

  const panBy = useCallback((dx: number, dy: number) => {
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e) || isEditableTarget(e.target)) return
      if (shortcut(e, 'map.back')) {
        e.preventDefault()
        onBack()
      } else if (shortcut(e, 'map.fit')) {
        e.preventDefault()
        fit()
      } else if (shortcut(e, 'map.zoom-in')) {
        e.preventDefault()
        zoomBy(1.1)
      } else if (shortcut(e, 'map.zoom-out')) {
        e.preventDefault()
        zoomBy(1 / 1.1)
      } else if (shortcut(e, 'map.pan')) {
        e.preventDefault()
        if (e.key === 'ArrowLeft') panBy(60, 0)
        else if (e.key === 'ArrowRight') panBy(-60, 0)
        else if (e.key === 'ArrowUp') panBy(0, 60)
        else if (e.key === 'ArrowDown') panBy(0, -60)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fit, zoomBy, panBy, onBack])

  // 滚轮要 preventDefault，而 React 的 onWheel 是被动的，只能挂原生监听
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const py = ev.clientY - rect.top
      setView((v) => {
        const zoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, v.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)),
        )
        const k = zoom / v.zoom
        return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const toggle = useCallback((slug: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])

  // 空白处按下才平移：节点自己会处理点击，从节点上拖不应该动整张图
  function startPan(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.map-node')) return
    panRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function movePan(e: PointerEvent<HTMLDivElement>) {
    const p = panRef.current
    if (!p) return
    setView((v) => ({ ...v, x: p.vx + (e.clientX - p.px), y: p.vy + (e.clientY - p.py) }))
  }

  function endPan(e: PointerEvent<HTMLDivElement>) {
    panRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // 没需求、或搜了但什么都没命中，都只是一句话的事，不必铺画布
  const blank =
    requirements.length === 0
      ? '这个项目下还没有需求。让 agent 建一个，或从顶栏换个项目。'
      : hits && layout.nodes.length === 0
        ? '没有命中的需求。'
        : ''

  if (blank) {
    return (
      <div className="mindmap empty" ref={wrapRef}>
        <p>{blank}</p>
      </div>
    )
  }

  return (
    <div
      className="mindmap"
      ref={wrapRef}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={fit}
    >
      <div
        className="mindmap-stage"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
      >
        <svg className="mindmap-links" width={layout.width} height={layout.height}>
          {layout.edges.map((edge) => {
            const bend = (edge.x2 - edge.x1) / 2
            return (
              <path
                key={edge.id}
                d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + bend} ${edge.y1}, ${edge.x2 - bend} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                fill="none"
                stroke={BRANCH_COLORS[edge.branch % BRANCH_COLORS.length]}
                strokeWidth="1.6"
                opacity="0.75"
              />
            )
          })}
        </svg>

        <div
          className="map-node root"
          style={{
            left: layout.root.x,
            top: layout.root.y,
            width: layout.root.width,
            height: layout.root.height,
          }}
        >
          {projectName}
        </div>

        {layout.nodes.map((node) => (
          <MapNodeBox key={node.req.slug} node={node} onOpen={onOpen} onToggle={toggle} />
        ))}
      </div>
    </div>
  )
}
