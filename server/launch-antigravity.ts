import { AgentId } from '../src/shared/domain.ts'
import { workspaceOpenArgs } from '../src/shared/agents.ts'
/**
 * Antigravity（Agent Manager）启动：它没有能预填提示词的 deeplink，所以先把提示词放进剪贴板
 * （launch.ts 的 copyPromptBeforeOpen），再聚焦应用。用户选择包含目标工作区的项目后，
 * 在 Agent Manager 新建对话粘贴；提示词明确包含工作区，不能声称打开 app 已选中了目录。
 */
import { execFile } from 'node:child_process'
import { registerLaunchProvider, type LaunchInput, type LaunchProvider } from './launch.ts'

export function antigravityOpenArgs(path: string): string[] {
  return workspaceOpenArgs(AgentId.Antigravity, path)
}

function openWorkspace(input: LaunchInput): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', antigravityOpenArgs(input.worktreePath), (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve()
    })
  })
}

export const antigravityProvider: LaunchProvider = {
  id: AgentId.Antigravity,
  label: 'Antigravity',
  // Keep the target workspace explicit even though the App selects projects manually.
  requiresWorktree: true,
  copyPromptBeforeOpen: true,
  copyPromptOnFailure: true,
  // 没有 URL 可给：回执里留空，失败兜底不提供「再试一次 deeplink」
  build: () => '',
  open: openWorkspace,
}

registerLaunchProvider(antigravityProvider)
