import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { ChildStat, Requirement, Session } from '../lib/types'
import { STATUS_CLASS } from '../lib/labels'
import { relTime } from '../lib/time'
import { PetRow } from './Pet'

interface Props {
  req: Requirement
  /** 这条需求名下的全部会话。谁挂 pet、谁在等人都由 PetRow 判——卡片自己不再单独高亮 */
  sessions?: Session[]
  /** 有子需求才传：卡片默认收成一行窄条，点一下铺开 */
  childStat?: ChildStat
  /** 直接子需求，铺开后列出来。子需求散在别的列，这是父卡片上唯一通往它们的路 */
  kids?: Requirement[]
  /** 点某条子需求：由看板负责滚过去并高亮，卡片自己不认路 */
  onJumpChild?: (slug: string) => void
  /** 刚被跳过来的那条：闪一下，好让人在满屏卡片里认出落点 */
  flash?: boolean
  onOpen?: (slug: string) => void
  overlay?: boolean
}

export default function Card({ req, sessions, childStat, kids, onJumpChild, flash, onOpen, overlay = false }: Props) {
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
      data-slug={req.slug}
      className={`card${folded ? ' folded' : ''}${isDragging ? ' dragging' : ''}${flash ? ' flash' : ''}`}
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
      {/* 每个会话一只 pet：姿势看出哪个 agent 在等你、哪个跑完了；要人回答的那句话在它头顶的气泡里。
          收窄的父需求窄条也挂，只是收成小号——pet 是卡上唯一能直接跳回会话的入口，
          不能逼人先展开；拖拽浮层只负责跟手，那一层不挂 */}
      {!overlay && <PetRow sessions={sessions ?? []} compact={folded} />}
      {!folded && (
        <>
          {req.summary && <div className="card-summary">{req.summary}</div>}
          {/* 子需求清单：卡片上那行 1/3 只说还剩几块，这里说它们分别是什么、在哪一列 */}
          {kids && kids.length > 0 && (
            <div className="card-kids-list">
              {kids.map((k) => (
                <div
                  key={k.slug}
                  className="kid"
                  title={`跳到「${k.title}」`}
                  onClick={(e) => {
                    // 卡片自己的点击是开详情，子需求那一下不能被它吃掉
                    e.stopPropagation()
                    onJumpChild?.(k.slug)
                  }}
                >
                  <span className={`dot ${STATUS_CLASS[k.status] ?? 's-clarify'}`} />
                  <span className="kid-title">{k.title}</span>
                  <span className="kid-status">{k.status}</span>
                </div>
              ))}
            </div>
          )}
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
