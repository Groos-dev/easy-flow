import type { AppServer } from './codex.ts'
import { registerLaunchProvider, type LaunchInput, type LaunchProvider } from './launch.ts'

/** 一条需求一个 project：与 review 会话共用同一个键，靠会话的 role 区分 */
export function codexProjectKey(input: LaunchInput): string {
  return `easy-flow:${input.requirementId}`
}

/** project 的 roots：该需求名下全部可用工作区，开发会话因此在整条需求范围内都能读写 */
export function codexProjectRoots(input: LaunchInput): string[] {
  return input.requirementWorktreePaths
}

export function codexLaunchUrl(projectId: string, prompt: string): string {
  return `codex://threads/new?projectId=${encodeURIComponent(projectId)}&prompt=${encodeURIComponent(prompt)}`
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
      return codexLaunchUrl(projectId, prompt)
    } finally {
      server.close()
    }
  },
}

registerLaunchProvider(codexProvider)
