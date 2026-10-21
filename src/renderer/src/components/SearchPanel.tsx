import { useEffect, useRef, useState } from 'react'
import { isComposing, shortcut } from '../lib/keys'
import { STATUS_CLASS } from '../lib/labels'
import type { Requirement } from '../lib/types'

interface Props {
  /** 当前筛选词。关掉面板后它还在——看板仍旧只留命中的卡片 */
  query: string
  onQuery: (q: string) => void
  /** 命中的需求，顺序由服务端给（按文件修改时间倒序） */
  results: Requirement[]
  /** 正在等服务端返回，用来区分「还没查」与「查了没有」 */
  pending: boolean
  /** clear 为 true 时打开后把筛选一起清掉（⌘↵） */
  onPick: (slug: string, clear?: boolean) => void
  onClose: () => void
}

/**
 * ⌘K 搜索面板。命中的需求同时喂给看板与导图（导图走 layoutTree 的 hits），
 * 所以这里只负责选，不负责把结果画成列表给看——看板本身就是那个列表。
 */
export default function SearchPanel({ query, onQuery, results, pending, onPick, onClose }: Props) {
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 换了词就回到第一条：光标停在一条已经不存在的记录上，回车会开到别处
  useEffect(() => {
    setCursor(0)
  }, [query])

  // 结果条数会随着输入变少，光标要跟着收回范围内，否则回车会开到别处
  const idx = results.length ? Math.min(cursor, results.length - 1) : -1
  const active = idx >= 0 ? results[idx] : undefined

  function onKeyDown(e: React.KeyboardEvent) {
    // 中文输入法选词时的 Enter / ↑↓ 归输入法，不当快捷键
    if (isComposing(e.nativeEvent)) return
    if (shortcut(e, 'search.next')) {
      e.preventDefault()
      setCursor(Math.min(idx + 1, results.length - 1))
    } else if (shortcut(e, 'search.prev')) {
      e.preventDefault()
      setCursor(Math.max(idx - 1, 0))
    } else if (shortcut(e, 'search.open-clear')) {
      e.preventDefault()
      if (active) onPick(active.slug, true)
    } else if (shortcut(e, 'search.open')) {
      e.preventDefault()
      if (active) onPick(active.slug)
    } else if (shortcut(e, 'search.close')) {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      {/* 面板里的点击不该冒到遮罩上（那等于关掉自己） */}
      <div className="palette" role="dialog" aria-label="搜索需求" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="搜需求：标题 / 目录名 / 摘要 / 文档内容"
          value={query}
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {!query.trim() ? (
            <div className="palette-hint">输入关键词。命中的需求会同时筛掉看板上别的卡片</div>
          ) : results.length === 0 ? (
            <div className="palette-hint">{pending ? '查找中…' : '没有命中的需求'}</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.slug}
                className={`palette-row${r === active ? ' on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(r.slug)}
              >
                <span className={`dot ${STATUS_CLASS[r.status] ?? ''}`} title={r.status} />
                <span className="palette-title">{r.title}</span>
                <span className="palette-slug">{r.slug}</span>
              </div>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>⌘↵ 打开并清筛选</span>
          <span>Esc 关掉面板，筛选留着</span>
        </div>
      </div>
    </div>
  )
}
