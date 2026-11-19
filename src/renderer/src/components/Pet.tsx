import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { api } from '../lib/api'
import { AGENT_LABELS } from '../lib/labels'
import { shortcut } from '../lib/keys'
import { petArt, scopeCloudling, idleMoodOf, nextIdleStageIn, isWaking, type IdleMood } from '../lib/pet-art'
import { isEventState } from '../lib/threads'
import { bubbleToneOf, PET_LABEL, planPetRow, type PetItem, type Pose } from '../lib/pets'
import type { Session } from '../lib/types'

const visibility = new Map<Element, { visible: boolean; set: (visible: boolean) => void }>()
let petObserver: IntersectionObserver | null = null

function pageVisibility() {
  for (const entry of visibility.values()) entry.set(entry.visible && !document.hidden)
}

function usePetVisible(ref: RefObject<HTMLElement>): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const el = ref.current!
    if (!petObserver) {
      petObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const pet = visibility.get(entry.target)
          if (!pet) continue
          pet.visible = entry.isIntersecting
          pet.set(entry.isIntersecting && !document.hidden)
        }
      })
      document.addEventListener('visibilitychange', pageVisibility)
    }
    visibility.set(el, { visible: false, set: setVisible })
    petObserver.observe(el)
    return () => {
      petObserver!.unobserve(el)
      visibility.delete(el)
      if (!visibility.size) {
        petObserver!.disconnect()
        petObserver = null
        document.removeEventListener('visibilitychange', pageVisibility)
      }
    }
  }, [ref])
  return visible
}

function inlineShell(uid: string, script: string): string {
  return `(function (root, raf, cancel) {
  var frame = 0;
  var pending;
  var active = !root.hasAttribute('data-paused') && !window.document.hidden;
  var requestAnimationFrame = function (cb) {
    pending = cb;
    if (!active || !root.isConnected) return 0;
    frame = raf(function (now) {
      frame = 0;
      if (active && root.isConnected) cb(now);
    });
    return frame;
  };
  var update = function () {
    active = !root.hasAttribute('data-paused') && !window.document.hidden;
    cancel(frame);
    frame = 0;
    if (active && pending) requestAnimationFrame(pending);
    root.getAnimations({ subtree: true }).forEach(function (animation) {
      if (active) animation.play(); else animation.pause();
    });
  };
  var dispose = function () {
    active = false;
    cancel(frame);
    root.removeEventListener('pet-visibility', update);
    root.removeEventListener('pet-dispose', dispose);
    window.document.removeEventListener('visibilitychange', update);
  };
  root.addEventListener('pet-visibility', update);
  root.addEventListener('pet-dispose', dispose);
  window.document.addEventListener('visibilitychange', update);
  var document = {
    createElement: window.document.createElement.bind(window.document),
    createElementNS: window.document.createElementNS.bind(window.document),
    getElementById: function (id) { return root.id === id ? root : root.querySelector('#' + id) },
    querySelector: function (s) { return root.querySelector(s) },
    querySelectorAll: function (s) { return root.querySelectorAll(s) },
  };
${script}
  if (!active) update();
})(window.document.querySelector('[data-pet="${uid}"]'), window.requestAnimationFrame.bind(window), window.cancelAnimationFrame.bind(window))`
}

/**
 * 云宝：素材是脚本驱动的，`<img>` 会禁脚本、`<object>` 的文档画布又不透明，所以内联进宿主 DOM——
 * 内联的 SVG 是普通元素，背景天然透明，主题怎么变都跟着走。
 *
 * 挂载是命令式的：那半截脚本要「插进文档之后」才会跑，React 的渲染管不到这一步。
 * 同屏多只的 id 撞车在 scopeCloudling 里按实例改写掉。
 */
function Cloudling({ svg, active }: { svg: string; active: boolean }) {
  const playing = useRef(active)
  playing.current = active
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
    root.toggleAttribute('data-paused', !playing.current)
    el.replaceChildren(root)
    if (!script) return
    // 脚本顶层有一堆 const，同屏多只会重复声明，包一层 IIFE（在 inlineShell 里）
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'script')
    const nonce = window.easyFlow?.cspNonce
    if (nonce) s.setAttribute('nonce', nonce)
    s.textContent = inlineShell(uid, script)
    root.appendChild(s)
    return () => { root.dispatchEvent(new Event('pet-dispose')) }
  }, [svg, uid])
  useEffect(() => {
    const root = host.current?.firstElementChild
    root?.toggleAttribute('data-paused', !active)
    root?.dispatchEvent(new Event('pet-visibility'))
  }, [active, svg])
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
 * 静止档的困倦等级由「静了多久」算出，而看板没有数据变化就不重渲染：
 * 不自己排一个定时器，睡着的姿势要等下一次整板重渲染（常常就是鼠标落上来那一下）才出现。
 * 每次只排到下一个档口，到点重渲染一次再算下一次；睡到底就没有下一档了。
 */
