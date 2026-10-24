/**
 * Codex 桌面应用的 app-server 客户端：起一个 codex 子进程，用 stdio 上的 JSON-RPC 说话。
 *
 * 为什么非走这条路：桌面应用打不开「空」thread——只有发过消息的会话它才认。所以 review
 * 会话必须建完立刻发一轮，而这一轮跑在 app-server 进程里，进程一退这一轮就断，所以调用方
 * 得等它跑完（或把命令放到后台跑，进程活着就不会断）。
 *
 * 两条容易踩的规矩：
 *   - 一条需求一个 project（`easy-flow:<reqId>`，review 与开发会话共用同一个），project id 不存库
 *   - thread/start 不继承 project 的 roots，必须显式传 runtimeWorkspaceRoots，否则多仓库落空
 */
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * 报给 app-server 的 clientInfo 版本。不能从 package.json 读：这个模块在 Electron 主进程里
 * 会被打成 out/main/chunks 下的独立 chunk，`import.meta.url` 随之改变、相对路径解析不到仓库根的
 * package.json（源码跑（tsx）能读到，构建产物读不到——只在打包后才炸）。由 Electron 主进程
 * 用 app.getVersion() 注入；CLI 场景拿不到就用占位值，这个字段只作标识、不影响协议。
 */
const VERSION = process.env.EASY_FLOW_VERSION ?? '0.0.0'

// 建 project / thread 这类单次调用的等待上限
const CALL_TIMEOUT_MS = 60_000
// 一轮 review 的等待上限。这一轮是同步跑完的，给短了会误杀
const TURN_TIMEOUT_MS = 15 * 60_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Waiter {
  method: string
  match: (params: Record<string, unknown>) => boolean
  resolve: (params: Record<string, unknown>) => void
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
  private readonly waiters = new Set<Waiter>()
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
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] })
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
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.reject(err)
    }
    this.waiters.clear()
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
    if (id != null && this.pending.has(id)) {
      const p = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(String(pick<string>(msg, ['error', 'message']))))
      else p.resolve(msg.result)
      return
    }
    const method = msg.method as string | undefined
    if (!method) return
    const params = (msg.params ?? {}) as Params
    for (const w of [...this.waiters]) {
      if (w.method !== method || !w.match(params)) continue
      this.waiters.delete(w)
      clearTimeout(w.timer)
      w.resolve(params)
    }
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

  // 等一条通知；用于等某一轮结束
  waitFor(
    method: string,
    match: (params: Params) => boolean,
    timeout = TURN_TIMEOUT_MS,
  ): Promise<Params> {
    if (this.dead) return Promise.reject(this.dead)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        method,
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`等 ${method} 超时（${Math.round(timeout / 1000)}s）`))
        }, timeout),
      }
      this.waiters.add(waiter)
    })
  }

  close(): void {
    this.die(new Error('app-server 已关闭'))
    this.child.kill()
  }
}

/**
 * 需求级 project：review 与开发会话共用（键 `easy-flow:<reqId>`）。
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

/**
 * project 下最新的一条 thread；没有则 null。用来认领人手动发出去的那条。
 * 开发会话与 review 同处一个 project，认领时要跳过已登记为开发会话的 thread，否则会认错。
 */
export async function latestThread(
  server: AppServer,
  projectId: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  // 取值是 snake_case——协议文档里写的 camelCase 会被拒
  const listed = await server.call('thread/list', { projectId, limit: 20, sortKey: 'recency_at' })
  const data = pick<unknown[]>(listed, ['data'])
  for (const thread of data) {
    const id = pick<string>(thread, ['id'])
    if (!exclude.has(id)) return id
  }
  return null
}

// 建一个 thread：cwd 定主工作区，runtimeWorkspaceRoots 把全部工作区带上
export async function startReviewThread(
  server: AppServer,
  projectId: string,
  cwd: string,
  roots: string[],
): Promise<string> {
  const started = await server.call('thread/start', {
    projectId,
    cwd,
    runtimeWorkspaceRoots: roots,
  })
  return pick<string>(started, ['thread', 'id'])
}

/**
 * 载入一条已存在的 thread。turn/start 只认载入过的会话，直接发会得到 thread not found；
 * 顺带把工作区刷成当前这一组，需求后来加了仓库也跟得上。
 */
export async function resumeThread(
  server: AppServer,
  threadId: string,
  cwd: string,
  roots: string[],
): Promise<void> {
  await server.call('thread/resume', { threadId, cwd, runtimeWorkspaceRoots: roots })
}

// 发一轮并等它跑完。跑完才返回，是为了让调用方在进程活着的时候把它跑完
export async function sendPrompt(server: AppServer, threadId: string, prompt: string): Promise<void> {
  const done = server.waitFor('turn/completed', (params) => params.threadId === threadId)
  // turn/start 自己失败时这条等待要收掉：留着它，close() 时会变成未处理的拒绝把进程打崩
  done.catch(() => {})
  await server.call('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt }],
  })
  const params = await done
  const status = pick<string>(params, ['turn', 'status'])
  if (status !== 'completed') {
    const message = (params.turn as Params | undefined)?.error
    throw new Error(`这一轮没跑完（${status}）${message ? `：${JSON.stringify(message)}` : ''}`)
  }
}
