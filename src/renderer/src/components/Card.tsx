import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { ChildStat, Requirement, Session } from '../lib/types'
import { relTime } from '../lib/time'
import ThreadBadge from './ThreadBadge'

interface Props {
  req: Requirement
  /** 这条需求名下该挂角标的会话，已按急缓排好；空数组就不挂 */
  sessions?: Session[]
  /** 有子需求才传：卡片默认收成一行窄条，点一下铺开 */
  childStat?: ChildStat
  onOpen?: (slug: string) => void
  overlay?: boolean
}

export default function Card({ req, sessions, childStat, onOpen, overlay = false }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: req.slug,
    data: { type: 'card', slug: req.slug, status: req.status },
    disabled: overlay,
  })

  /**
   * 父需求默认收成一行：它自己不常是可执行的活，铺成整张卡只是把子需求挤下去。
   * 收窄不改它的状态，也不动它落在哪一列。
   */
  const [open, setOpen] = useState(false)
  const folded = !!childStat && !open && !overlay

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card${folded ? ' folded' : ''}${isDragging ? ' dragging' : ''}`}
      onClick={() => (folded ? setOpen(true) : !overlay && onOpen?.(req.slug))}
      title={folded ? '展开' : undefined}
      {...listeners}
      {...attributes}
    >
      <div className="card-top">
        {/* 收窄后只能靠这个 caret 收回去：卡片本身的点击是开详情，展开态点别处不该变成收起 */}
        {childStat && !overlay && (
          <svg
            className="card-fold-caret"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            onClick={(e) => {
              e.stopPropagation()
              setOpen((v) => !v)
            }}
          >
            <title>{open ? '收起' : '展开'}</title>
            <polyline points={open ? '6 9 12 15 18 9' : '9 6 15 12 9 18'} />
          </svg>
        )}
        <span className="card-title">{req.title}</span>
        {childStat && (
          <span className="card-kids" title={`${childStat.total} 个子需求，已完成 ${childStat.done}`}>
            {childStat.done}/{childStat.total}
          </span>
        )}
      </div>
      {/* 每个会话各挂一个角标：一眼看出这条需求名下哪个 agent 跑完了、哪个卡住了。
          拖拽浮层里不挂——那一层只负责跟手，不是给人读的。父需求收窄了也照挂：
          父需求名下常有自己的会话和工作区，收窄不该把信号一起收掉 */}
      {!overlay && sessions && sessions.length > 0 && (
        <div className="thread-badges">
          {sessions.map((s) => (
            <ThreadBadge key={`${s.agent}:${s.session}`} session={s} />
          ))}
        </div>
      )}
      {!folded && (
        <>
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
        </>
      )}
    </div>
  )
}
