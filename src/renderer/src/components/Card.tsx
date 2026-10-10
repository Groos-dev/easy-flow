import { useDraggable } from '@dnd-kit/core'
import type { Requirement } from '../lib/types'
import { PRIORITY_LABEL } from '../lib/labels'
import { relTime } from '../lib/time'

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
