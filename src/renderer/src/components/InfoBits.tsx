import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from './icons'

/**
 * 详情页头部浮窗的零件。需求（InfoPanel）与待办（TodoPanel）共用同一套：
 * 折叠块、一行截断的文本、复制按钮——两边的浮窗要长得一样，零件就不各写一份。
 */

/**
 * 浮窗里的一段：标题行点一下收起/展开，右边跟一个计数。
 * 默认展开——浮窗的作用就是一眼看到东西，收起是内容多了之后的减法。
 */
export function InfoBlock({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="info-block">
      <button
        className="info-block-head"
        data-info-row=""
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="info-block-label">{label}</span>
        {count !== undefined && <span className="info-count">· {count}</span>}
        <svg
          className={`info-caret${open ? ' open' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {open && <div className="info-block-body">{children}</div>}
    </section>
  )
}

/**
 * 长文本一律占一行：放不下就截断成省略号，完整内容挂在 title 上，
 * 悬停时由系统提示给出（原生行为，够用且不额外占地方）。
 * 传了 href 就当外链渲染（新窗口打开），传了 onClick 就是可点的一行。
 */
export function OneLine(props: {
  text: string
  className: string
  title?: string
  href?: string
  disabled?: boolean
  onClick?: () => void
}) {
  const cls = `line ${props.className}${props.disabled ? ' disabled' : ''}`

  if (props.href) {
    return (
      <a className={cls} href={props.href} target="_blank" rel="noreferrer" title={props.title}>
        {props.text}
      </a>
    )
  }

  const clickable = !!props.onClick && !props.disabled
  return (
    <div
      className={cls}
      title={props.title}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? props.onClick : undefined}
      onKeyDown={(e) => {
        if (clickable && e.key === 'Enter') props.onClick?.()
      }}
    >
      {props.text}
    </div>
  )
}

/** 复制按钮：图标按钮，复制成功后短暂变勾。失败就什么也不说，别谎报"已复制"。
 *  showLabel 是给兜底路径用的——那里只有「复制提示词」这一个动作，光一个图标认不出来 */
export function CopyButton({ text, label, showLabel = false }: { text: string; label: string; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 浮窗随时会被关掉，定时器要跟着一起清，别对已卸载的组件 setState
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <button
      className={`info-action${showLabel ? ' with-label' : ''}`}
      data-info-row=""
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            // 连点两下时后一次要重新计时，否则第一下的定时器会提前把勾收掉
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1200)
          })
          .catch(() => {})
      }}
      title={`复制${label}`}
      aria-label={`复制${label}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {showLabel && label}
    </button>
  )
}
