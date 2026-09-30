/**
 * 终端管理：在 Electron 主进程里为每个「需求」开一个 PTY。
 *
 * 为什么用真终端而不是自研 agent 交互：
 *   claude / codex 等 CLI 的交互（补全、确认、TUI）都依赖 PTY，
 *   直接嵌终端就不必自己实现一套 agent 协议。
 *
 * 安全边界：终端的工作目录是需求目录，但终端本身可以访问整个文件系统——
 * 这是终端的固有性质。只在本机运行，不对外暴露。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'

// node-pty 是原生模块，必须运行时从 node_modules 加载，不能被打包
const require = createRequire(import.meta.url)

/**
 * 终端挂载点：需求（带 slug）或项目（不带 slug，工作目录为项目根）。
 * 项目终端用来和 agent 讨论项目级约定/规范。
 */
export interface TerminalTarget {
  project: string
  slug?: string
}

interface Session {
  id: string
  target: TerminalTarget
  pty: IPty
}

type Publish = (channel: string, payload: unknown) => void

export class TerminalManager {
  private sessions = new Map<string, Session>()
  private resolveCwd: (target: TerminalTarget) => string | null

  constructor(resolveCwd: (target: TerminalTarget) => string | null) {
    this.resolveCwd = resolveCwd
  }

  create(target: TerminalTarget, publish: Publish, opts: { cols?: number; rows?: number } = {}): string {
    const cwd = this.resolveCwd(target)
    if (!cwd) {
      throw new Error(
        target.slug ? `需求目录不存在: ${target.project}/${target.slug}` : `项目目录不存在: ${target.project}`,
      )
    }

    const pty = require('node-pty') as typeof import('node-pty')
    const id = randomUUID()
    const shell = process.env.SHELL ?? '/bin/zsh'

    const child = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        // 让终端里的 CLI 知道自己在 easy-flow 里
        EASY_FLOW_SESSION: '1',
        EASY_FLOW_PROJECT: target.project,
        ...(target.slug ? { EASY_FLOW_REQUIREMENT: target.slug } : {}),
      } as Record<string, string>,
    })

    this.sessions.set(id, { id, target, pty: child })

    child.onData((data) => publish(`terminal:data:${id}`, data))
    child.onExit(({ exitCode }) => {
      publish(`terminal:exit:${id}`, exitCode)
      this.sessions.delete(id)
    })

    return id
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    try {
      s.pty.resize(cols, rows)
    } catch {
      /* 尺寸极端值可能被拒，忽略 */
    }
  }

  destroy(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    try {
      s.pty.kill()
    } catch {
      /* 已退出 */
    }
    this.sessions.delete(id)
  }

  destroyAll(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id)
  }

  get count(): number {
    return this.sessions.size
  }

  /** 便于设置页展示：当前终端都开在哪些挂载点上 */
  openTargets(): string[] {
    return [
      ...new Set(
        [...this.sessions.values()].map((s) =>
          s.target.slug ? `${s.target.project}/${s.target.slug}` : `${s.target.project}/`,
        ),
      ),
    ]
  }
}
