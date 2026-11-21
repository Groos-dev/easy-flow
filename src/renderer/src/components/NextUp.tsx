import { NextUpLevel } from '../../../shared/domain.ts'
import { useLanguage } from '../lib/language'
import { requirementStatusLabel } from '../../../shared/i18n.ts'
import { t as tr } from "../../../shared/i18n.ts"
import { useEffect, useRef, useState } from 'react'
import { AGENT_LABELS, NEXT_UP_LEVEL_LABEL, STATUS_CLASS } from '../lib/labels'
import {
  isComposing,
  isEditableTarget,
  isInteractiveTarget,
  shortcut,
  shortcutLabel,
} from '../lib/keys'
import type { NextUpItem } from '../lib/types'
import { AgentIcon } from './icons'

interface Props {
  items: NextUpItem[]
  // 计算失败时给出原话——空列表分不清「没事」和「没算出来」，两者要分开说
  error?: string
  // 没有会话可跳时，点开需求
  onOpenRequirement: (project: string, slug: string) => void
}

/**
 * 「下一步该动哪个」的一块列表。名次与理由都由服务端算好（见 server/next-up.ts），
 * 这里只负责把两级摆开、给每条一句理由，并把「回到会话 / 打开需求」接到手上。
 */
export default function NextUp({ items, error, onOpenRequirement }: Props) {
  useLanguage()
  // -1 表示未选；第一次按键落到第一条
  const [cursor, setCursor] = useState(-1)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const idx = items.length ? Math.min(cursor, items.length - 1) : -1
  const active = idx >= 0 ? items[idx] : undefined

  function activate(item: NextUpItem) {
    if (item.session?.link) window.open(item.session.link, '_blank')
    else onOpenRequirement(item.project, item.slug)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e) || isEditableTarget(e.target)) return
      // 焦点在按钮上时 Enter 交给按钮，避免点两次
      if (isInteractiveTarget(e.target)) return
      if (!items.length) return
      if (shortcut(e, 'next.next')) {
        e.preventDefault()
        setCursor((c) => Math.min(c < 0 ? 0 : c + 1, items.length - 1))
        return
      }
      if (shortcut(e, 'next.prev')) {
        e.preventDefault()
        setCursor((c) => (c < 0 ? 0 : Math.max(c - 1, 0)))
        return
      }
      if (shortcut(e, 'next.primary') && active) {
        e.preventDefault()
        activate(active)
        return
      }
      if (shortcut(e, 'next.open') && active) {
        e.preventDefault()
        onOpenRequirement(active.project, active.slug)
        return
      }
      if (shortcut(e, 'next.clear') && cursor >= 0) {
        e.preventDefault()
        setCursor(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, active, cursor, onOpenRequirement])

  // 轮询每秒换一次 items，只按 slug 判断要不要滚，免得列表自己抖
  const activeSlug = active?.slug ?? ''
  useEffect(() => {
    if (!activeSlug) return
    rowRefs.current.get(activeSlug)?.scrollIntoView({ block: 'nearest' })
  }, [activeSlug])

  if (!items.length) {
    return (
      <div className={`next-empty${error ? ' bad' : ''}`}>
        {error
          ? tr("Could not calculate next steps: {0}", [error])
          : tr("No requirements need attention right now. No agents are blocked or awaiting review, and no requirement has been idle long enough to need a reminder.")}
      </div>
    )
  }

  // 名次沿用服务端给的顺序，跨两级连续编号
  const ranked = items.map((item, i) => ({ item, rank: i + 1 }))
  const groups = (['now', 'soon'] as const)
    .map((level) => ({ level, rows: ranked.filter((x) => x.item.level === level) }))
    .filter((g) => g.rows.length)

  return (
    <div className="next">
      {/* 有列表也不能把失败吞了：照旧渲染上一次的名次，但顶上要说清这是旧的 */}
      {error && <div className="next-error">{tr("Could not refresh next steps. Showing the previous ranking:")}{error}</div>}
      {groups.map((g) => (
        <div className="next-group" key={g.level}>
          <div className="next-group-head">{NEXT_UP_LEVEL_LABEL[g.level] ?? g.level}</div>
          {g.rows.map(({ item, rank }) => (
            <div
              key={item.slug}
              ref={(el) => {
                if (el) rowRefs.current.set(item.slug, el)
                else rowRefs.current.delete(item.slug)
              }}
              className={`next-row ${item.level}${active?.slug === item.slug ? ' focused' : ''}`}
              onMouseEnter={() => setCursor(rank - 1)}
            >
              <span className="next-rank">{rank}</span>
              {item.session ? (
                <span className="next-agent" title={AGENT_LABELS[item.session.agent] ?? item.session.agent}>
                  <AgentIcon agent={item.session.agent} />
                </span>
              ) : (
                <span className={`next-dot ${STATUS_CLASS[item.status] ?? ''}`.trim()} />
              )}
              <div className="next-body">
                <div className="next-why">
                  {item.reason}
                  <span className="next-chip">
                    <span className={`next-dot ${STATUS_CLASS[item.status] ?? ''}`.trim()} />
                    {requirementStatusLabel(item.status)}
                  </span>
                </div>
                <div className="next-title">{item.title}</div>
                {item.detail && (
                  <div className={`next-detail${item.level === NextUpLevel.Now ? ' hot' : ''}`}>{item.detail}</div>
                )}
              </div>
              <div className="next-action">
                {/* 有会话级链接才回会话；终端 claude / cursor 没有链接，就退回打开需求 */}
                <button
                  className="btn-go"
                  title={tr("{0} ({1}; {2} to open the requirement)", [item.session?.link ? tr("Return to session") : tr("Open requirement"), shortcutLabel('next.primary'), shortcutLabel('next.open')])}
                  onClick={() => activate(item)}
                >
                  {item.session?.link ? tr("Return to session") : tr("Open requirement")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
