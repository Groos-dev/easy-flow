/**
 * 终端会话的保管处。
 *
 * 会话按 (project, slug) 缓存，活到应用退出为止：换需求、回看板、进设置都不杀它。
 * TerminalPane 只负责把 xterm 的 DOM 挪进当前页面——是搬元素而不是重建终端，
 * 所以滚屏内容与正在跑的进程都原样留在原处。
 *
 * 只有一处例外：浏览器开发模式没有 window.easyFlow，那时状态是 unavailable，
 * 连终端都不会建（见 acquireTerminal）。
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

/** 终端挂载点：需求（带 slug）或项目（开在项目根目录，是那个目录下第一个会话） */
export interface TerminalTarget {
  project: string
  slug?: string
}

export type TermState = 'connecting' | 'ready' | 'exited' | 'unavailable'

export interface TerminalSession {
  /** 当前状态。配合 subscribe 用 useSyncExternalStore 读，取到的都是原始值 */
  readonly state: TermState
  readonly exitCode: number | null
  subscribe(fn: () => void): () => void
  /** 把终端挂进这个宿主；返回摘除函数——只断开尺寸观察，会话留着 */
  attach(host: HTMLElement): () => void
  /** 字体就地生效，不重建终端（重建会丢滚屏） */
  setFont(fontFamily: string, fontSize: number): void
  /** 终端退出后重开一个 */
  restart(): void
}

/** 一个挂载点对应的会话。term 与 pty 都是懒建的：第一次 attach 才建终端 */
interface Record {
  target: TerminalTarget
  state: TermState
  exitCode: number | null
  fontFamily: string
  fontSize: number
  term: Terminal | null
  fit: FitAddon | null
  observer: ResizeObserver | null
  ptyId: string | null
  offData: (() => void) | null
  offExit: (() => void) | null
  listeners: Set<() => void>
  api: TerminalSession
}

const sessions = new Map<string, Record>()

const keyOf = (target: TerminalTarget): string => `${target.project}/${target.slug ?? ''}`

/** 取这个挂载点的会话；没有就登记一个（此时还不建终端，等 attach 拿到宿主） */
export function acquireTerminal(
  target: TerminalTarget,
  fontFamily: string,
  fontSize: number,
): TerminalSession {
  const key = keyOf(target)
  const existing = sessions.get(key)
  if (existing) {
    existing.fontFamily = fontFamily
    existing.fontSize = fontSize
    return existing.api
  }

  let rec: Record
  const api: TerminalSession = {
    get state() {
      return rec.state
    },
    get exitCode() {
      return rec.exitCode
    },
    subscribe: (fn) => {
      rec.listeners.add(fn)
      return () => {
        rec.listeners.delete(fn)
      }
    },
    attach: (host) => attach(rec, host),
    setFont: (family, size) => setFont(rec, family, size),
    restart: () => restart(rec),
  }

  rec = {
    target,
    state: window.easyFlow?.terminal ? 'connecting' : 'unavailable',
    exitCode: null,
    fontFamily,
    fontSize,
    term: null,
    fit: null,
    observer: null,
    ptyId: null,
    offData: null,
    offExit: null,
    listeners: new Set(),
    api,
  }
  sessions.set(key, rec)
  return api
}

// ------------------------------------------------------------------ 挂载

function attach(rec: Record, host: HTMLElement): () => void {
  if (!rec.term) {
    createTerminal(rec, host)
  } else if (rec.term.element && rec.term.element.parentElement !== host) {
    // 从上一个页面搬过来。元素本身没变，xterm 的实例、缓冲、PTY 都不受影响
    host.appendChild(rec.term.element)
  }

  // 换宿主后字符尺寸与可用宽高都变了，重新量一次
  fitAndSync(rec)
  rec.observer?.disconnect()
  rec.observer = new ResizeObserver(() => fitAndSync(rec))
  rec.observer.observe(host)

  return () => {
    rec.observer?.disconnect()
    rec.observer = null
    // 摘下来而不是让它随宿主一起脱离文档：xterm 对「隐藏」比对「不在 DOM 里」熟得多。
    // 下次 attach 会把它从这里再搬进新宿主
    if (rec.term?.element) park(rec.term.element)
  }
}

