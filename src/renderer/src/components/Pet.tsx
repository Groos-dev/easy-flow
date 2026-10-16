import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api'
import { AGENT_LABELS } from '../lib/labels'
import { petArt, scopeCloudling, idleMoodOf, type IdleMood } from '../lib/pet-art'
import { PET_LABEL, planPetRow, type BubbleTone, type Pose } from '../lib/pets'
import type { Session } from '../lib/types'

/**
 * 系统开了「减少动态效果」就换静态素材。
 * clawd 的自带动画封在 <img> 的 SVG 文档里，外部 CSS 够不进去，只能另出 *.still.svg；
 * cloudling 内联在页面里，由下面的 Cloudling 只放行首帧。都见 scripts/build-pets.mjs。
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
 * 内联云宝的运行壳：给素材自带的脚本换一套作用域。
 *
 * - `document` 收窄到这棵子树。素材里除了 `getElementById`，还有 `querySelectorAll('.spark')`
 *   这种按文档找的调用——不收窄，同屏两只同档云宝会互相改对方的元素。
 * - `requestAnimationFrame` 也换掉：素材的循环只会一直排下一帧、自己不会停，元素一离开文档
 *   （换档、卸载）就得断在下一帧，否则每换一次状态都多一条空转的 rAF。`still` 时只放行首帧——
 *   眼睛与姿态是脚本画的，整段剥掉会剩一朵没表情的云。
 *
 * 用元素属性当实例句柄：壳在脚本之前求值，拿不到脚本里的变量，只能从外面按 `data-pet` 找回来。
 */
function inlineShell(uid: string, still: boolean, script: string): string {
  return `(function (root, raf) {
  var left = ${still ? 1 : Infinity};
  var requestAnimationFrame = function (cb) {
    if (left <= 0 || !root.isConnected) return 0;
    left -= 1;
    return raf(cb);
  };
  var document = {
    createElement: window.document.createElement.bind(window.document),
    createElementNS: window.document.createElementNS.bind(window.document),
    getElementById: function (id) { return root.id === id ? root : root.querySelector('#' + id) },
    querySelector: function (s) { return root.querySelector(s) },
    querySelectorAll: function (s) { return root.querySelectorAll(s) },
  };
${script}
})(window.document.querySelector('[data-pet="${uid}"]'), window.requestAnimationFrame.bind(window))`
}

/**
 * 云宝：素材是脚本驱动的，`<img>` 会禁脚本、`<object>` 的文档画布又不透明，所以内联进宿主 DOM——
 * 内联的 SVG 是普通元素，背景天然透明，主题怎么变都跟着走。
 *
 * 挂载是命令式的：那半截脚本要「插进文档之后」才会跑，React 的渲染管不到这一步。
 * 同屏多只的 id 撞车在 scopeCloudling 里按实例改写掉。
 */
function Cloudling({ svg, still }: { svg: string; still: boolean }) {
  const host = useRef<HTMLSpanElement>(null)
  // 只用来当 id 后缀与查找句柄，取 useId 里能进 id 与属性选择器的那部分
  const uid = useId().replace(/\W/g, '')
  // 用 useEffect 不用 useLayoutEffect：挂载点本来就等数据，晚一帧无所谓，而 layout effect 在 SSR 下会刷警告
  useEffect(() => {
    const el = host.current
    if (!el) return
    const { markup, script } = scopeCloudling(svg, uid)
    const root = document.importNode(new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement, true)
    root.setAttribute('data-pet', uid)
    el.replaceChildren(root)
    if (!script) return
    // 脚本顶层有一堆 const，同屏多只会重复声明，包一层 IIFE（在 inlineShell 里）
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'script')
    const nonce = window.easyFlow?.cspNonce
    if (nonce) s.setAttribute('nonce', nonce)
    s.textContent = inlineShell(uid, still, script)
    root.appendChild(s)
  }, [svg, still, uid])
  return <span ref={host} className="pet-art" aria-hidden="true" />
}

