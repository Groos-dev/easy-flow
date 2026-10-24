import { useEffect, useRef, useState } from 'react'

// 窗口里的两个看板：需求与待办是平级的，只是看的东西不同
export type BoardView = 'req' | 'todo'

const BOARDS: Array<{ value: BoardView; label: string; hint: string }> = [
  { value: 'req', label: '需求', hint: '按项目组织的需求看板' },
  { value: 'todo', label: 'Todo', hint: '跨项目的全局待办' },
]

/**
 * 看板切换：左上角显示当前看板，点开列出两个平级看板。
 * 自绘而非原生 select，理由同 SelectMenu——原生控件在暗色主题下样式不可控。
 */
export default function BoardSwitcher({
  value,
  onChange,
}: {
  value: BoardView
  onChange: (v: BoardView) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

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

  const current = BOARDS.find((b) => b.value === value) ?? BOARDS[0]

  return (
    <div className="board-switch" ref={boxRef}>
      <button
        className="board-switch-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="切换看板"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="board-switch-label">{current.label}</span>
        <svg
          width="11"
          height="11"
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
        <div className="board-switch-list" role="listbox">
          {BOARDS.map((b) => (
            <button
              key={b.value}
              className={`board-switch-item${b.value === value ? ' active' : ''}`}
              role="option"
              aria-selected={b.value === value}
              onClick={() => {
                setOpen(false)
                if (b.value !== value) onChange(b.value)
              }}
            >
              <span className="board-switch-text">
                <span className="board-switch-title">{b.label}</span>
                <span className="board-switch-hint">{b.hint}</span>
              </span>
              {b.value === value && (
                <svg
                  className="board-switch-check"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