/**
 * 摘下来的终端先停在这儿：留在文档里、只是 display:none。
 * 名字叫停车位——它只中转，不负责结束任何会话。
 */
let parking: HTMLDivElement | null = null
function park(element: HTMLElement): void {
  if (!parking) {
    parking = document.createElement('div')
    parking.style.display = 'none'
    document.body.appendChild(parking)
  }
  parking.appendChild(element)
}

/** 隐藏时宿主宽高为 0，fit 会算出个 1x1 再把 PTY 也带歪——量到 0 就不动手 */
function fitAndSync(rec: Record): boolean {
  const host = rec.term?.element?.parentElement
  if (!rec.term || !rec.fit || !host || host.clientWidth === 0 || host.clientHeight === 0) {
    return false
  }
  try {
    rec.fit.fit()
  } catch {
    // open() 之后渲染服务尚未测量完时 fit 会抛错，ResizeObserver 稍后会再试
    return false
  }
  const bridge = window.easyFlow?.terminal
  if (rec.ptyId && bridge) bridge.resize(rec.ptyId, rec.term.cols, rec.term.rows)
  return true
}

function createTerminal(rec: Record, host: HTMLElement): void {
  const term = new Terminal({
    fontFamily: rec.fontFamily,
    fontSize: rec.fontSize,
    lineHeight: 1.35,
    // Nerd Font 的字形需要合适的字重，否则图标会发虚
    fontWeight: '400',
    fontWeightBold: '600',
    letterSpacing: 0,
    cursorBlink: true,
    theme: {
      background: '#0f1115',
      foreground: '#e4e7ec',
      cursor: '#4c8dff',
      selectionBackground: '#2a3a52',
    },
    scrollback: 8000,
    macOptionIsMeta: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  rec.term = term
  rec.fit = fit
  // open() 要求宿主可见：调用点总在详情页挂载时，那时终端是展开的
  term.open(host)

  // 先让 xterm 完成一次渲染测量再启动 PTY：
  // open() 同步返回时渲染服务尚未就绪，立刻 fit 会抛 dimensions 错误。
  setTimeout(() => start(rec), 30)
}

// ------------------------------------------------------------------ 会话

function start(rec: Record): void {
  const bridge = window.easyFlow?.terminal
  const term = rec.term
  if (!bridge || !term) return

  bridge
    .create(rec.target, { cols: term.cols, rows: term.rows })
    .then((id) => {
      rec.ptyId = id
      rec.offData = bridge.onData(id, (data) => term.write(data))
      rec.offExit = bridge.onExit(id, (code) => {
        rec.exitCode = code
        setState(rec, 'exited')
      })
      term.onData((data) => bridge.input(id, data))
      fitAndSync(rec)
      setState(rec, 'ready')
    })
    .catch((err) => {
      term.writeln(`\r\n\x1b[31m终端启动失败：${(err as Error).message}\x1b[0m`)
      setState(rec, 'exited')
    })
}

function restart(rec: Record): void {
  if (!rec.term) return
  const bridge = window.easyFlow?.terminal
  if (rec.ptyId && bridge) bridge.destroy(rec.ptyId)
  rec.offData?.()
  rec.offExit?.()
  rec.ptyId = null
  rec.exitCode = null
  rec.term.reset()
  setState(rec, 'connecting')
  start(rec)
}

function setFont(rec: Record, fontFamily: string, fontSize: number): void {
  rec.fontFamily = fontFamily
  rec.fontSize = fontSize
  const term = rec.term
  if (!term) return
  if (term.options.fontFamily === fontFamily && term.options.fontSize === fontSize) return
  term.options.fontFamily = fontFamily
  term.options.fontSize = fontSize
  // 字号变了每行能放的字数也变了，重新量并把新尺寸同步给 PTY
  fitAndSync(rec)
}

function setState(rec: Record, state: TermState): void {
  rec.state = state
  for (const fn of rec.listeners) fn()
}