function useIdleMood(observedAt: number): IdleMood {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const wait = nextIdleStageIn(observedAt, Date.now())
    if (wait === null) return
    const timer = setTimeout(() => setNow(Date.now()), wait)
    return () => clearTimeout(timer)
  }, [observedAt, now])
  return idleMoodOf(observedAt, now)
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
 * `compact` 是折叠卡上的小号变体。
 * pet 只负责展示状态；跳转由外层透明命中层消费，避免内联 SVG 影响鼠标事件。
 */
const Pet = memo(function Pet({
  agent,
  state,
  mood,
  event = false,
  focus = false,
  compact = false,
}: {
  agent: string
  state: Pose
  mood?: IdleMood
  event?: boolean
  focus?: boolean
  compact?: boolean
}) {
  const host = useRef<HTMLSpanElement>(null)
  const visible = usePetVisible(host)
  const name = `${AGENT_LABELS[agent] ?? agent} · ${PET_LABEL[state]}`
  const wake = useWake(agent, state, mood, !compact)
  const art = petArt(agent, state, { compact, mood, wake })
  // cloudling 内联成 <svg>（脚本驱动，且 object 的文档画布不透明）；clawd / cxb / cursor 走 <img>（每张自带同名 @keyframes，内联会互相覆盖）
  const body = art.channel === 'inline'
    ? <Cloudling svg={art.svg} active={visible} />
    : <img src={visible ? art.src : art.src.replace('pets/', 'pets/still/').replace('.webp', '.png')} alt="" draggable={false} />
  const cls = `pet${compact ? ' compact' : ''} s-${state}${event ? ' event' : ''}${focus ? ' focus' : ''}`

  return (
    <span ref={host} className={cls} data-paused={visible ? undefined : ''} role="img" aria-label={name}>
      {body}
    </span>
  )
})

export default Pet

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
const LINGER_MS = 60_000

/**
 * 气泡在不在：非静止那几档一到就一直挂着，直到状态变了；静止那档要鼠标停在这只 pet 上
 * （或 Tab 把焦点落上来）才出，移开后再留 1 分钟——点过 pet 会把它写成静止，所以点完也是「过一会儿才收」。
 * 悬停与焦点是同一个信号：两者都撤了才开始计时。
 */
function useBubbleShown(pinned: boolean, active: boolean): boolean {
  const [shown, setShown] = useState(pinned)
  useEffect(() => {
    if (pinned || active) {
      setShown(true)
      return
    }
    // 本来就没露，不排这个队：不然一只静止的 pet 一挂载就白等 1 分钟再走一遍 setState
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
function PetSlot({ item, compact }: { item: PetItem; compact: boolean }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [openError, setOpenError] = useState('')
  const { session, state } = item
  const hasBubble = item.bubble !== ''
  // 焦点与悬停共用一条气泡规则：移开焦点和移开鼠标一样，气泡再留 1 分钟
  const shown = useBubbleShown(hasBubble && state !== 'idle', hovered || focused)
  const mood = useIdleMood(state === 'idle' ? session.status.observedAt : 0)
  const canFocusWorkspace = session.agent === 'cursor' && !!session.cwd
  const focusable = !!session.link || canFocusWorkspace
  const openFromSlot = () => {
    if (!session.link && !canFocusWorkspace) return
    setOpenError('')
    if (session.link) {
      api.markSessionClicked(session.agent, session.session).catch(() => {})
      if (window.easyFlow?.openExternal) {
        void window.easyFlow.openExternal(session.link)
          .catch((error: Error) => setOpenError(error.message || '打开失败'))
      } else window.open(session.link, '_blank')
      return
    }
    void api
      .openSessionWorkspace(session.agent, session.session)
      .then(() => api.markSessionClicked(session.agent, session.session))
      .catch((error: Error) => setOpenError(error.message || '打开失败'))
  }

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
      className={`slot${shown ? ' shown' : ''}`}
      data-session={session.session}
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
        mood={state === 'idle' ? mood : undefined}
        event={isEventState(state)}
        focus={item.focus}
        compact={compact}
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
  limit,
  focusSession,
}: {
  sessions: Session[]
  compact?: boolean
  inert?: boolean
  limit?: number
  focusSession?: string
}) {
  const { items } = planPetRow(sessions)
  if (items.length === 0) return null

  let shown = items
  if (limit !== undefined) {
    shown = items.slice(0, limit)
    const focusAt = focusSession
      ? items.findIndex((p) => p.session.session === focusSession)
      : -1
    if (focusAt >= limit && limit > 0) shown = [...items.slice(0, limit - 1), items[focusAt]]
  }
  const rest = items.length - shown.length

  return (
    <div className={`pets${compact ? ' compact' : ''}`} {...(inert ? { inert: '' } : {})}>
      {shown.map((p) => (
        <PetSlot key={`${p.session.agent}:${p.session.session}`} item={p} compact={compact} />
      ))}
      {rest > 0 && (
        <span className="pet-more" title={`还有 ${rest} 个会话`}>
          +{rest}
        </span>
      )}
    </div>
  )
}
