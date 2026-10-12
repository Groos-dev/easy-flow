import { AGENT_LABELS, THREAD_STATE_CLASS, THREAD_STATE_LABEL } from '../lib/labels'
import type { Session } from '../lib/types'

/**
 * 会话状态角标：色点 + 「哪个 agent 在等你」+ 状态，点一下跳回会话。
 *
 * 卡片本身是可拖拽的，所以这里把 pointerdown 也拦掉——从角标上按下不该变成拖卡片，
 * 那正是最容易误触的地方。没有 deeplink 的会话（终端 claude、cursor）不可点，
 * 只显示状态：跳不过去就明说，别给一个点了没反应的按钮。
 */
export default function ThreadBadge({ session }: { session: Session }) {
  const { state, needsAction, detail } = session.status
  const agent = AGENT_LABELS[session.agent] ?? session.agent
  // 需要人介入时，角标自己就把「要我干什么」答了，不用再点进去看
  const tip = needsAction
    ? `${agent} 需要你介入：${needsAction}`
    : `${agent} ${THREAD_STATE_LABEL[state] ?? state}（${detail}）`

  const body = (
    <>
      <span className={`thread-dot ${THREAD_STATE_CLASS[state] ?? ''}`} />
      {agent} {THREAD_STATE_LABEL[state] ?? state}
    </>
  )

  if (!session.link) {
    return (
      <span className="thread-badge off" title={tip}>
        {body}
      </span>
    )
  }
  return (
    <button
      className="thread-badge"
      title={`${tip}；点一下回到会话`}
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
