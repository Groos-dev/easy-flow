import { isAbsolute } from 'node:path'
import { registerLaunchProvider, type LaunchProvider } from './launch.ts'

/**
 * 官方链接将 q 预填到新会话 composer、将 folder 作为工作目录；发送仍由用户确认。
 * 每个 folder 都要用户确认，当前只有第一个生效；q 约 14000 字符后会被截断。
 */
export function claudeLaunchUrl(prompt: string, folder: string): string {
  if (!folder || !isAbsolute(folder)) {
    throw new Error('Claude Code folder must be an absolute path')
  }

  return `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`
}

export const claudeProvider: LaunchProvider = {
  id: 'claude',
  label: 'Claude Code',
  build: (input, prompt) => claudeLaunchUrl(prompt, input.worktreePath),
}

registerLaunchProvider(claudeProvider)
