/**
 * Cursor 启动：先打开目标工作区，再发带 workspace 的 prompt deeplink。
 * deeplink 只按工作区名路由；没有同名窗口会退回当前窗口。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { registerLaunchProvider, type LaunchProvider } from './launch.ts'

export function cursorWorkspaceName(path: string): string {
  return basename(path)
}

// Cursor 的 workspace key：绝对路径里非字母数字全部换成 -，合并连续 -，去掉首尾 -
export function cursorWorkspaceKey(path: string): string {
  let real = path
  try {
    real = realpathSync(path)
  } catch {
    // 目录不存在时保留原路径；调用方已经确认过 worktree 存在
  }
  return real
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function cursorLaunchUrl(prompt: string, workspace: string): string {
  return `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}&workspace=${encodeURIComponent(workspace)}`
}

function openApp(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Cursor', path], (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve()
    })
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface CursorLaunchOptions {
  cursorHome?: string
  timeoutMs?: number
  // 项目目录可能因为历史打开而过早存在，至少等窗口真正出来
  settleMs?: number
  // Cursor 没在跑时冷启动更慢，固定多等一会儿，别被历史项目目录骗了
  coldStartMs?: number
}

function cursorRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', 'Cursor'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export async function openCursorWorkspace(
  path: string,
  {
    cursorHome = join(homedir(), '.cursor'),
    timeoutMs = 15_000,
    settleMs = 2_000,
    coldStartMs = 12_000,
  }: CursorLaunchOptions = {},
): Promise<void> {
  const warm = cursorRunning()
  await openApp(path)
  const ready = join(cursorHome, 'projects', cursorWorkspaceKey(path))
  const started = Date.now()
  await sleep(warm ? settleMs : Math.max(settleMs, coldStartMs))
  while (Date.now() - started < timeoutMs) {
    if (existsSync(ready)) return
    await sleep(300)
  }
  throw new Error(`Cursor did not open workspace ${path} in time; open it once and retry`)
}

function assertUniqueWorkspace(input: { worktreePath: string; requirementWorktreePaths: string[] }): void {
  const workspace = cursorWorkspaceName(input.worktreePath)
  const sameName = new Set(
    input.requirementWorktreePaths.filter((path) => cursorWorkspaceName(path) === workspace),
  )
  if (sameName.size > 1) {
    throw new Error(`Cursor cannot tell apart worktrees named ${workspace}; open it manually`)
  }
}

export const cursorProvider: LaunchProvider = {
  id: 'cursor',
  label: 'Cursor',
  requiresWorktree: true,
  prepare: (input) => {
    assertUniqueWorkspace(input)
    return openCursorWorkspace(input.worktreePath)
  },
  build: (input, prompt) => {
    assertUniqueWorkspace(input)
    return cursorLaunchUrl(prompt, cursorWorkspaceName(input.worktreePath))
  },
}

registerLaunchProvider(cursorProvider)
