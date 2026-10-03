import { useDraggable } from '@dnd-kit/core'
import type { Requirement } from '../lib/types'

/** 优先级标签，对应艾森豪威尔四象限 */
const PRIORITY_LABEL: Record<string, string> = {
  p0: '重要且紧急（马上做）',
  p1: '重要不紧急（计划做）',
  p2: '紧急不重要（授权做）',
  p3: '不重要不紧急（有空再做）',
}

function relTime(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

interface Props {
  req: Requirement
  onOpen?: (slug: string) => void
  overlay?: boolean
}

export default function Card({ req, onOpen, overlay = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: req.slug,
    data: { type: 'card', slug: req.slug, status: req.status },
    disabled: overlay,
  })

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card${isDragging ? ' dragging' : ''}`}
      onClick={() => !overlay && onOpen?.(req.slug)}
      {...listeners}
      {...attributes}
    >
      <div className="card-top">
        {req.priority && (
          <span
            className={`prio ${req.priority}`}
            title={`${req.priority.toUpperCase()} ${PRIORITY_LABEL[req.priority] ?? ''}`}
          />
        )}
        <span className="card-title">{req.title}</span>
      </div>
      <div className="card-slug">{req.slug}</div>
      {req.summary && <div className="card-summary">{req.summary}</div>}
      <div className="card-foot">
        {req.repos.slice(0, 3).map((r) => (
          <span key={r.short} className="chip">
            {r.short}
          </span>
        ))}
        {req.repos.length > 3 && <span className="chip">+{req.repos.length - 3}</span>}
        {/* 状态更新日期优先；没有就回落到文件修改时间 */}
        <span className="stage">{req.updated ? req.updated.slice(5) : relTime(req.mtime)}</span>
      </div>
    </div>
  )
}
