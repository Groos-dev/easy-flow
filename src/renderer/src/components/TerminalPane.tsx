import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

/** 终端挂载点：需求（带 slug）或项目（开在项目根目录） */
export interface TerminalTarget {
  project: string
  slug?: string
}

interface Props {
  target: TerminalTarget
  /** CSS font-family 值，来自设置页 */
  fontFamily: string
  fontSize: number
  /** 终端退出后允许重启 */
  onExit?: (code: number) => void
}

/**
 * 内嵌终端。agent（claude / codex）直接在里面跑，
 * 交互、补全、TUI 都由 CLI 自己处理，这里只做透传。
 */
export default function TerminalPane({ target, fontFamily, fontSize, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [state, setState] = useState<'connecting' | 'ready' | 'exited' | 'unavailable'>(
    'connecting',
  )
  const [exitCode, setExitCode] = useState<number | null>(null)
  const restartRef = useRef<() => void>(() => {})

  // 初值只取一次：字体后续变化由上面的 effect 就地生效，
  // 不应触发终端重建（重建会杀掉 PTY 会话）。
  const initialFontRef = useRef({ fontFamily, fontSize })

  // 字体变化就地生效，不重启 PTY（否则会丢掉会话内容）
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
  }, [fontFamily, fontSize])

  useEffect(() => {
    const bridge = window.easyFlow?.terminal
    if (!bridge) {
      setState('unavailable')
      return
    }

    let disposed = false
    let ptyId: string | null = null
    let offData: (() => void) | null = null
    let offExit: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null

    const term = new Terminal({
      fontFamily: initialFontRef.current.fontFamily,
      fontSize: initialFontRef.current.fontSize,
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
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())

    if (!hostRef.current) return
    term.open(hostRef.current)

    const doFit = () => {
      try {
        fit.fit()
      } catch {
        // open() 之后渲染服务尚未测量完时 fit 会抛错，稍后 ResizeObserver 会再试
      }
    }

    async function start() {
      try {
        const id = await bridge!.create(target, { cols: term.cols, rows: term.rows })
        if (disposed) {
          bridge!.destroy(id)
          return
        }
        ptyId = id
        offData = bridge!.onData(id, (data) => term.write(data))
        offExit = bridge!.onExit(id, (code) => {
          setExitCode(code)
          setState('exited')
          onExit?.(code)
        })
        term.onData((data) => bridge!.input(id, data))
        doFit()
        bridge!.resize(id, term.cols, term.rows)
        setState('ready')
        term.focus()
      } catch (err) {
        if (!disposed) {
          term.writeln(`\r\n\x1b[31m终端启动失败：${(err as Error).message}\x1b[0m`)
          setState('exited')
        }
      }
    }

    restartRef.current = () => {
      setExitCode(null)
      setState('connecting')
      term.reset()
      void start()
    }

    // 先让 xterm 完成一次渲染测量，再启动 PTY：
    // open() 同步返回时渲染服务尚未就绪，立刻 fit 会抛 dimensions 错误。
    const bootTimer = setTimeout(() => void start(), 30)

    // 面板尺寸变化 → 同步给 PTY，否则 CLI 的换行会错位
    resizeObserver = new ResizeObserver(() => {
      doFit()
      if (ptyId) bridge.resize(ptyId, term.cols, term.rows)
    })
    resizeObserver.observe(hostRef.current)

    return () => {
      disposed = true
      clearTimeout(bootTimer)
      resizeObserver?.disconnect()
      offData?.()
      offExit?.()
      if (ptyId) bridge.destroy(ptyId)
      term.dispose()
      termRef.current = null
    }
  }, [target.project, target.slug, onExit])

  return (
    <div className="terminal-pane">
      <div className="terminal-bar">
        <span className={`dot ${state}`} />
        <span className="terminal-title">
          {state === 'connecting' && '终端启动中…'}
          {state === 'ready' &&
            `终端 · ${target.slug ? `${target.project}/${target.slug}` : target.project}`}
          {state === 'exited' && `终端已退出${exitCode !== null ? `（${exitCode}）` : ''}`}
          {state === 'unavailable' && '终端仅在桌面应用内可用'}
        </span>
        <span className="spacer" />
        {state === 'exited' && (
          <button className="btn" onClick={() => restartRef.current()}>
            重启
          </button>
        )}
      </div>
      {state === 'unavailable' ? (
        <div className="terminal-fallback">
          <p>浏览器模式下无法创建终端（需要 Electron 的原生 PTY）。</p>
          <p>
            请用桌面应用打开，或在终端里手动进入需求目录：
            <code>
              cd ~/requirements/{target.project}
              {target.slug ? `/${target.slug}` : ''}
            </code>{' '}
            然后运行 <code>claude</code>。
          </p>
        </div>
      ) : (
        <div className="terminal-host" ref={hostRef} />
      )}
    </div>
  )
}
