import type { FormEvent } from 'react'
import { CopyButton } from './InfoBits'
import SelectMenu from './SelectMenu'
import { launchResultFeedback, launchWorktreeSelection, worktreeCreationCommand } from '../lib/launch'
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
  const orphaned = worktrees.filter((w) => w.orphan)
  const feedback = result ? launchResultFeedback(requirementId, result) : null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (worktreeId && agent && !busy) onLaunch()
  }

  return (
    <div className="launch-session-form">
      {available.length === 0 ? (
        <div className="launch-empty">
          <p>这条需求还没有可用工作区。先为此需求创建工作区，再回来启动会话。</p>
          {orphaned.length > 0 && (
            <p>已登记但目录失联：{orphaned.map((w) => `${w.repo} · ${w.branch}`).join('、')}</p>
          )}
          <code>{worktreeCreationCommand(requirementId)}</code>
        </div>
      ) : (
        <form onSubmit={submit}>
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
          {orphaned.length > 0 && (
            <p className="launch-help">不可用工作区（目录已失联）：{orphaned.map((w) => `${w.repo} · ${w.branch}`).join('、')}</p>
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
              <button className="btn primary launch-submit" type="submit" disabled={!worktreeId || !agent || busy}>
                {busy ? '正在打开…' : '打开新会话草稿'}
              </button>
            </>
          )}
        </form>
      )}

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