/**
 * 一档状态一只 pet：一个 agent 一套素材，动作与表情都来自素材本身
 * （clawd 是 SVG 自带的 @keyframes，cloudling 是素材里的脚本；宿主不再另写）。
 *
 * 状态只从 props 进，组件本身不认识会话、数据源——可以拿假状态单独开发。
 * `event` 是「这是个没读过的事件」——事件边框与一次性动效靠它，读过就没了；
 * pet 本身不跟事件走，读过了照样留着（它是回到会话的入口）。
 * `focus` 由外面的 PetRow 选出，同一时刻最多一只（见 lib/pets.ts 的 focusIndex）；
 * `compact` 是折叠卡上的小号变体，`still` 换静态素材（减动效兜底）。
 * 有 `link` 就渲染成按钮，点一下跳回会话；没有的只报状态，不给一个点了没反应的按钮。
 * `onOpen` 在跳转前叫一声，调用方拿去记「这只 pet 我点过了」（见 lib/api.ts）。
 * 卡片是可拖拽的，所以这里把 pointerdown 拦掉。
 */
export default function Pet({
  agent,
  state,
  mood,
  event = false,
  focus = false,
  compact = false,
  still = false,
  tip,
  link,
  onOpen,
}: {
  agent: string
  state: Pose
  mood?: IdleMood
  event?: boolean
  focus?: boolean
  compact?: boolean
  still?: boolean
  tip?: string
  link?: string
  onOpen?: () => void
}) {
  const name = `${AGENT_LABELS[agent] ?? agent} · ${PET_LABEL[state]}`
  const art = petArt(agent, state, { compact, still, mood })
  // cloudling 内联成 <svg>（脚本驱动，且 object 的文档画布不透明）；clawd 走 <img>（每张自带同名 @keyframes，内联会互相覆盖）
  const body =
    art.channel === 'inline' ? (
      <Cloudling svg={art.svg} still={still} />
    ) : (
      <img src={art.src} alt="" draggable={false} />
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
        onOpen?.()
        window.open(link, '_blank')
      }}
    >
      {body}
    </button>
  )
}

/** 悬停先答「这条会话在做什么」，再给状态与原文 */
function petTip(session: Session, state: Pose): string {
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

function Bubble({ text, tone }: { text: string; tone: BubbleTone }) {
  return (
    <div className={`bubble${tone === 'act' ? '' : ` t-${tone}`}`} key={text} title={text}>
      <span className="bubble-text">{text}</span>
    </div>
  )
}

function moreTip(more: number, needsYou: number): string {
  return `还有 ${more} 个会话未展示${needsYou > 0 ? `，其中 ${needsYou} 个在等你处理` : ''}`
}

/**
 * 卡片上的那排 pet：把一条需求名下的会话译成 pet 并排开。
 *
 * 挂哪些会话、最多几只、谁带事件样式、谁抢注意力都在 planPetRow 里算好：pet 长期留着
 * （读得到状态就挂），姿势就是状态本身；点过 pet 会被写成 idle，边框与动效跟着消失。
 * `compact` 给折叠的父需求窄条用——44px 塞不进去，收成小号，那档不挂气泡。
 */
export function PetRow({ sessions, compact = false }: { sessions: Session[]; compact?: boolean }) {
  const { items, more, moreNeedsYou } = planPetRow(sessions)
  const still = usePrefersReducedMotion()
  if (items.length === 0) return null

  return (
    <div className={`pets${compact ? ' compact' : ''}`}>
      {items.map((p) => (
        <div className="slot" key={`${p.session.agent}:${p.session.session}`}>
          {!compact && p.bubble && <Bubble text={p.bubble} tone={p.tone} />}
          <Pet
            agent={p.session.agent}
            state={p.state}
            mood={p.state === 'idle' ? idleMoodOf(p.session.status.observedAt) : undefined}
            event={p.event}
            focus={p.focus}
            compact={compact}
            still={still}
            tip={petTip(p.session, p.state)}
            link={p.session.link || undefined}
            // 点一下 = 这条会话此刻「静止」：服务端写成一条状态事件，下一个 hook 事件直接覆盖。
            // 记不下不该拦住人打开会话，所以不等它、也不报错
            onOpen={() => {
              api.markSessionClicked(p.session.agent, p.session.session).catch(() => {})
            }}
          />
        </div>
      ))}
      {more > 0 && (
        <span
          className={`pet-more${moreNeedsYou > 0 ? ' attention' : ''}${compact ? ' compact' : ''}`}
          title={moreTip(more, moreNeedsYou)}
        >
          +{more}
        </span>
      )}
    </div>
  )
}
