import { AGENT_LABELS, NEXT_UP_LEVEL_LABEL, STATUS_CLASS } from '../lib/labels'
import type { NextUpItem } from '../lib/types'
import { AgentIcon } from './icons'

interface Props {
  items: NextUpItem[]
  /** 计算失败时给出原话——空列表分不清「没事」和「没算出来」，两者要分开说 */
  error?: string
  /** 没有会话可跳时，点开需求 */
  onOpenRequirement: (project: string, slug: string) => void
}

/**
 * 「下一步该动哪个」的一块列表。名次与理由都由服务端算好（见 server/next-up.ts），
 * 这里只负责把两级摆开、给每条一句理由，并把「回到会话 / 打开需求」接到手上。
 */
export default function NextUp({ items, error, onOpenRequirement }: Props) {
  if (!items.length) {
    return (
      <div className={`next-empty${error ? ' bad' : ''}`}>
        {error
          ? `没能算出「下一步」：${error}`
          : '眼下没有要你推的需求。没有 agent 卡住或跑完没看，Review 与澄清也都还没停到该催的天数。'}
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
      {groups.map((g) => (
        <div className="next-group" key={g.level}>
          <div className="next-group-head">{NEXT_UP_LEVEL_LABEL[g.level] ?? g.level}</div>
          {g.rows.map(({ item, rank }) => (
            <div key={item.slug} className={`next-row ${item.level}`}>
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
                    {item.status}
                  </span>
                </div>
                <div className="next-title">{item.title}</div>
                {item.detail && (
                  <div className={`next-detail${item.level === 'now' ? ' hot' : ''}`}>{item.detail}</div>
                )}
              </div>
              <div className="next-action">
                {/* 有会话级链接才回会话；终端 claude / cursor 没有链接，就退回打开需求 */}
                <button
                  className="btn-go"
                  onClick={() =>
                    item.session?.link
                      ? window.open(item.session.link, '_blank')
                      : onOpenRequirement(item.project, item.slug)
                  }
                >
                  {item.session?.link ? '回到会话' : '打开需求'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
