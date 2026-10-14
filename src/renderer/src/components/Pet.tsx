import { useEffect, useState } from 'react'
import { AGENT_LABELS } from '../lib/labels'
import { agentFilter, petImageSrc } from '../lib/pet-art'
import { PET_LABEL, planPetRow, type PetState } from '../lib/pets'
import type { Session } from '../lib/types'

/**
 * 系统开了「减少动态效果」就换静态素材。
 * 素材是 <img> 里的 SVG，自带 <style> 与 @keyframes——外部 CSS 够不进那个文档，停不掉它的动画，
 * 所以另有剥掉动画的 *.still.svg（构建期生成，见 scripts/build-pets.mjs）。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const sync = () => setReduced(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return reduced
}

/**
 * 一档状态一只 pet：换成 clawd 的像素形象，动作是素材自带的（每张 SVG 里都有自己的 @keyframes）。
 *
 * 状态只从 props 进，组件本身不认识会话、数据源——可以拿假状态单独开发。
 * `event` 是「这是个没读过的事件」——事件边框与一次性动效靠它，读过就没了；
 * pet 本身不跟事件走，读过了照样留着（它是回到会话的入口）。
 * `focus` 由外面的 PetRow 选出，同一时刻最多一只（见 lib/pets.ts 的 focusIndex）；
 * `compact` 是折叠卡上的小号变体，`still` 换静态素材（减动效兜底）。
 * 有 `link` 就渲染成按钮，点一下跳回会话；没有的只报状态，不给一个点了没反应的按钮。
 * 卡片是可拖拽的，所以这里把 pointerdown 拦掉。
 */
export default function Pet({
  agent,
  state,
  event = false,
  focus = false,
  compact = false,
  still = false,
  tip,
  link,
}: {
  agent: string
  state: PetState
  event?: boolean
  focus?: boolean
  compact?: boolean
  still?: boolean
  tip?: string
  link?: string
}) {
  const label = `${AGENT_LABELS[agent] ?? agent} · ${PET_LABEL[state]}`
  const tint = agentFilter(agent)
  const body = (
    <img
      src={petImageSrc(state, { compact, still })}
      alt=""
      draggable={false}
      style={tint ? { filter: tint } : undefined}
    />
  )
  const cls = `pet${compact ? ' compact' : ''} s-${state}${event ? ' event' : ''}${focus ? ' focus' : ''}`

  if (!link) {
    return (
      <span className={cls} title={tip ?? label} role="img" aria-label={label}>
        {body}
      </span>
    )
  }
  return (
    <button
      className={cls}
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
 * 挂哪些会话、最多几只、谁带事件样式、谁抢注意力都在 planPetRow 里算好：pet 长期留着
 * （读得到状态就挂），只有事件边框与动效跟 `fresh` 走。
 * `compact` 给折叠的父需求窄条用——44px 塞不进去，收成小号。
 */
export function PetRow({ sessions, compact = false }: { sessions: Session[]; compact?: boolean }) {
  const { items, more } = planPetRow(sessions)
  const still = usePrefersReducedMotion()
  if (items.length === 0) return null

  return (
    <div className={`pets${compact ? ' compact' : ''}`}>
      {items.map((p) => (
        <Pet
          key={`${p.session.agent}:${p.session.session}`}
          agent={p.session.agent}
          state={p.state}
          event={p.event}
          focus={p.focus}
          compact={compact}
          still={still}
          tip={petTip(p.session, p.state)}
          link={p.session.link || undefined}
        />
      ))}
      {more > 0 && (
        <span className={`pet-more${compact ? ' compact' : ''}`} title={`还有 ${more} 个会话未展示`}>
          +{more}
        </span>
      )}
    </div>
  )
}
