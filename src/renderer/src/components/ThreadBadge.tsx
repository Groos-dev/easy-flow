import { AGENT_LABELS, THREAD_STATE_CLASS, THREAD_STATE_LABEL } from '../lib/labels'
import { isEventState } from '../lib/threads'
import type { Session } from '../lib/types'
import { AgentIcon } from './icons'

/**
 * 会话状态角标：agent 图标 + 状态点，点一下跳回会话。
 *
 * 只留图标不留 agent 名——一条需求可能挂着好几个会话，名字会把卡片撑开、把状态那句挤掉；
 * 认哪个 agent 靠 mark，认什么状态靠点的颜色，悬停有整句原文。mini 面板一行只放得下
 * 一个徽标，用的也是这套形态。
 *
 * 「有事件」的徽标另加一圈状态色边框：角标本身只说明「值得看」，正在跑也算，
 * 而边框把真正需要人消费的（卡住 / 跑完没看 / 失败）挑出来。
 *
 * 卡片本身是可拖拽的，所以这里把 pointerdown 也拦掉——从角标上按下不该变成拖卡片，
 * 那正是最容易误触的地方。没有 deeplink 的会话（终端 claude、cursor）不可点，
 * 只显示状态：跳不过去就明说，别给一个点了没反应的按钮。
 */
export default function ThreadBadge({ session }: { session: Session }) {
  const { state, needsAction, detail } = session.status
  const agent = AGENT_LABELS[session.agent] ?? session.agent
  // 「有事件」= 没消费过的 done / blocked / failed。正在跑也挂角标，但它不是事件——
  // 自己会结束，不需要人消费，所以不给那圈边框
  const event = isEventState(state) && session.status.fresh

  // 悬停先答「这条会话在做什么」（agent 登记时自己写的标题），再给状态与原文
  const tip = [
    session.title || session.session,
    `${agent} · ${THREAD_STATE_LABEL[state] ?? state}`,
    needsAction ? `需要你回答：${needsAction}` : detail,
    session.link ? '点一下回到这个会话' : `没有会话级链接，会话 id：${session.session}`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = (
    <>
      <span className={`thread-dot ${THREAD_STATE_CLASS[state] ?? ''}`} />
      <AgentIcon agent={session.agent} />
    </>
  )
  // 状态类留在徽标上：event 那圈边框要按状态取色（卡住橙、失败红、跑完绿）
  const cls = `thread-badge${event ? ' event' : ''} ${THREAD_STATE_CLASS[state] ?? ''}`.trim()

  if (!session.link) {
    return (
      <span className={`${cls} off`} title={tip}>
        {body}
      </span>
    )
  }
  return (
    <button
      className={cls}
      title={tip}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        window.open(session.link, '_blank')
      }}
    >
      {body}
    </button>
  )
}
