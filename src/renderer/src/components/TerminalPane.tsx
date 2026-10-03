import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { acquireTerminal, type TerminalTarget } from '../lib/terminals'

interface Props {
  target: TerminalTarget
  /** CSS font-family 值，来自设置页 */
  fontFamily: string
  fontSize: number
}

/**
 * 内嵌终端。agent（claude / codex）直接在里面跑，
 * 交互、补全、TUI 都由 CLI 自己处理，这里只做透传。
 *
 * 会话本身不归这个组件管——它在 lib/terminals 里按 (project, slug) 缓存，
 * 所以这个组件卸载（换页、收起）只是把 xterm 的 DOM 搬走，PTY 照跑。
 */
export default function TerminalPane({ target, fontFamily, fontSize }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const session = useMemo(
    () => acquireTerminal(target, fontFamily, fontSize),
    [target.project, target.slug, fontFamily, fontSize],
  )
  const state = useSyncExternalStore(session.subscribe, () => session.state)
  const exitCode = useSyncExternalStore(session.subscribe, () => session.exitCode)

  // 字体变化就地生效，不重建终端（否则会丢掉会话内容）
  useEffect(() => {
    session.setFont(fontFamily, fontSize)
  }, [session, fontFamily, fontSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return session.attach(host)
  }, [session])

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
          <button className="btn" onClick={() => session.restart()}>
            重启
          </button>
        )}
      </div>
      {state !== 'unavailable' && <div className="terminal-host" ref={hostRef} />}
    </div>
  )
}
