import { isAbsolute } from 'node:path'
import { registerLaunchProvider, type LaunchProvider } from './launch.ts'

/**
 * 官方链接将 q 预填到新会话 composer、将 folder 作为工作目录；发送仍由用户确认。
 * 每个 folder 都要用户确认，当前只有第一个生效；q 约 14000 字符后会被截断。
 * folder 可以不传（官方标注为非必填，应用自己的「New Claude Code Session」就是这么开的）：
 * 需求还没有工作区时就这样开草稿，工作目录留给人现场选。
 */
export function claudeLaunchUrl(prompt: string, folder: string): string {
  const query = `q=${encodeURIComponent(prompt)}`
  if (!folder) return `claude://code/new?${query}`
  if (!isAbsolute(folder)) {
    throw new Error('Claude Code folder must be an absolute path')
  }

  return `claude://code/new?${query}&folder=${encodeURIComponent(folder)}`
}

export const claudeProvider: LaunchProvider = {
  id: 'claude',
  label: 'Claude Code',
  build: (input, prompt) => claudeLaunchUrl(prompt, input.worktreePath),
}

registerLaunchProvider(claudeProvider)
