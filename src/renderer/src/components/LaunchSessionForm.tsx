import { useState, type FormEvent } from 'react'
import { CopyButton } from './InfoBits'
import { AgentIcon } from './icons'
import { launchNeedsWorktree, launchResultFeedback, launchWorktreeSelection, worktreeCreationCommand } from '../lib/launch'
import type { LaunchAgent, LaunchProviderInfo, LaunchResult, Worktree } from '../lib/types'

/**
 * 新会话表单：只有「用哪个 agent」是必答项，工作区在真有得选的时候才问。
 * 结果态反过来——打开成功只说一句，提示词与手动登记命令留给「没打开成」那条路。
 */
export default function LaunchSessionForm({
  requirementId,
  worktrees,
  providers,
  worktreeId,
  agent,
  loading,
  providerError,
  requestError,
  busy,
  result,
  onWorktreeChange,
  onAgentChange,
  onLaunch,
}: {
  requirementId: string
  worktrees: Worktree[]
  providers: LaunchProviderInfo[]
  worktreeId: string
  agent: LaunchAgent | ''
  loading: boolean
  providerError: string
  requestError: string
  busy: boolean
  result: LaunchResult | null
  onWorktreeChange: (id: string) => void
  onAgentChange: (id: LaunchAgent) => void
  onLaunch: () => void
}) {
  /** 提示词平时折着：它只在「deeplink 没把提示词带过去」时才需要人看 */
  const [promptOpen, setPromptOpen] = useState(false)

  const { available } = launchWorktreeSelection(worktrees, worktreeId)
  const needsWorktree = launchNeedsWorktree(available)
  const canLaunch = !!agent && (!needsWorktree || !!worktreeId) && !busy
  const picked = providers.find((p) => p.id === agent)
  const feedback = result ? launchResultFeedback(requirementId, result) : null
  const agentName = picked?.label ?? result?.agent ?? 'Agent'

  function submit(event: FormEvent) {
    event.preventDefault()
    if (canLaunch) onLaunch()
  }

  if (loading) return <p className="launch-hint">正在读取可用 Agent…</p>
  if (providerError) {
    return (
      <p className="launch-result bad" role="alert">
        读取 Agent 失败：{providerError}
      </p>
    )
  }
  if (!providers.length) {
    return <p className="launch-hint">当前没有可用的 Agent 启动方式；已有会话仍可从上面的列表回到原会话。</p>
  }

  return (
    <div className="launch-form">
      <form onSubmit={submit}>
        <div className="agent-chips">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`agent-chip${p.id === agent ? ' on' : ''}`}
              data-info-row=""
              aria-pressed={p.id === agent}
              onClick={() => onAgentChange(p.id)}
            >
              <AgentIcon agent={p.id} />
              {p.label}
            </button>
          ))}
        </div>

        {available.length === 1 && (
          <div className="wt-line">
            <span className="wt-label">目录</span>
            <span className="repo line mono">{available[0].repo}</span>
            <span className="branch line">· {available[0].branch}</span>
          </div>
        )}

        {available.length > 1 && (
          <div className="wt-pick" role="radiogroup" aria-label="在哪个工作区开始">
            <div className="wt-prompt">在哪个工作区开始</div>
            {available.map((w) => (
              <div
                key={w.id}
                className={`wt-option${w.id === worktreeId ? ' on' : ''}`}
                data-info-row=""
                role="radio"
                aria-checked={w.id === worktreeId}
                tabIndex={0}
                onClick={() => onWorktreeChange(w.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onWorktreeChange(w.id)
                }}
              >
                <span className="wt-radio" />
                <span className="repo line mono">{w.repo}</span>
                <span className="branch line">· {w.branch}</span>
              </div>
            ))}
          </div>
        )}

        <button
          className="launch-go"
          type="submit"
          data-info-row={canLaunch ? '' : undefined}
          disabled={!canLaunch}
        >
          {busy ? '正在打开…' : `用 ${agentName} 打开新会话`}
        </button>

        {/* 正常不说「会发生什么」，按钮上写着；只有还没工作区时得给一条能往下走的路 */}
        {!needsWorktree && <code className="launch-hint">{worktreeCreationCommand(requirementId)}</code>}
      </form>

      {requestError && (
        <p className="launch-result bad" role="alert">
          <span className="mark">!</span>
          启动请求失败：{requestError}
        </p>
      )}

      {/* 打开成功不说话：agent 应用已经弹出来了，那就是回执。
          只有没打开成时才铺兜底——原因、重试、提示词、手动登记都在这儿 */}
      {feedback && !feedback.opened && (
        <>
          <p className="launch-result bad" role="alert">
            <span className="mark">!</span>
            没能自动打开 {agentName}：{feedback.error || '未知错误'}
          </p>
          <div className="launch-actions">
            <button
              className="launch-retry"
              type="button"
              data-info-row={canLaunch ? '' : undefined}
              onClick={onLaunch}
              disabled={!canLaunch}
            >
              重试打开
            </button>
            <CopyButton text={feedback.prompt} label="提示词" showLabel />
          </div>
          <p className="launch-hint">手动兜底：在 {agentName} 里新建会话、把提示词贴过去；或自己跑一次登记。</p>
          <code className="launch-manual">{feedback.manualCommand}</code>
          {/* 能复制也得能看：剪贴板失败时眼里得有东西可抄 */}
          <div className="launch-fold">
            <button
              type="button"
              data-info-row=""
              onClick={() => setPromptOpen((v) => !v)}
            >
              {promptOpen ? '▾' : '▸'} 看提示词原文
            </button>
          </div>
          {promptOpen && <pre className="launch-prompt">{feedback.prompt}</pre>}
        </>
      )}
    </div>
  )
}
