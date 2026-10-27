import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import { AGENT_LABELS } from '../lib/labels'
import { shortcut } from '../lib/keys'
import { petArt, scopeCloudling, idleMoodOf, isWaking, type IdleMood } from '../lib/pet-art'
import { isEventState } from '../lib/threads'
import { bubbleToneOf, PET_LABEL, planPetRow, type PetItem, type Pose } from '../lib/pets'
import type { Session } from '../lib/types'

/**
 * 系统开了「减少动态效果」就换静态素材。
 * clawd 的自带动画封在 <img> 的 SVG 文档里，外部 CSS 够不进去，只能另出 *.still.svg；
 * cxb / cursor 是动画 WebP，换首帧的 *-still.webp；
 * cloudling 内联在页面里，由下面的 Cloudling 只放行首帧。构建见 scripts/build-*-pet.*。
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

// 醒来这一档停多久：素材本身是 1.6s 的循环，播一轮就切回目标姿势
const WAKE_MS = 1600

/**
 * 从睡着里被叫醒时先亮一档「醒来」。
 *
 * 上一帧还停在静止（且已经困到瘫倒 / 睡着），这一帧不再静止，就说明它被叫醒了；
 * 只对素材里有 wake 这一档的 agent 生效（程小帮），且折叠卡不放小号版。
 * `prev` 用 ref 记：它只用来判断「上一帧是什么」，不进渲染。
 */
function useWake(agent: string, state: Pose, mood: IdleMood | undefined, enabled: boolean): boolean {
  const prev = useRef({ state, mood: mood ?? 'awake' })
  const [wake, setWake] = useState(false)
  useEffect(() => {
    const woke = enabled && isWaking(agent, prev.current, state)
    prev.current = { state, mood: mood ?? 'awake' }
    if (!woke) {
      setWake(false)
      return
    }
    setWake(true)
    const timer = setTimeout(() => setWake(false), WAKE_MS)
    return () => clearTimeout(timer)
  }, [agent, state, mood, enabled])
  return wake
}

/**
 * 一档状态一只 pet：一个 agent 一套素材，动作与表情都来自素材本身
 * （clawd 是 SVG 自带的 @keyframes，cloudling 是素材里的脚本，cxb / cursor 是动作表合成的循环 WebP；
 * 宿主不再另写）。
 *
 * 状态只从 props 进，组件本身不认识会话、数据源——可以拿假状态单独开发。
 * `event` 是「这是个没读过的事件」——事件边框与一次性动效靠它，读过就没了；
 * pet 本身不跟事件走，读过了照样留着（它是回到会话的入口）。
 * `focus` 由外面的 PetRow 选出，同一时刻最多一只（见 lib/pets.ts 的 focusIndex）；
 * `compact` 是折叠卡上的小号变体，`still` 换静态素材（减动效兜底）。
 * pet 只负责展示状态；跳转由外层透明命中层消费，避免内联 SVG 影响鼠标事件。
 */
export default function Pet({
  agent,
  state,
  mood,
  event = false,
  focus = false,
  compact = false,
  still = false,
}: {
  agent: string
  state: Pose
  mood?: IdleMood
  event?: boolean
  focus?: boolean
  compact?: boolean
  still?: boolean
}) {
  const name = `${AGENT_LABELS[agent] ?? agent} · ${PET_LABEL[state]}`
  const wake = useWake(agent, state, mood, !compact)
  const art = petArt(agent, state, { compact, still, mood, wake })
  // cloudling 内联成 <svg>（脚本驱动，且 object 的文档画布不透明）；clawd / cxb / cursor 走 <img>（每张自带同名 @keyframes，内联会互相覆盖）
  const body =
    art.channel === 'inline' ? (
      <Cloudling svg={art.svg} still={still} />
    ) : (
      <img src={art.src} alt="" draggable={false} />
    )
  const cls = `pet${agent === 'chengxiaobang' ? ' cxb' : ''}${agent === 'cursor' ? ' cursor' : ''}${compact ? ' compact' : ''} s-${state}${event ? ' event' : ''}${focus ? ' focus' : ''}`

  return (
    <span className={cls} role="img" aria-label={name}>
      {body}
    </span>
  )
}

function Bubble({ text, state }: { text: string; state: Pose }) {
  const tone = bubbleToneOf(state)
  return (
    <div className={`bubble${tone === 'act' ? '' : ` t-${tone}`}`} title={text}>
      <span className="bubble-text" key={text}>
        {text}
      </span>
    </div>
  )
}

// 鼠标移开 / 焦点移走之后气泡还留多久
const LINGER_MS = 30_000

/**
 * 气泡在不在：非静止那几档一到就一直挂着，直到状态变了；静止那档要鼠标停在这只 pet 上
 * （或 Tab 把焦点落上来）才出，移开后再留 30 秒——点过 pet 会把它写成静止，所以点完也是「过一会儿才收」。
 * 悬停与焦点是同一个信号：两者都撤了才开始计时。
 */
function useBubbleShown(pinned: boolean, active: boolean): boolean {
  const [shown, setShown] = useState(pinned)
  useEffect(() => {
    if (pinned || active) {
      setShown(true)
      return
    }
    // 本来就没露，不排这个队：不然一只静止的 pet 一挂载就白等 30 秒再走一遍 setState
    if (!shown) return
    const timer = setTimeout(() => setShown(false), LINGER_MS)
    return () => clearTimeout(timer)
  }, [pinned, active, shown])
  return shown
}

