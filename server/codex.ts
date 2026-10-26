/**
 * Codex 桌面应用的 app-server 客户端：起一个 codex 子进程，用 stdio 上的 JSON-RPC 说话。
 *
 * 只做一件事：按需求建/复用 project，好让 deeplink 起来的开发会话落在这个需求上。
 * project id 不存库——键是 `easy-flow:<reqId>`，幂等由 app-server 保证。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 报给 app-server 的 clientInfo 版本。不能从 package.json 读：这个模块在 Electron 主进程里
 * 会被打成 out/main/chunks 下的独立 chunk，`import.meta.url` 随之改变、相对路径解析不到仓库根的
 * package.json（源码跑（tsx）能读到，构建产物读不到——只在打包后才炸）。由 Electron 主进程
 * 用 app.getVersion() 注入；CLI 场景拿不到就用占位值，这个字段只作标识、不影响协议。
 */
const VERSION = process.env.EASY_FLOW_VERSION ?? '0.0.0'
const run = promisify(execFile)

// 每次现读：SHELL 是进程环境给的，测试也会换掉它
function loginShell(): string {
  return process.env.SHELL ?? '/bin/zsh'
}

// 从启动台打开的进程 PATH 里没有终端才有的目录，codex 的绝对路径要问登录 shell
async function codexBinary(): Promise<string> {
  try {
    const found = (await run(loginShell(), ['-lc', 'command -v codex'])).stdout.trim().split('\n').pop()?.trim()
    if (!found) throw new Error('empty')
    return found
  } catch (err) {
    throw new Error('找不到 codex 命令：装好 Codex，或让它在 PATH 里再重跑', { cause: err })
  }
}

// 单次调用的等待上限
const CALL_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Params = Record<string, unknown>

// 从 JSON-RPC 结果里取字段；形状不对时给出能看懂的错误，而不是 undefined 满天飞
function pick<T>(value: unknown, path: string[]): T {
  let cur: unknown = value
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') throw new Error(`app-server 返回里没有 ${path.join('.')}`)
    cur = (cur as Params)[key]
  }
  if (cur == null) throw new Error(`app-server 返回里没有 ${path.join('.')}`)
  return cur as T
}

export class AppServer {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private nextId = 1
  private dead: Error | null = null

  private constructor(child: ChildProcess) {
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.feed(chunk))
    child.on('exit', (code) => this.die(new Error(`codex app-server 提前退出（退出码 ${code}）`)))
    child.on('error', (err) => this.die(err))
  }

  static async start(): Promise<AppServer> {
    // 光有绝对路径不够：codex 是 `#!/usr/bin/env node` 脚本，从启动台打开的进程 PATH 里没有 node。
    // 经登录 shell exec 出去，PATH 才和终端里一致；exec 不换 pid，退出就是 codex 退出。
    const child = spawn(
      loginShell(),
      ['-lc', 'exec "$0" "$@"', await codexBinary(), 'app-server', '--listen', 'stdio://'],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    const server = new AppServer(child)
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', (err: NodeJS.ErrnoException) => {
          reject(
            err.code === 'ENOENT'
              ? new Error('找不到 codex 命令：装好 Codex，或让它在 PATH 里再重跑')
              : err,
          )
        })
      })
      await server.call('initialize', {
        clientInfo: { name: 'easy-flow', version: VERSION },
        // project/create 带实验标记：协议 schema 默认把它滤掉，不声明这个能力请求会被拒
        capabilities: { experimentalApi: true },
      })
      server.notify('initialized', {})
    } catch (err) {
      // 起来了又没谈成（版本不合、配置报错）：别把子进程留在那儿
      server.close()
      throw err
    }
    return server
  }

  // 子进程没了：所有在等的调用一起失败，别让调用方挂到超时
  private die(err: Error): void {
    if (this.dead) return
    this.dead = err
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private feed(chunk: string): void {
    this.buffer += chunk
    let at: number
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (!line.startsWith('{')) continue
      let msg: Params
      try {
        msg = JSON.parse(line) as Params
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: Params): void {
    const id = msg.id as number | undefined
    if (id == null || !this.pending.has(id)) return
    const p = this.pending.get(id)!
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(String(pick<string>(msg, ['error', 'message']))))
    else p.resolve(msg.result)
  }

  call(method: string, params: Params, timeout = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex app-server 没在 ${Math.round(timeout / 1000)}s 内回应 ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method: string, params: Params): void {
    if (this.dead) return
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  close(): void {
    this.die(new Error('app-server 已关闭'))
    this.child.kill()
  }
}

/**
 * 需求级 project（键 `easy-flow:<reqId>`）。
 * 幂等键命中就复用，不再刷 roots——roots 只在首次创建时按当时的工作区定下，每次刷会覆盖掉
 * 人在 Codex 里对 project 的调整，而开发会话本来只需要「复用同一个 project」。
 */
export async function ensureRequirementProject(
  server: AppServer,
  requirementId: string,
  name: string,
  roots: string[],
): Promise<string> {
  const created = await server.call('project/create', {
    idempotencyKey: `easy-flow:${requirementId}`,
    name,
    roots: roots.map((path) => ({ path })),
  })
  return pick<string>(created, ['project', 'id'])
}

