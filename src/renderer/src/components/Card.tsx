import { useDraggable } from '@dnd-kit/core'
import type { Requirement, Session } from '../lib/types'
import { relTime } from '../lib/time'
import ThreadBadge from './ThreadBadge'

interface Props {
  req: Requirement
  /** 这条需求名下该挂角标的会话，已按急缓排好；空数组就不挂 */
  sessions?: Session[]
  onOpen?: (slug: string) => void
  overlay?: boolean
}

export default function Card({ req, sessions, onOpen, overlay = false }: Props) {
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
        <span className="card-title">{req.title}</span>
      </div>
      {/* 每个会话各挂一个角标：一眼看出这条需求名下哪个 agent 跑完了、哪个卡住了。
          拖拽浮层里不挂——那一层只负责跟手，不是给人读的 */}
      {!overlay && sessions && sessions.length > 0 && (
        <div className="thread-badges">
          {sessions.map((s) => (
            <ThreadBadge key={`${s.agent}:${s.session}`} session={s} />
          ))}
        </div>
      )}
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
