import type { LaunchResult, Worktree } from './types'

/** deeplink 只带一个工作目录（Claude 的 folder、Codex 的 path），有可用工作区时必须选一个；一个都没有时不带目录也能起 */
export function launchNeedsWorktree(available: Worktree[]): boolean {
  return available.length > 0
}

/** 只有可用 worktree 才能启动；唯一项直选，多项留空要求用户明确选择。 */
export function launchWorktreeSelection(worktrees: Worktree[], selectedId = ''): {
  available: Worktree[]
  selectedId: string
} {
  const available = worktrees.filter((w) => !w.missing)
  return {
    available,
    selectedId: available.some((w) => w.id === selectedId)
      ? selectedId
      : available.length === 1 ? available[0].id : '',
  }
}

export function worktreeCreationCommand(requirementId: string): string {
  return `easy-flow wt new ${requirementId} --repo <仓库> --branch feature-<需求 slug>`
}

export function launchResultFeedback(requirementId: string, result: LaunchResult) {
  return {
    role: result.opened ? 'status' as const : 'alert' as const,
    opened: result.opened,
    url: result.url,
    title: result.opened
      ? '已打开待发送的新会话草稿；尚未登记会话。'
      : `启动失败：${result.error || '未知错误'}`,
    detail: result.opened
      ? '发送首条消息后，新会话会用当前会话 ID 自行登记到需求。'
      : '尚未创建会话记录。请复制提示词，在对应 Agent 的新会话中手动发送。',
    prompt: result.prompt,
    manualCommand: `easy-flow req session add ${requirementId} --agent ${result.agent} --title "<一句话说明在做什么>"`,
  }
}
