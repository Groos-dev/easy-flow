import { useEffect, useRef, useState } from 'react'

interface SelectOption {
  value: string
  label: string
  /** 选项前显示优先级色点 */
  dot?: boolean
}

/**
 * 详情页头部的下拉选择（优先级 / 状态）。
 * 只显示当前值，点击弹出菜单切换。
 * 用自绘而非原生 select：原生控件在暗色主题下样式不可控。
 */
export default function SelectMenu({
  value,
  options,
  placeholder,
  disabled,
  hint,
  onChange,
}: {
  value: string
  options: SelectOption[]
  placeholder: string
  disabled?: boolean
  hint?: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 点击外部或 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className="select-menu" ref={boxRef}>
      <button
        className="select-trigger"
        disabled={disabled}
        title={hint}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.dot && <span className={`prio ${value}`} />}
        <span className={current ? '' : 'select-placeholder'}>{current?.label ?? placeholder}</span>
        <svg
          className="select-caret"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="select-list" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              className={`select-item${o.value === value ? ' active' : ''}`}
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                setOpen(false)
                if (o.value !== value) onChange(o.value)
              }}
            >
              {o.dot && <span className={`prio ${o.value}`} />}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