/**
 * 一只 pet 一格：气泡在上、pet 在下，尾巴指着自己那只。格子的宽度跟着气泡在不在变——
 * 没气泡时收成 pet 的宽度挤在一起，有气泡时撑开（过渡在 styles.css 里）。
 */
function PetSlot({ item, compact, still }: { item: PetItem; compact: boolean; still: boolean }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [openError, setOpenError] = useState('')
  const [onScreen, setOnScreen] = useState(true)
  const slotRef = useRef<HTMLDivElement>(null)
  const { session, state } = item
  const hasBubble = item.bubble !== ''
  // 焦点与悬停共用一条气泡规则：移开焦点和移开鼠标一样，气泡再留 30 秒
  const shown = useBubbleShown(hasBubble && state !== 'idle', hovered || focused)
  // 静止档只在鼠标落上来时播动画，滚出视野的也不播：满屏 pet 常驻逐帧绘制是看板空转 CPU 的大头。
  // 键盘焦点不参与——在头像之间移动时每步都换素材，云宝那种脚本驱动的内联 SVG 得重新解析一遍
  const stillArt = still || !onScreen || (state === 'idle' && !hovered)
  const canFocusWorkspace = session.agent === 'cursor' && !!session.cwd
  const focusable = !!session.link || canFocusWorkspace
  const openFromSlot = () => {
    if (!session.link && !canFocusWorkspace) return
    setOpenError('')
    if (session.link) {
      api.markSessionClicked(session.agent, session.session).catch(() => {})
      if (window.easyFlow?.openExternal) void window.easyFlow.openExternal(session.link)
      else window.open(session.link, '_blank')
      return
    }
    void api
      .openSessionWorkspace(session.agent, session.session)
      .then(() => api.markSessionClicked(session.agent, session.session))
      .catch((error: Error) => setOpenError(error.message || '打开失败'))
  }

  // 视野外就换静态素材：滚动容器在 .column-body，viewport 作 root 能覆盖这一层
  useEffect(() => {
    const el = slotRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 焦点停在这一格：回车走和鼠标点击同一条路，Esc 交回卡片，hjkl / 方向键在同一排头像里走；
  // 看板那套单键由 App 让位
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (shortcut(e, 'pet.open')) {
      e.preventDefault()
      e.stopPropagation()
      openFromSlot()
      return
    }
    if (shortcut(e, 'pet.back')) {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.closest<HTMLElement>('.card')?.focus()
      return
    }
    if (shortcut(e, 'pet.prev') || shortcut(e, 'pet.next')) {
      e.preventDefault()
      e.stopPropagation()
      // 只在同一排里走：到头停住，回卡片走 Tab / Esc
      const pets = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('.slot[tabindex]') ?? [])
      const step = shortcut(e, 'pet.prev') ? -1 : 1
      pets[pets.indexOf(e.currentTarget) + step]?.focus()
    }
  }

  return (
    <div
      ref={slotRef}
      className={`slot${shown ? ' shown' : ''}`}
      tabIndex={focusable ? 0 : undefined}
      role={focusable ? (session.link ? 'link' : 'button') : undefined}
      aria-label={
        focusable
          ? session.link
            ? `回到 ${AGENT_LABELS[session.agent] ?? session.agent} 的会话`
            : `打开 ${AGENT_LABELS[session.agent] ?? session.agent} 的工作区`
          : undefined
      }
      title={
        openError
          ? `打开失败：${openError}`
          : focusable
            ? session.link
              ? session.title || session.session
              : `打开工作区；会话 ${session.session}`
            : undefined
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={focusable ? () => setFocused(true) : undefined}
      onBlur={focusable ? () => setFocused(false) : undefined}
      onKeyDown={onKeyDown}
    >
      {!compact && hasBubble && (
        <div className="bubble-box">
          <div className="bubble-clip">
            <Bubble text={item.bubble} state={state} />
          </div>
        </div>
      )}
      {focusable && (
        <span
          className="pet-hit-layer"
          aria-hidden="true"
          onPointerDown={(e) => {
            // 鼠标点一下就跳走了，别让这一格顺手拿走焦点——之后按 Esc 会落在错的层级
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            openFromSlot()
          }}
        />
      )}
      {openError && (
        <span className="pet-error" title={openError}>
          !
        </span>
      )}
      <Pet
        agent={session.agent}
        state={state}
        mood={state === 'idle' ? idleMoodOf(session.status.observedAt) : undefined}
        event={isEventState(state)}
        focus={item.focus}
        compact={compact}
        still={stillArt}
      />
    </div>
  )
}

/**
 * 卡片上的那排 pet：把一条需求名下的会话译成 pet 并排开。
 *
 * 挂哪些会话、谁带事件样式、谁抢注意力都在 planPetRow 里算好：pet 长期留着
 * （读得到状态就挂），姿势就是状态本身；点过 pet 会被写成 idle，边框与动效跟着消失。
 * `compact` 给折叠的父需求窄条用——44px 塞不进去，收成小号，那档不挂气泡。
 * `inert` 给拖拽浮层用：那一排只是照着画，不能抢焦点、不能点开会话。
 */
export function PetRow({
  sessions,
  compact = false,
  inert = false,
}: {
  sessions: Session[]
  compact?: boolean
  inert?: boolean
}) {
  const { items } = planPetRow(sessions)
  const still = usePrefersReducedMotion()
  if (items.length === 0) return null

  return (
    <div className={`pets${compact ? ' compact' : ''}`} {...(inert ? { inert: '' } : {})}>
      {items.map((p) => (
        <PetSlot key={`${p.session.agent}:${p.session.session}`} item={p} compact={compact} still={still} />
      ))}
    </div>
  )
}
