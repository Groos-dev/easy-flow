import { useDraggable } from '@dnd-kit/core'
import { useRef, type KeyboardEvent } from 'react'
import { shortcutLabel } from '../lib/keys'
import type { ChildStat, Requirement, Session } from '../lib/types'
import { relTime } from '../lib/time'
import { PetRow } from './Pet'

interface Props {
  req: Requirement
  // 这条需求名下的全部会话。谁挂 pet、谁在等人都由 PetRow 判——卡片自己不再单独高亮
  sessions?: Session[]
  // 有子需求才传：右上角多出完成度与展开键
  childStat?: ChildStat
  // 直接子需求，展开后列出来。子需求散在别的列，这是父卡片上唯一通往它们的路
  kids?: Requirement[]
  // 点某条子需求：由看板负责滚过去并高亮，卡片自己不认路
  onJumpChild?: (slug: string) => void
  // 刚被跳过来的那条：闪一下，好让人在满屏卡片里认出落点
  flash?: boolean
  kidsOpen?: boolean
  onToggleKids?: (slug: string) => void
  onFocusCard?: (slug: string) => void
  onOpen?: (slug: string) => void
  overlay?: boolean
}

export default function Card({
  req,
  sessions,
  childStat,
  kids,
  onJumpChild,
  flash,
  kidsOpen = false,
  onToggleKids,
  onFocusCard,
  onOpen,
  overlay = false,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: req.slug,
    data: { type: 'card', slug: req.slug, status: req.status },
    disabled: overlay,
  })

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  // Tab 回到卡片再按下去时，落回刚才那只头像；头一次进去是排第一个（Shift+Tab 是最后一个）
  const lastPet = useRef<HTMLElement | null>(null)

  /**
   * Tab 只在这一层的两档之间来回：卡片 ↔ 头像。
   * 头像之间怎么走归 hjkl / 方向键（见 Pet 的 PetSlot），换卡仍是 j/k。
   */
  function onTabToggle(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || overlay) return
    const card = e.currentTarget
    const pets = Array.from(card.querySelectorAll<HTMLElement>('.slot[tabindex]'))
    if (!pets.length) return
    e.preventDefault()
    const active = document.activeElement as HTMLElement | null
    if (active && active.closest('.slot')) {
      card.focus()
      return
    }
    const remembered = lastPet.current
    const back = remembered && card.contains(remembered) ? remembered : pets[e.shiftKey ? pets.length - 1 : 0]
    back.focus()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slug={req.slug}
      className={`card${isDragging ? ' dragging' : ''}${flash ? ' flash' : ''}`}
      {...listeners}
      {...attributes}
      tabIndex={overlay ? undefined : 0}
      onClick={() => !overlay && onOpen?.(req.slug)}
      onFocus={(e) => {
        if (overlay) return
        // 焦点落进哪只头像就从哪只记起：Tab 出去再回来接得上
        const slot = (e.target as HTMLElement).closest<HTMLElement>('.slot')
        if (slot) lastPet.current = slot
        onFocusCard?.(req.slug)
      }}
      onKeyDown={onTabToggle}
    >
      <div className="card-top">
        <span className="card-title">{req.title}</span>
        {/* 完成度与展开键挨着，一起靠右：它们说的都是子需求那一块，不是整张卡 */}
        {childStat && (
          <span className="card-kids" title={`${childStat.total} 个子需求，已完成 ${childStat.done}`}>
            {childStat.done}/{childStat.total}
          </span>
        )}
        {/* 卡片本身的点击是开详情，展开键得自己 stopPropagation */}
        {childStat && !overlay && (
          <svg
            className="card-kids-caret"
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
              onToggleKids?.(req.slug)
            }}
          >
            <title>{`${kidsOpen ? '收起' : '展开'}子需求（${shortcutLabel('board.kids')}）`}</title>
            <polyline points={kidsOpen ? '6 9 12 15 18 9' : '9 6 15 12 9 18'} />
          </svg>
        )}
      </div>
      {/* 每个会话一只 pet：姿势看出哪个 agent 在等你、哪个跑完了；要人回答的那句话在它头顶的气泡里。
          拖拽浮层也照原样画一排——少这一排浮层就比真卡矮，原位那张 0.4 的卡会从底下露出来 */}
      <PetRow sessions={sessions ?? []} inert={overlay} />
      {req.summary && <div className="card-summary">{req.summary}</div>}
      {/* 子需求清单：卡片上那行 1/3 只说还剩几块，这里说它们分别是什么、在哪一列 */}
      {kidsOpen && kids && kids.length > 0 && (
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
    </div>
  )
}
