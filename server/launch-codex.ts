import type { AppServer } from './codex.ts'
import { registerLaunchProvider, type LaunchInput, type LaunchProvider } from './launch.ts'

/** project 的 roots：该需求名下全部可用工作区。review 会话按它拿多仓库；开发会话 app 侧认不出这个 project，靠 deeplink 的 path 定位 */
export function codexProjectRoots(input: LaunchInput): string[] {
  return input.requirementWorktreePaths
}

export function codexLaunchUrl(projectId: string, prompt: string, worktreePath = ''): string {
  // 没有工作区时不带 projectId：project 收不到 roots，app 解析不出工作区也就不会选它，建了只是多个空 project
  const project = projectId ? `projectId=${encodeURIComponent(projectId)}&` : ''
  // path 才是决定会话落在哪个 app 项目上的参数：app 只在它自己的项目表里查 projectId（我们建的都在 app-server 里，
  // 它查不到），查不到就拿这个目录去找/建项目。没有它，会话会落到 app 当前选中的那个项目上
  const path = worktreePath ? `path=${encodeURIComponent(worktreePath)}&` : ''
  return `codex://threads/new?${project}${path}prompt=${encodeURIComponent(prompt)}`
}

export function codexAppServerStartError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('找不到 codex 命令') || message.includes('ENOENT')) {
    return new Error('Codex command not found. Install Codex or add it to PATH.')
  }
  return new Error(`Codex app-server failed to start: ${message}`)
}

export const codexProvider: LaunchProvider = {
  id: 'codex',
  label: 'Codex',
  async build(input, prompt) {
    // 需求还没有工作区：直接开新会话草稿，不建 project（也就不用起 app-server）
    if (!input.requirementWorktreePaths.length) return codexLaunchUrl('', prompt, input.worktreePath)
    // 新会话页发消息前 thread 尚不存在，登记留给提示词在新会话里执行，不能先写占位行。
    // 动态载入 app-server 客户端：它顶层按自身文件位置读 package.json，静态 import 会把这段
    // 打进 Electron 主进程 bundle，使启动阶段就去 require 一个构建产物里不存在的路径。
    let server: AppServer
    let ensureRequirementProject: typeof import('./codex.ts').ensureRequirementProject
    try {
      const codex = await import('./codex.ts')
      const { AppServer } = codex
      ensureRequirementProject = codex.ensureRequirementProject
      server = await AppServer.start()
    } catch (error) {
      throw codexAppServerStartError(error)
    }

    try {
      const projectId = await ensureRequirementProject(
        server,
        input.requirementId,
        input.requirementId,
        codexProjectRoots(input),
      )
      return codexLaunchUrl(projectId, prompt, input.worktreePath)
    } finally {
      server.close()
    }
  },
}

registerLaunchProvider(codexProvider)
