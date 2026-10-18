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

/**
 * 结果态要摆什么。文案不在这里拼——「在哪个 agent 里打开」只有组件知道（agent 显示名在 labels.ts），
 * 这里只回答「到底打开没有、失败原因是什么、兜底要给什么」。
 */
export interface LaunchFeedback {
  /** 真把 deeplink 交给系统打开了才算成功；没打开时不留「已打开」的假象 */
  opened: boolean
  /** 失败原因；成功时是空串 */
  error: string
  /** 没打开成时手动重试用的 deeplink；连它都没建出来时是空串 */
  url: string
  prompt: string
  manualCommand: string
}

export function launchResultFeedback(requirementId: string, result: LaunchResult): LaunchFeedback {
  return {
    opened: result.opened,
    error: result.error ?? '',
    url: result.url,
    prompt: result.prompt,
    manualCommand: `easy-flow req session add ${requirementId} --agent ${result.agent} --title "<一句话说明在做什么>"`,
  }
}
