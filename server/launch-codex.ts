import type { AppServer } from './codex.ts'
import { registerLaunchProvider, type LaunchInput, type LaunchProvider } from './launch.ts'

export function codexDevelopmentProjectKey(input: LaunchInput): string {
  return `easy-flow:${input.requirementId}:${input.worktreeId}`
}

export function codexDevelopmentProjectRoots(input: LaunchInput): string[] {
  return [input.worktreePath]
}

export function codexLaunchUrl(projectId: string, prompt: string): string {
  return `codex://threads/new?projectId=${encodeURIComponent(projectId)}&prompt=${encodeURIComponent(prompt)}`
}

export function codexAppServerStartError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('找不到 codex 命令') || message.includes('ENOENT')) {
    return new Error('Codex command not found. Install Codex or add it to PATH.')
  }
  return new Error('Codex app-server failed to start. Check that Codex is installed and available on PATH.')
}

// 带 projectId 的新会话从 project roots 选择工作目录；path 参数不能覆盖该选择。开发 project 单独建键，
// 且 roots 只放当前 worktree，避免刷新 roots 时改掉 review project 的多工作区集合。
async function ensureDevelopmentProject(server: AppServer, input: LaunchInput): Promise<string> {
  const roots = codexDevelopmentProjectRoots(input).map((path) => ({ path }))
  const created = await server.call('project/create', {
    idempotencyKey: codexDevelopmentProjectKey(input),
    name: input.worktreeId,
    roots,
  })
  const projectId = (created as { project?: { id?: string } })?.project?.id
  if (!projectId) throw new Error('Codex app-server did not return a project ID.')

  await server.call('project/update', { projectId, roots })
  return projectId
}

export const codexProvider: LaunchProvider = {
  id: 'codex',
  label: 'Codex',
  async build(input, prompt) {
    // 新会话页发消息前 thread 尚不存在，登记留给提示词在新会话里执行，不能先写占位行。
    // 动态载入 app-server 客户端：它顶层按自身文件位置读 package.json，静态 import 会把这段
    // 打进 Electron 主进程 bundle，使启动阶段就去 require 一个构建产物里不存在的路径。
    let server: AppServer
    try {
      const { AppServer } = await import('./codex.ts')
      server = await AppServer.start()
    } catch (error) {
      throw codexAppServerStartError(error)
    }

    try {
      const projectId = await ensureDevelopmentProject(server, input)
      return codexLaunchUrl(projectId, prompt)
    } finally {
      server.close()
    }
  },
}

registerLaunchProvider(codexProvider)
