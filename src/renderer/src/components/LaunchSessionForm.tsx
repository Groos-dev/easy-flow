import type { FormEvent } from 'react'
import { CopyButton } from './InfoBits'
import SelectMenu from './SelectMenu'
import { launchNeedsWorktree, launchResultFeedback, launchWorktreeSelection, worktreeCreationCommand } from '../lib/launch'
import type { LaunchAgent, LaunchProviderInfo, LaunchResult, Worktree } from '../lib/types'

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
  const { available } = launchWorktreeSelection(worktrees, worktreeId)
  const missing = worktrees.filter((w) => w.missing)
  const feedback = result ? launchResultFeedback(requirementId, result) : null
  // deeplink 只能带一个工作目录（Claude 当 folder、Codex 当 path）：有工作区就必须选一个
  const needsWorktree = launchNeedsWorktree(available)
  const canLaunch = !!agent && (!needsWorktree || !!worktreeId) && !busy

  function submit(event: FormEvent) {
    event.preventDefault()
    if (canLaunch) onLaunch()
  }

  return (
    <div className="launch-session-form">
      <form onSubmit={submit}>
        {available.length === 0 && (
          <p className="launch-help">
            这条需求还没有工作区：新会话先按需求取上下文，改代码前自己开工作区——
            <code>{worktreeCreationCommand(requirementId)}</code>
          </p>
        )}
        {loading ? (
          <p className="launch-help">正在读取可用 Agent…</p>
        ) : providerError ? (
          <p className="launch-error" role="alert">读取 Agent 失败：{providerError}</p>
        ) : providers.length === 0 ? (
          <p className="launch-help">当前没有可用的 Agent 启动方式；已有会话仍可从本页会话列表回到原会话。</p>
        ) : (
          <>
            <div className="launch-select-row">
              <span>Agent</span>
              <SelectMenu
                value={agent}
                placeholder="选择 Agent"
                options={providers.map((p) => ({ value: p.id, label: p.label }))}
                onChange={(value) => onAgentChange(value as LaunchAgent)}
              />
            </div>
            {needsWorktree && (
              <div className="launch-select-row">
                <span>工作区</span>
                <SelectMenu
                  value={worktreeId}
                  placeholder="选择工作区"
                  disabled={available.length === 1}
                  options={available.map((w) => ({ value: w.id, label: `${w.repo} · ${w.branch}` }))}
                  onChange={onWorktreeChange}
                />
              </div>
            )}
            {missing.length > 0 && (
              <p className="launch-help">不可用工作区（目录已失联）：{missing.map((w) => `${w.repo} · ${w.branch}`).join('、')}</p>
            )}
            <button className="btn primary launch-submit" type="submit" disabled={!canLaunch}>
              {busy ? '正在打开…' : '打开新会话草稿'}
            </button>
          </>
        )}
      </form>

      {requestError && <p className="launch-error" role="alert">启动请求失败：{requestError}</p>}

      {feedback && (
        <div className={feedback.role === 'status' ? 'launch-result' : 'launch-error'} role={feedback.role}>
          <p>{feedback.title}</p>
          <p>{feedback.detail}</p>
          {!feedback.opened && feedback.url && (
            <a className="launch-retry" href={feedback.url} target="_blank" rel="noreferrer">
              手动重试打开会话草稿
            </a>
          )}
          {feedback.prompt && (
            <div className="launch-prompt">
              <pre>{feedback.prompt}</pre>
              <CopyButton text={feedback.prompt} label="提示词" />
            </div>
          )}
          <p className="launch-help">如需手动登记，请在所选工作区的新会话中执行：</p>
          <code>{feedback.manualCommand}</code>
        </div>
      )}
    </div>
  )
}
