import type { CSSProperties } from 'react'
import { AGENT_LABELS } from '../lib/labels'
import { badgesOf } from '../lib/threads'
import { AGENT_TINT, PET_LABEL, focusIndex, petStateOf, type PetState } from '../lib/pets'
import type { Session } from '../lib/types'

/** 一张卡最多挂几只：卡片内容宽约 310px，再多就挤了，多的收成 +N */
const MAX_PETS = 4

/**
 * 每档一张脸。姿势要能一眼分开——只靠颜色，色盲用户就废了。
 * 身体轮廓（下面 svg 里那两个 ellipse）共用，只有脸随状态换。
 */
function face(state: PetState) {
  switch (state) {
    case 'thinking':
      return (
        <>
          <circle cx="12.5" cy="14.6" r="1.9" fill="currentColor" />
          <circle cx="19.5" cy="14.6" r="1.9" fill="currentColor" />
          <circle cx="24.6" cy="8.2" r="1.3" fill="currentColor" opacity={0.5} />
          <circle cx="27.8" cy="5" r="1.8" fill="currentColor" opacity={0.3} />
        </>
      )
    case 'working':
      return (
        <>
          <circle cx="12.5" cy="16" r="1.9" fill="currentColor" />
          <circle cx="19.5" cy="16" r="1.9" fill="currentColor" />
          <path d="M13 21.4q3 1.7 6 0" stroke="currentColor" strokeWidth={1.3} fill="none" strokeLinecap="round" />
          <path d="M7 15.5l-3.4-2.4M25 15.5l3.4-2.4" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" opacity={0.85} />
        </>
      )
    case 'blocked':
      return (
        <>
          <circle cx="12.6" cy="15.6" r="2.7" fill="currentColor" />
          <circle cx="19.4" cy="15.6" r="2.7" fill="currentColor" />
          <circle cx="13.4" cy="14.7" r="0.9" fill="#232830" />
          <circle cx="20.2" cy="14.7" r="0.9" fill="#232830" />
          <path d="M16 3.6v4.4M16 10.6v.3" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
        </>
      )
    case 'done':
      return (
        <>
          <path d="M10.6 16.6l2-2.3 2 2.3M17.4 16.6l2-2.3 2 2.3" stroke="currentColor" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13 21q3 2.1 6 0" stroke="currentColor" strokeWidth={1.3} fill="none" strokeLinecap="round" />
          <path d="M24.5 5.6l1.8 1.9 3-3.4" stroke="currentColor" strokeWidth={1.9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'failed':
      return (
        <>
          <path d="M10.9 14.1l2.9 2.9M13.8 14.1l-2.9 2.9M18.2 14.1l2.9 2.9M21.1 14.1l-2.9 2.9" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
          <path d="M13 22q3-1.7 6 0" stroke="currentColor" strokeWidth={1.3} fill="none" strokeLinecap="round" />
        </>
      )
    default:
      return (
        <>
          <circle cx="12.5" cy="16" r="1.9" fill="currentColor" />
          <circle cx="19.5" cy="16" r="1.9" fill="currentColor" />
          <path d="M13 21.4q3 1.6 6 0" stroke="currentColor" strokeWidth={1.3} fill="none" strokeLinecap="round" />
        </>
      )
  }
}

/**
 * 一档状态一只 pet。状态只从 props 进，组件本身不认识会话、数据源——可以拿假状态单独开发。
 *
 * `focus` 由外面的 PetRow 按急缓选出来，同一时刻只有它动（见 lib/pets.ts 的 focusIndex）。
 * 有 `link` 就渲染成按钮，点一下跳回会话；没有的只报状态，不给一个点了没反应的按钮。
 * 卡片是可拖拽的，所以这里把 pointerdown 拦掉——从 pet 上按下不该变成拖卡片。
 */
export default function Pet({
  agent,
  state,
  focus = false,
  tip,
  link,
}: {
  agent: string
  state: PetState
  focus?: boolean
  tip?: string
  link?: string
}) {
  const label = `${AGENT_LABELS[agent] ?? agent} · ${PET_LABEL[state]}`
  const body = (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <ellipse cx="16" cy="18.6" rx="9.6" ry="8.8" fill="currentColor" opacity={0.16} />
      <ellipse cx="16" cy="18.6" rx="9.6" ry="8.8" fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.9} />
      {face(state)}
    </svg>
  )
  const cls = `pet s-${state}${focus ? ' focus' : ''}`
  const style = { '--tint': AGENT_TINT[agent] ?? AGENT_TINT.cursor } as CSSProperties

  if (!link) {
    return (
      <span className={cls} style={style} title={tip ?? label}>
        {body}
      </span>
    )
  }
  return (
    <button
      className={cls}
      style={style}
      title={tip ?? label}
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        window.open(link, '_blank')
      }}
    >
      {body}
    </button>
  )
}

/** 悬停先答「这条会话在做什么」，再给状态与原文 */
function petTip(session: Session, state: PetState): string {
  const { needsAction, detail } = session.status
  return [
    session.title || session.session,
    `${AGENT_LABELS[session.agent] ?? session.agent} · ${PET_LABEL[state]}`,
    needsAction ? `需要你回答：${needsAction}` : detail,
    session.link ? '点一下回到这个会话' : `没有会话级链接，会话 id：${session.session}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 卡片上的那排 pet：把一条需求名下的会话译成 pet 并排开。
 *
 * 挂哪些会话与角标同一套判据（`badgesOf`）——未读事件 + 正在跑，读过的事件连 pet 一起消失。
 * 一张卡最多 4 只，多的收成 +N。
 */
export function PetRow({ sessions }: { sessions: Session[] }) {
  const pets = badgesOf(sessions)
    .map((session) => ({ session, state: petStateOf(session.status.state) }))
    .filter((p): p is { session: Session; state: PetState } => p.state !== null)
  if (pets.length === 0) return null

  const focus = focusIndex(pets.map((p) => p.state))
  const shown = pets.slice(0, MAX_PETS)
  const more = pets.length - shown.length

  return (
    <div className="pets">
      {shown.map((p, i) => (
        <Pet
          key={`${p.session.agent}:${p.session.session}`}
          agent={p.session.agent}
          state={p.state}
          focus={i === focus}
          tip={petTip(p.session, p.state)}
          link={p.session.link || undefined}
        />
      ))}
      {more > 0 && (
        <span className="pet-more" title={`还有 ${more} 个会话未展示`}>
          +{more}
        </span>
      )}
    </div>
  )
}
