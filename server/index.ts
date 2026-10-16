/**
 * easy-flow HTTP 层。状态归 sqlite，内容归 markdown。
 * 三种使用方式：
 *   1. Electron 主进程 startBoardServer()  ← 打包运行
 *   2. `tsx server/dev.ts`                ← 浏览器开发（配合 vite proxy）
 *   3. 测试直接调 createBoardApp
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import {
  BoardDatabase,
  STATUSES,
  PRIORITIES,
  TODO_STATUSES,
  TODO_SOURCES,
  type Status,
  type Priority,
  type TodoStatus,
} from './db.ts'
import { hookKeyOf, PULL_INTERVAL_MS, pullStatuses, readObservations } from './threads.ts'
import { recordHook } from './hook.ts'
import { idleStatus, SessionStateStore } from './session-state.ts'
import type { SourceTable } from './source-file.ts'
import { rankNextUp } from './next-up.ts'
import './launch-claude.ts'
import { logLevel, createLogger } from './log.ts'
import { readConfig, writeConfig, defaultDataDir } from './config.ts'
import { installSkill, skillPlan } from './skill-install.ts'
import { hookPlan, installHooks, uninstallHooks } from './hook-install.ts'

const log = createLogger('easy-flow')
import { findLaunchProvider, launchPrompt, launchProviders } from './launch.ts'
import './launch-codex.ts'
import {
  allowOrigin,
  json,
  readBody,
  readRequirementDoc,
  writeRequirementDoc,
} from './http.ts'

export const DEFAULT_PORT = 3210

/** 单条记录变更不涉及目录扫描，但仍然回一个空 sync：列表与单条接口的对象形状保持一致 */
const NO_CHANGES = {
  added: [],
  updated: [],
  missing: [],
  restored: [],
  worktrees: { missing: [], restored: [] },
}

export interface BoardAppOptions {
  /** 数据目录；不传则读配置 */
  dataDir?: string
  /** 服务监听端口。设置页装 hook 时要把地址与端口写进配置，所以得知道真实端口 */
  port?: number
}

export interface BoardApp {
  db: BoardDatabase
  readonly dataDir: string
  store: SessionStateStore
  sources: SourceTable
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  close: () => void
}

/** 解析请求要操作的项目：显式参数优先，否则用当前项目 */
function resolveProject(db: BoardDatabase, raw: string | null): string {
  if (!raw) return db.project
  let slug: string
  try {
    slug = decodeURIComponent(raw)
  } catch {
    throw new Error(`Invalid project slug encoding: ${raw}`)
  }
  if (!db.hasProject(slug)) {
    throw new Error(`Project not found: ${slug}`)
  }
  return slug
}

/** 项目数据在 <dataDir>/<project>/，删除时要连目录一起删 */
function removeProjectData(db: BoardDatabase, slug: string): void {
  const project = db.listProjects().find((p) => p.slug === slug)
  if (project && existsSync(project.root)) {
    rmSync(project.root, { recursive: true, force: true })
  }
}

