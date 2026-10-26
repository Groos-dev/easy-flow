import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CopyButton } from './InfoBits'
import { AgentIcon } from './icons'
import { isComposing, isEditableTarget, shortcut } from '../lib/keys'
import {
  launchNeedsWorktree,
  launchResultFeedback,
  launchRows,
  launchWorktreeSelection,
  stepLaunchRow,
  worktreeCreationCommand,
} from '../lib/launch'
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
  // 提示词平时折着：它只在「deeplink 没把提示词带过去」时才需要人看
  const [promptOpen, setPromptOpen] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  // agent 整排放焦点，h/l 在其中换选中项
  const chipsRef = useRef<HTMLDivElement>(null)

  const { available } = launchWorktreeSelection(worktrees, worktreeId)
  const picked = providers.find((p) => p.id === agent)
  const needsWorktree = launchNeedsWorktree(available, picked?.requiresWorktree)
  const canLaunch = !!agent && (!needsWorktree || !!worktreeId) && !busy
  const feedback = result ? launchResultFeedback(requirementId, result) : null
  const agentName = picked?.label ?? result?.agent ?? 'Agent'

  function stepAgent(dir: 1 | -1) {
    if (providers.length < 2) return
    const at = providers.findIndex((p) => p.id === agent)
    const index = at < 0 ? 0 : (at + dir + providers.length) % providers.length
    onAgentChange(providers[index].id)
    chipsRef.current?.focus()
  }

  function stepRow(dir: 1 | -1) {
    const root = formRef.current
    if (!root) return
    const rows = launchRows(available, canLaunch)
    const elements = [
      chipsRef.current,
      ...(available.length > 1 ? Array.from(root.querySelectorAll<HTMLElement>('.wt-option')) : []),
      ...(canLaunch ? [root.querySelector<HTMLElement>('.launch-go')] : []),
    ].filter((el): el is HTMLElement => !!el)
    const at = elements.indexOf(document.activeElement as HTMLElement)
    const next = stepLaunchRow(rows, at, dir, worktreeId)
    const target = elements[next]
    if (!target) return
    if (rows[next].kind === 'worktree') onWorktreeChange(rows[next].id)
    target.focus()
    target.scrollIntoView({ block: 'nearest' })
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (isComposing(e) || isEditableTarget(e.target)) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const inAgents = !!chipsRef.current && chipsRef.current.contains(e.target as Node)
    if (inAgents && (shortcut(e, 'launch.agent-prev') || shortcut(e, 'launch.agent-next'))) {
      e.preventDefault()
      e.stopPropagation()
      stepAgent(shortcut(e, 'launch.agent-prev') ? -1 : 1)
      return
    }
    if (shortcut(e, 'launch.row-prev') || shortcut(e, 'launch.row-next')) {
      // 表单里的上下键归这里，浮窗那套线性 j/k 不再挪一次
      e.preventDefault()
      e.stopPropagation()
      stepRow(shortcut(e, 'launch.row-prev') ? -1 : 1)
    }
  }

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
      <form ref={formRef} onSubmit={submit} onKeyDown={onKeyDown}>
        <div
          className="agent-chips"
          ref={chipsRef}
          role="radiogroup"
          aria-label="用哪个 Agent 开始"
          data-info-row=""
          tabIndex={0}
        >
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`agent-chip${p.id === agent ? ' on' : ''}`}
              role="radio"
              aria-checked={p.id === agent}
              aria-label={p.label}
              title={p.label}
              tabIndex={-1}
              onClick={() => {
                onAgentChange(p.id)
                chipsRef.current?.focus()
              }}
            >
              <AgentIcon agent={p.id} size={14} />
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
        {picked?.requiresWorktree && !available.length && (
          <>
            <p className="launch-hint">{picked?.label ?? '该 Agent'} 需要先有一个工作区：</p>
            <code className="launch-hint">{worktreeCreationCommand(requirementId)}</code>
          </>
        )}
      </form>

      {requestError && (
        <p className="launch-result bad" role="alert">
          <span className="mark">!</span>
          启动请求失败：{requestError}
        </p>
      )}

      {feedback?.opened && result?.agent === 'cursor' && (
        <p className="launch-hint">已在 Cursor 打开工作区；在弹窗里点 Create Chat，提示词已填好。</p>
      )}

      {/* 打开成功不说话：agent 应用已经弹出来了，那就是回执。
          只有没打开成时才铺兜底——原因、重试、提示词、手动登记都在这儿 */}
      {feedback && !feedback.opened && (
        <>
          <p className="launch-result bad" role="alert">
            <span className="mark">!</span>
            没能自动打开 {agentName}：{feedback.error || '未知错误'}
          </p>
          {feedback.promptCopied && <p className="launch-hint">提示词已复制到剪贴板，到新会话里粘贴即可。</p>}
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
