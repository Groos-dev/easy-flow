import type { LaunchResult, Worktree } from './types'

/**
 * deeplink 只带一个工作目录（Claude 的 folder、Codex 的 path、Cursor 的 workspace），
 * 有可用工作区时必须选一个。
 * provider 强制要求时，没有工作区也不能起。
 */
export function launchNeedsWorktree(available: Worktree[], requiresWorktree = false): boolean {
  return requiresWorktree || available.length > 0
}

// 只有可用 worktree 才能启动；唯一项直选，多项留空要求用户明确选择。
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

export type LaunchRow = { kind: 'agent' } | { kind: 'worktree'; id: string } | { kind: 'launch' }

/**
 * 新建会话表单里上下走的那一列：agent 整排占一行，工作区一档一行，启动按钮殿后。
 * 唯一工作区只是说明文字，不参与；禁用的启动按钮也不占位。
 */
export function launchRows(available: Worktree[], canLaunch: boolean): LaunchRow[] {
  const rows: LaunchRow[] = [{ kind: 'agent' }]
  if (available.length > 1) {
    for (const w of available) rows.push({ kind: 'worktree', id: w.id })
  }
  if (canLaunch) rows.push({ kind: 'launch' })
  return rows
}

/**
 * 上下移一行。从 agent 块往下落在当前选中的工作区，没选就落第一行；两端停住。
 */
export function stepLaunchRow(rows: LaunchRow[], at: number, dir: 1 | -1, worktreeId: string): number {
  if (at < 0) return 0
  if (dir < 0) return Math.max(at - 1, 0)
  if (at === 0) {
    const picked = rows.findIndex((row) => row.kind === 'worktree' && row.id === worktreeId)
    return picked > 0 ? picked : Math.min(1, rows.length - 1)
  }
  return Math.min(at + 1, rows.length - 1)
}

/**
 * 结果态要摆什么。文案不在这里拼——「在哪个 agent 里打开」只有组件知道（agent 显示名在 labels.ts），
 * 这里只回答「到底打开没有、失败原因是什么、兜底要给什么」。
 */
export interface LaunchFeedback {
  // 真把 deeplink 交给系统打开了才算成功；没打开时不留「已打开」的假象
  opened: boolean
  // 失败原因；成功时是空串
  error: string
  // 没打开成时手动重试用的 deeplink；连它都没建出来时是空串
  url: string
  prompt: string
  // 提示词已由服务端放进剪贴板（启动失败时的降级）
  promptCopied: boolean
  manualCommand: string
}

export function launchResultFeedback(requirementId: string, result: LaunchResult): LaunchFeedback {
  return {
    opened: result.opened,
    error: result.error ?? '',
    url: result.url,
    prompt: result.prompt,
    promptCopied: !!result.promptCopied,
    manualCommand: `easy-flow req session add ${requirementId} --agent ${result.agent} --title "<一句话说明在做什么>"`,
  }
}
