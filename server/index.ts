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
import { readConfig, writeConfig, defaultDataDir } from './config.ts'
import { installSkill, skillPlan } from './skill-install.ts'
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
  orphaned: [],
  restored: [],
  worktrees: { orphaned: [], restored: [] },
}

export interface BoardAppOptions {
  /** 数据目录；不传则读配置 */
  dataDir?: string
}

export interface BoardApp {
  db: BoardDatabase
  readonly dataDir: string
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

export function createBoardApp({ dataDir }: BoardAppOptions = {}): BoardApp {
  const initial = readConfig()
  let currentDir = dataDir ?? initial.dataDir
  let db = new BoardDatabase(currentDir, initial.activeProject)
  db.syncProjects()
  db.pickProject()

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
          // 同理：会话只归库，详情页的「会话」块靠这一份
          sessions: db.listSessions(ctx.requirement.id),
        })
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

      // 在访达里打开这条待办的 md。路径从库里取，不接受调用方给的路径
      if (url.pathname === '/api/todos/open' && req.method === 'POST') {
        const { id } = await readBody(req)
        const todo = db.todoById(String(id))
        if (!todo) throw new Error(`Todo not found: ${id}`)
        if (!existsSync(todo.path)) throw new Error(`File no longer exists: ${todo.path}`)
        execFile('open', [todo.path], () => {})
        json(req, res, 200, { ok: true, path: todo.path })
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
  const app = createBoardApp({ dataDir })
  const server = createServer((req, res) => void app.handle(req, res))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      console.log(`[easy-flow] 服务已启动 http://${host}:${port}`)
      console.log(`[easy-flow] 数据目录    ${app.dataDir}`)
      console.log(`[easy-flow] 数据库      ${app.db.file}`)
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
