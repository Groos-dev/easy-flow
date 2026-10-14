import { useEffect, useState } from 'react'
import { AGENT_LABELS } from '../lib/labels'
import { petArt } from '../lib/pet-art'
import { PET_LABEL, planPetRow, type PetState } from '../lib/pets'
import type { Session } from '../lib/types'

/**
 * 系统开了「减少动态效果」就换静态素材。
 * clawd 的自带动画封在 <img> 的 SVG 文档里，外部 CSS 够不进去，只能另出 *.still.svg；
 * cloudling 是脚本驱动，停不了 JS，still 版由构建脚本只放行首帧。都见 scripts/build-pets.mjs。
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
 * 一档状态一只 pet：一个 agent 一套素材，动作与表情都来自素材本身
 * （clawd 是 SVG 自带的 @keyframes，cloudling 是素材里的脚本；宿主不再另写）。
 *
 * 状态只从 props 进，组件本身不认识会话、数据源——可以拿假状态单独开发。
 * `label` 是展示文案，缺省按姿势取；读过的 done 姿势是静止、文案是「跑完已看」，
 * 由调用方给（见 lib/pets.ts 的 petLabelOf）——姿势和文案不是一回事。
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
  label,
  event = false,
  focus = false,
  compact = false,
  still = false,
  tip,
  link,
}: {
  agent: string
  state: PetState
  label?: string
  event?: boolean
  focus?: boolean
  compact?: boolean
  still?: boolean
  tip?: string
  link?: string
}) {
  const name = `${AGENT_LABELS[agent] ?? agent} · ${label ?? PET_LABEL[state]}`
  const { src, channel } = petArt(agent, state, { compact, still })
  // cloudling 是脚本驱动、必须走 <object>；clawd 走 <img>（每张 SVG 自带同名 @keyframes，内联会互相覆盖）
  const body =
    channel === 'object' ? (
      <object data={src} type="image/svg+xml" aria-hidden="true" />
    ) : (
      <img src={src} alt="" draggable={false} />
    )
  const cls = `pet${compact ? ' compact' : ''} s-${state}${event ? ' event' : ''}${focus ? ' focus' : ''}`

  if (!link) {
    return (
      <span className={cls} title={tip ?? name} role="img" aria-label={name}>
        {body}
      </span>
    )
  }
  return (
    <button
      className={cls}
      title={tip ?? name}
      aria-label={name}
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
function petTip(session: Session, label: string): string {
  const { needsAction, detail } = session.status
  return [
    session.title || session.session,
    `${AGENT_LABELS[session.agent] ?? session.agent} · ${label}`,
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
 * （读得到状态就挂），事件边框与动效跟 `fresh` 走，姿势也看一眼 `fresh`（读过的 done 落静止）。
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
          label={p.label}
          event={p.event}
          focus={p.focus}
          compact={compact}
          still={still}
          tip={petTip(p.session, p.label)}
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
