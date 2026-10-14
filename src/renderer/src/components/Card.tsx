import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { ChildStat, Requirement, Session } from '../lib/types'
import { isEventState } from '../lib/threads'
import { relTime } from '../lib/time'
import { PetRow } from './Pet'

interface Props {
  req: Requirement
  /** 这条需求名下的全部会话。挂不挂 pet 由 PetRow 自己按 badgesOf 判——卡片的待处理
   *  状态要比角标宽一点（读过但没回答的 blocked 也算），拿不到全量就漏掉那种 */
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

  /**
   * 卡片自己的状态：卡住了优先，其余未读事件次之。判据与角标同一套（`needsBadge`）——
   * 事件消费一次就消，所以「有告警」与「有可点的入口」永远同时成立，不会出现
   * 只报警、点不到会话的卡片。
   */
  const all = sessions ?? []
  const blocked = all.find((s) => s.status.state === 'blocked' && s.status.fresh)
  const need = blocked?.status.needsAction ?? ''
  const unread = !blocked && all.some((s) => isEventState(s.status.state) && s.status.fresh)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card${folded ? ' folded' : ''}${isDragging ? ' dragging' : ''}${
        need ? ' needs-you' : unread ? ' unread' : ''
      }`}
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
      {/* 收窄也照挂：父需求名下常有自己的会话，收窄不该把信号一起收掉 */}
      {!overlay && need && <div className="card-need">{need}</div>}
      {/* 每个会话一只 pet：姿势看出哪个 agent 在等你、哪个跑完了。
          收窄的父需求窄条也挂，只是收成小号——pet 是卡上唯一能直接跳回会话的入口，
          不能逼人先展开；拖拽浮层只负责跟手，那一层不挂 */}
      {!overlay && <PetRow sessions={all} compact={folded} />}
      {!folded && (
        <>
          {req.summary && <div className="card-summary">{req.summary}</div>}
          {/* 页脚只留日期：slug 是命令行的句柄，仓库是「涉及仓库」表里的短名，
              两样在看板上都扫不出信息——详情浮窗与需求文档里有 */}
          <div className="card-foot">
            {/* 状态更新日期优先；没有就回落到文件修改时间 */}
            <span className="stage">{req.updated ? req.updated.slice(5) : relTime(req.mtime)}</span>
          </div>
        </>
      )}
    </div>
  )
}