export function createBoardApp({ dataDir, port = DEFAULT_PORT }: BoardAppOptions = {}): BoardApp {
  const initial = readConfig()
  let currentDir = dataDir ?? initial.dataDir
  let db = new BoardDatabase(currentDir, initial.activeProject)
  db.syncProjects()
  db.pickProject()

  const sources: SourceTable = {
    source: (path) => db.source(path),
    listSources: () => db.listSources(),
    touchSource: (path, patch) => db.touchSource(path, patch),
  }

  const stateStore = new SessionStateStore({
    get: (agent, session) => db.getSessionObservation(agent, session),
    put: (agent, session, observation) => db.putSessionObservation(agent, session, observation),
    drop: (agent, session) => db.dropSessionObservation(agent, session),
    keyOf: (agent, session) => db.keyOf(agent, session),
    alias: (agent, session, key) => db.alias(agent, session, key),
  })

  // 首次运行时把生效的数据目录固化下来，否则配置一直缺失，
  // 每个进程都要重新猜默认值（独立跑 server 与 Electron 之间会不一致）。
  // 无条件写：内容幂等，且能顺带确保配置目录存在。
  if (!dataDir) {
    try {
      writeConfig({ dataDir: currentDir })
    } catch {
      /* 配置目录不可写时不影响主流程 */
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'OPTIONS') {
      const origin = allowOrigin(req)
      if (!origin) {
        res.writeHead(403)
        res.end()
        return
      }
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'vary': 'origin',
      })
      res.end()
      return
    }

    try {
      if (url.pathname === '/api/health') {
        json(req, res, 200, { ok: true, dataDir: currentDir, db: db.file })
        return
      }

      // agent 的 hook 往这儿推事件（Claude 原生 http hook / Codex 的转发脚本）。
      // 这是被人推的入口，不是给人看的接口：认不出的都吞掉，永远回 200，别呛回 agent。
      if (url.pathname === '/api/hook' && req.method === 'POST') {
        let payload: Record<string, unknown> = {}
        try {
          payload = await readBody(req)
        } catch {
          /* 报文不是合法 JSON：当没收到，照常回 200 */
        }
        // 两条管道共用一个入口，得认出来源：claude 的原生 http hook 带不了额外字段（缺省 claude），
        // codex 的转发脚本用 ?agent=codex 或报文里带 agent
        const fromQuery = url.searchParams.get('agent')
        const fromBody = typeof payload.agent === 'string' && payload.agent ? payload.agent : ''
        recordHook(payload, { agent: fromQuery || fromBody || 'claude' }, stateStore)
        json(req, res, 200, { ok: true })
        return
      }

      if (url.pathname === '/api/launch/providers' && req.method === 'GET') {
        json(req, res, 200, {
          providers: launchProviders().map(({ id, label }) => ({ id, label })),
        })
        return
      }

      if (url.pathname === '/api/requirements' && req.method === 'GET') {
        // 每次读取前同步一次：md 可能被 agent 改过
        const sync = db.syncProjects()
        json(req, res, 200, {
          requirements: db.list(),
          project: db.project,
          // 顶栏显示用。name 来自项目根 AGENTS.md 的 frontmatter，缺省是目录名
          projectName: db.listProjects().find((p) => p.slug === db.project)?.name ?? db.project,
          statuses: STATUSES,
          priorities: PRIORITIES,
          sync,
        })
        return
      }

      // ----------------------------------------------------------- 项目

      if (url.pathname === '/api/projects' && req.method === 'GET') {
        json(req, res, 200, { projects: db.listProjects(), active: db.project })
        return
      }

      // 侧边栏树：所有项目 + 各自的需求，一次拉全
      if (url.pathname === '/api/tree' && req.method === 'GET') {
        const sync = db.syncProjects()
        json(req, res, 200, { tree: db.tree(), active: db.project, sync })
        return
      }

      if (url.pathname === '/api/projects/active' && req.method === 'POST') {
        const { slug } = await readBody(req)
        db.setProject(String(slug))
        // 记住选择，重启后仍是这个项目
        writeConfig({ activeProject: db.project })
        json(req, res, 200, { active: db.project })
        return
      }

      if (url.pathname === '/api/projects/convention' && req.method === 'GET') {
        const project = resolveProject(db, url.searchParams.get('project'))
        const found = db.listProjects().find((p) => p.slug === project)
        json(req, res, 200, {
          project,
          content: found?.convention ?? null,
          path: found ? `${found.root}/AGENTS.md` : null,
        })
        return
      }

      // 项目总规范：文件固定为项目根目录的 AGENTS.md，内容格式不做限制
      if (url.pathname === '/api/projects/convention' && req.method === 'POST') {
        const { project, content } = await readBody(req)
        const slug = resolveProject(db, project ? String(project) : null)
        const result = db.writeProjectConvention(slug, String(content ?? ''))
        json(req, res, 200, { project: slug, ...result })
        return
      }

      if (url.pathname === '/api/projects/open' && req.method === 'POST') {
        const { slug } = await readBody(req)
        const found = db.listProjects().find((p) => p.slug === String(slug))
        if (!found) throw new Error(`Project not found: ${slug}`)
        execFile('open', [found.root], () => {})
        json(req, res, 200, { ok: true, root: found.root })
        return
      }

      if (url.pathname === '/api/projects/delete' && req.method === 'POST') {
        const { slug, removeFiles } = await readBody(req)
        const target = String(slug)
        if (target === db.project) throw new Error('Cannot delete the project currently in use')
        if (removeFiles) removeProjectData(db, target)
        db.deleteProject(target)
        json(req, res, 200, { ok: true, removedFiles: !!removeFiles, projects: db.listProjects() })
        return
      }

      if (url.pathname === '/api/move' && req.method === 'POST') {
        const body = await readBody(req)
        const project = resolveProject(db, body.project ? String(body.project) : null)
        json(
          req,
          res,
          200,
          db.setStatus(String(body.slug), String(body.status) as Status, project),
        )
        return
      }

      if (url.pathname === '/api/update' && req.method === 'POST') {
        const { slug, status, priority, title, project: projectRaw } = await readBody(req)
        const project = resolveProject(db, projectRaw ? String(projectRaw) : null)
        const id = String(slug)
        let result = db.get(id, project)
        if (!result) throw new Error(`Requirement not found: ${id}`)
        if (status !== undefined) result = db.setStatus(id, status as Status, project)
        if (priority !== undefined) result = db.setPriority(id, (priority as Priority) || '', project)
        if (title !== undefined) result = db.rename(id, String(title), project)
        json(req, res, 200, { ...result, sync: NO_CHANGES })
        return
      }

      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const hits = db.search(q)
        json(req, res, 200, {
          requirements: db.list().filter((r) => hits.has(r.slug)),
          query: q,
        })
        return
      }

      // Full context of one requirement (raw markdown included), for the detail page
      if (url.pathname === '/api/context' && req.method === 'GET') {
        const slug = url.searchParams.get('slug') ?? ''
        const project = resolveProject(db, url.searchParams.get('project'))
        const ctx = db.context(slug, project)
        if (!ctx) throw new Error(`Requirement not found: ${slug}`)
        json(req, res, 200, {
          ...ctx,
          requirementMd: db.readRequirementMd(slug, project),
          // 归属只存在库里，详情页要展示工作区就得从这儿带出去
          worktrees: db.listWorktrees(ctx.requirement.id),
          // 同理：会话只归库，详情页的「会话」块靠这一份；状态是读 agent 应用的落盘文件得来的
          sessions: readObservations(db.listSessions(ctx.requirement.id), stateStore),
          // 挂在这条需求上的待办（立项时由 todo 侧登记）。同样是只归库的关系
          todos: db.listTodos(ctx.requirement.id),
        })
        return
      }

      // 全部会话（归属在每条的 requirementId 上）：mini 面板一次拉全，
      // 逐需求拉 context 太碎；排序交给库（最近登记的在前）
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        json(req, res, 200, { sessions: readObservations(db.listSessions(), stateStore) })
        return
      }

      // 点一下 pet = 这条会话此刻「静止」。写进状态层、用与 hook 事件同一个 key，
      // 所以下一个事件一到就把它覆盖掉——不需要任何失效判据，也不落库
      if (url.pathname === '/api/sessions/clicked' && req.method === 'POST') {
        const body = await readBody(req)
        const agent = String(body.agent)
        const session = String(body.session)
        const key = hookKeyOf(agent, session)
        stateStore.put(agent, key, idleStatus())
        json(req, res, 200, { ok: true })
        return
      }

      // 「下一步该动哪个」：服务端揉好信号、给每条配一句理由，前端只负责展示与跳转。
      // 只看当前项目——看板是按项目隔离的。会话按归属过滤，别把别的项目的信号串进来
      if (url.pathname === '/api/next-up' && req.method === 'GET') {
        const requirements = db.list()
        const ids = new Set(requirements.map((r) => r.id))
        const sessions = readObservations(db.listSessions(), stateStore).filter((s) => ids.has(s.requirementId))
        json(req, res, 200, { items: rankNextUp(requirements, sessions) })
        return
      }

      // 按需求 id 取单条。待办详情页的「需求」那行只有 id，靠它换成可跳转的需求
      if (url.pathname === '/api/requirement' && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const target = db.byId(id)
        if (!target) throw new Error(`Requirement not found: ${id}`)
        json(req, res, 200, target)
        return
      }

      // 读需求目录下的某个文档（默认 requirement.md）。路径做了越界校验。
      if (url.pathname === '/api/doc' && req.method === 'GET') {
        const slug = url.searchParams.get('slug') ?? ''
        const name = url.searchParams.get('name') || 'requirement.md'
        const project = resolveProject(db, url.searchParams.get('project'))
        const target = db.get(slug, project)
        if (!target) throw new Error(`Requirement not found: ${slug}`)
        const content = readRequirementDoc(target.path, name)
        json(req, res, 200, { slug, project, name, content })
        return
      }

      // 保存文档。只允许写需求目录内的 md/文本。
      if (url.pathname === '/api/doc' && req.method === 'POST') {
        const { slug, name, content, project: projectRaw } = await readBody(req)
        const project = resolveProject(db, projectRaw ? String(projectRaw) : null)
        const target = db.get(String(slug), project)
        if (!target) throw new Error(`Requirement not found: ${slug}`)
        const result = writeRequirementDoc(target.path, String(name), String(content ?? ''))
        json(req, res, 200, { slug, project, name, ...result })
        return
      }

      if (url.pathname === '/api/open' && req.method === 'POST') {
        const { slug, project: projectRaw } = await readBody(req)
        const project = resolveProject(db, projectRaw ? String(projectRaw) : null)
        const target = db.get(String(slug), project)
        if (target) execFile('open', [target.path], () => {})
        json(req, res, 200, { ok: true })
        return
      }

      // URL 由已注册的 provider 组装；会话登记留给新会话首轮自己完成
      if (url.pathname === '/api/launch' && req.method === 'POST') {
        const { slug, project: projectRaw, worktreeId, agent: rawAgent } = await readBody(req)
        const project = resolveProject(db, projectRaw ? String(projectRaw) : null)
        const requirement = db.get(String(slug), project)
        if (!requirement) throw new Error(`Requirement not found: ${slug}`)
        // 能启动的 agent 就是注册表里有的：没注册的 agent 与拼错的 id 一样，都是不支持
        const provider = findLaunchProvider(String(rawAgent))
        if (!provider) throw new Error(`Unknown launch agent: ${rawAgent}`)
        const agent = provider.id
        const requirementWorktreePaths = db
          .listWorktrees(requirement.id)
          .filter((w) => !w.missing)
          .map((w) => w.path)
        // deeplink 只带一个工作目录（Claude 的 folder、Codex 的 path）：需求有工作区时必须指定一个；
        // 一个都没有时不带目录起（需求刚建出来、还没决定开哪个仓库）
        let wt: ReturnType<typeof db.worktreeById>
        if (worktreeId || requirementWorktreePaths.length) {
          if (!worktreeId) throw new Error('Launch needs a worktree: the deeplink carries a single folder')
          wt = db.worktreeById(String(worktreeId))
          if (!wt) throw new Error(`Worktree not found: ${worktreeId}`)
          if (wt.requirementId !== requirement.id) {
            throw new Error(`Worktree does not belong to requirement: ${worktreeId}`)
          }
          if (!existsSync(wt.path)) throw new Error(`Directory no longer exists: ${wt.path}`)
        }

        const input = {
          agent,
          requirementId: requirement.id,
          worktreeId: wt?.id ?? '',
          worktreePath: wt?.path ?? '',
          requirementWorktreePaths,
        }
        const prompt = launchPrompt(input)

        let targetUrl = ''
        try {
          targetUrl = await provider.build(input, prompt)
          await new Promise<void>((resolve, reject) => {
            execFile('open', [targetUrl], (error, _stdout, stderr) => {
              if (error) reject(new Error(stderr.trim() || error.message))
              else resolve()
            })
          })
          json(req, res, 200, { agent, url: targetUrl, prompt, opened: true })
        } catch (error) {
          json(req, res, 200, {
            agent,
            url: targetUrl,
            prompt,
            opened: false,
            error: (error as Error).message,
          })
        }
        return
      }

      // 打开某个工作区的目录。路径从库里取，不接受调用方给的路径
      if (url.pathname === '/api/worktree/open' && req.method === 'POST') {
        const { id } = await readBody(req)
        const wt = db.worktreeById(String(id))
        if (!wt) throw new Error(`Worktree not found: ${id}`)
        if (!existsSync(wt.path)) throw new Error(`Directory no longer exists: ${wt.path}`)
        execFile('open', [wt.path], () => {})
        json(req, res, 200, { ok: true, path: wt.path })
        return
      }

      // ----------------------------------------------------------- 待办

      // 待办是全局的，不分项目，所以这里不解析 project
      if (url.pathname === '/api/todos' && req.method === 'GET') {
        // 与需求一致：每次读取前同步一次，md 可能被 agent 改过
        const sync = db.syncTodos()
        json(req, res, 200, {
          todos: db.listTodos(),
          statuses: TODO_STATUSES,
          sources: TODO_SOURCES,
          sync,
        })
        return
      }

      if (url.pathname === '/api/todos/update' && req.method === 'POST') {
        const { id, status } = await readBody(req)
        const target = String(id)
        if (!db.todoById(target)) throw new Error(`Todo not found: ${target}`)
        json(req, res, 200, db.setTodoStatus(target, status as TodoStatus))
        return
      }

      // 读一条待办的 md 原文（内容源在文件里）
      if (url.pathname === '/api/todos/doc' && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        json(req, res, 200, { id, ...db.readTodoDoc(id) })
        return
      }

      if (url.pathname === '/api/todos/doc' && req.method === 'POST') {
        const { id, content } = await readBody(req)
        json(req, res, 200, { id: String(id), ...db.writeTodoDoc(String(id), String(content ?? '')) })
        return
      }

      // ----------------------------------------------------------- 设置

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        json(req, res, 200, {
          dataDir: currentDir,
          dbFile: db.file,
          defaultDataDir: defaultDataDir(),
          counts: {
            requirements: db.list().length,
            projects: db.listProjects().length,
          },
        })
        return
      }

      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const { dataDir: next } = await readBody(req)
        const dir = String(next ?? '').trim()
        if (!dir) throw new Error('Data dir cannot be empty')
        if (dir === currentDir) {
          json(req, res, 200, { dataDir: currentDir, dbFile: db.file, unchanged: true, sync: null })
          return
        }
        // 换目录：关旧库 → 在新目录建/开库并同步（不存在则初始化出来）
        db.close()
        const previous = currentDir
        try {
          db = new BoardDatabase(dir, readConfig().activeProject)
          currentDir = dir
          const sync = db.syncProjects()
          db.pickProject()
          writeConfig({ dataDir: dir })
          json(req, res, 200, { dataDir: dir, dbFile: db.file, previous, sync })
        } catch (err) {
          // 回滚，避免把应用留在坏状态
          db = new BoardDatabase(previous, readConfig().activeProject)
          currentDir = previous
          db.pickProject()
          throw new Error(`Switch failed, rolled back: ${(err as Error).message}`)
        }
        return
      }

      if (url.pathname === '/api/settings/resync' && req.method === 'POST') {
        json(req, res, 200, { sync: db.syncProjects(), dataDir: currentDir })
        return
      }

      // --------------------------------------------------- CLI and skill

      if (url.pathname === '/api/skill' && req.method === 'GET') {
        json(req, res, 200, await skillPlan())
        return
      }

      if (url.pathname === '/api/skill/install' && req.method === 'POST') {
        const installed = await installSkill()
        json(req, res, 200, { installed, ...(await skillPlan()) })
        return
      }

      // --------------------------------------------------- Agent hook

      // hook 装进了 agent 的用户级配置，所以这里读写的是 ~/.claude/settings.json / ~/.codex/hooks.json
      if (url.pathname === '/api/hooks' && req.method === 'GET') {
        json(req, res, 200, hookPlan({ port }))
        return
      }

      if (url.pathname === '/api/hooks/install' && req.method === 'POST') {
        const installed = installHooks({ port })
        json(req, res, 200, { installed, ...hookPlan({ port }) })
        return
      }

      if (url.pathname === '/api/hooks/uninstall' && req.method === 'POST') {
        const removed = uninstallHooks()
        json(req, res, 200, { removed, ...hookPlan({ port }) })
        return
      }

      json(req, res, 404, { error: 'not found' })
    } catch (err) {
      json(req, res, 400, { error: (err as Error).message })
    }
  }

  return {
    get db() {
      return db
    },
    get dataDir() {
      return currentDir
    },
    store: stateStore,
    sources,
    handle,
    close: () => db.close(),
  }
}

export interface StartOptions {
  port?: number
  dataDir?: string
  host?: string
}

export interface RunningBoardServer {
  server: ReturnType<typeof createServer>
  port: number
  dataDir: string
  close: () => void
}

export function startBoardServer({
  port = DEFAULT_PORT,
  dataDir,
  host = '127.0.0.1',
}: StartOptions = {}): Promise<RunningBoardServer> {
  const app = createBoardApp({ dataDir, port })
  const server = createServer((req, res) => void app.handle(req, res))

  const pull = () => {
    try {
      pullStatuses(app.db.listSessions(), app.store, app.sources)
    } catch (err) {
      log.warn(`pull failed: ${(err as Error).message}`)
    }
  }
  pull()
  const timer = setInterval(pull, PULL_INTERVAL_MS)
  timer.unref()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      log.info(`listening on http://${host}:${port} (log level ${logLevel}, EASY_FLOW_LOG=debug for detail)`)
      log.info(`data dir   ${app.dataDir}`)
      log.info(`database   ${app.db.file}`)
      resolve({
        server,
        port,
        dataDir: app.dataDir,
        close: () => {
          server.close()
          app.close()
        },
      })
    })
  })
}
