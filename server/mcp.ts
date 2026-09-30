/**
 * easy-flow MCP：终端里的 agent 用它认路、建项目与需求。
 *
 * 数据目录在哪、模板长什么样、目录要摆成什么结构，都由服务端掌握，
 * agent 只需要回答"叫什么、做什么"——不需要被告知自己处在什么环境里。
 *
 * 身份只认 id：需求 id 写在 requirement.md 的 frontmatter 里，worktree 的身份由创建时
 * 写进它自己 AGENTS.md 的 id 提供。不拿 cwd、也不拿正文里出现的路径去猜是哪个需求——
 * 猜错了会把状态写到别的需求上，而 id 查不到只会报错。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { BoardDatabase } from './db.ts'
import { readConfig } from './config.ts'
import { listProjectDirs, parseFrontmatter, readProjectConvention } from './markdown.ts'
import {
  createProjectDir,
  createRequirementDir,
  newRequirementId,
  setRequirementId,
} from './convention.ts'

const VERSION = createRequire(import.meta.url)('../package.json').version as string

const config = readConfig()

let instance: BoardDatabase | null = null

/**
 * 数据库延迟到第一次真正用到时才打开。
 * 注册是用户级的，意味着每个 claude / codex 会话都会把这个进程拉起来，
 * 哪怕根本没碰 easy-flow——不该一启动就去建库、跑迁移。
 */
function db(): BoardDatabase {
  return (instance ??= new BoardDatabase(config.dataDir))
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] }
}

/** 需求 id：显式传参 > 终端 env。都没有就报错，不去猜 */
function requireId(explicit?: string): string {
  const id = explicit?.trim() || process.env.EASY_FLOW_REQUIREMENT_ID?.trim()
  if (!id) {
    throw new Error(
      '缺少需求 id：请显式传 id，或在 easy-flow 打开的需求终端 / 带 id 的 worktree 里调用',
    )
  }
  return id
}

function requireProject(explicit?: string): string {
  const slug = explicit?.trim() || process.env.EASY_FLOW_PROJECT?.trim()
  if (!slug) throw new Error('缺少 project：请显式传 project，或在 easy-flow 打开的终端里调用')
  return slug
}

/** 项目目录。不存在就报错，顺便把已有的项目名列出来 */
function projectRoot(project: string): string {
  const root = join(config.dataDir, project)
  if (existsSync(root)) return root
  const known = listProjectDirs(config.dataDir).map((p) => p.slug)
  throw new Error(
    `项目不存在：${project}${known.length ? `。现有项目：${known.join('、')}` : '（数据目录下还没有项目）'}`,
  )
}

function findById(id: string) {
  const req = db().byId(id)
  if (!req) throw new Error(`找不到需求：${id}。id 写在需求目录的 requirement.md 里`)
  return req
}

/** 从标题推目录名。中文标题推不出来，要求调用方显式给 slug */
function deriveSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`标题里没有英文或数字，推不出目录名：${title}。请显式传 slug`)
  return slug
}

function createRequirement(
  root: string,
  title: string,
  slug: string | undefined,
  summary: string | undefined,
): { dir: string; id: string } {
  const created = createRequirementDir(root, slug?.trim() || deriveSlug(title), title, summary ?? '')
  db().syncProjects()
  return created
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const server = new McpServer({ name: 'easy-flow', version: VERSION })

server.registerTool(
  'get_context',
  {
    title: '取上下文',
    description:
      '按需求 id 取它属于哪个项目，并返回项目规范、需求描述、context.md、状态与文档索引。' +
      '在 easy-flow 开的需求终端里可以省略 id；在 worktree 里用创建时写进 AGENTS.md 的那个 id。',
    inputSchema: {
      id: z.string().optional().describe('需求 id（req-xxxx）。省略则取终端 env'),
    },
  },
  async ({ id }) => {
    const req = findById(requireId(id))
    const root = join(config.dataDir, req.project)
    const convention = readProjectConvention(root)
    const display = convention ? parseFrontmatter(convention).data.name : ''

    const head = [
      `需求 id：${req.id}`,
      `项目：${req.project}${display && display !== req.project ? `（${display}）` : ''}`,
      `需求：${req.title}（${req.slug}）`,
      `需求目录：${req.path}`,
      `状态：${req.status}${req.priority ? ` · 优先级：${req.priority}` : ''}`,
    ]
    if (req.repos.length) head.push(`涉及仓库：${req.repos.map((r) => `${r.short}=${r.repo ?? ''}`).join('、')}`)
    const docs = req.docs.filter((d) => d.name !== 'requirement.md')
    if (docs.length) head.push(`其他文档：${docs.map((d) => d.name).join('、')}`)

    const blocks = [head.join('\n')]
    if (convention) blocks.push(`## 项目规范（${join(root, 'AGENTS.md')}）\n\n${convention.trim()}`)
    const desc = readIfExists(join(req.path, 'requirement.md'))
    if (desc) blocks.push(`## 需求描述（requirement.md）\n\n${desc.trim()}`)
    const ctx = readIfExists(join(req.path, 'context.md'))
    if (ctx) blocks.push(`## 上下文（context.md）\n\n${ctx.trim()}`)

    return text(blocks.join('\n\n'))
  },
)

server.registerTool(
  'create_project',
  {
    title: '新建项目',
    description:
      '在 easy-flow 数据目录下新建项目（含项目规范 AGENTS.md）。项目是需求的容器，通常按业务线划分。',
    inputSchema: {
      slug: z.string().describe('项目标识：英文小写、数字、连字符，如 onex'),
      name: z.string().optional().describe('显示名，省略则同标识'),
    },
  },
  async ({ slug, name }) => {
    const display = name?.trim() || slug
    const dir = createProjectDir(config.dataDir, slug, display)
    db().syncProjects()
    return text(`已创建项目「${display}」（${slug}）\n目录：${dir}`)
  },
)

server.registerTool(
  'create_requirement',
  {
    title: '新建需求',
    description:
      '在项目下新建需求：写齐 AGENTS.md 与 requirement.md（id 写进 frontmatter），' +
      '随即出现在看板的「澄清」列。需求描述写进 requirement.md，标题取 H1、摘要取「需求」段。',
    inputSchema: {
      title: z.string().describe('需求标题，一行'),
      summary: z.string().optional().describe('一句话说清要做什么、为什么'),
      project: z.string().optional().describe('项目标识，默认取终端 env'),
      slug: z.string().optional().describe('目录名（英文小写、数字、连字符）；省略则从标题推导'),
    },
  },
  async ({ title, summary, project, slug }) => {
    const p = requireProject(project)
    const created = createRequirement(projectRoot(p), title, slug, summary)
    return text(
      `已在项目「${p}」下创建需求「${title}」\n需求 id：${created.id}\n目录：${created.dir}\n看板状态默认「澄清」。`,
    )
  },
)

server.registerTool(
  'create_sub_requirement',
  {
    title: '新建子需求',
    description:
      '在某个需求下再建一层需求目录，结构与需求相同，用来拆解跨仓或多步的改动。' +
      '注意：看板只扫一层，子需求既不出现在看板上、也还不能按 id 反查，要等索引改成递归。',
    inputSchema: {
      title: z.string().describe('子需求标题，一行'),
      summary: z.string().optional().describe('一句话说清这次要改什么'),
      id: z.string().optional().describe('父需求 id，默认取终端 env'),
      slug: z.string().optional().describe('目录名（英文小写、数字、连字符）；省略则从标题推导'),
    },
  },
  async ({ title, summary, id, slug }) => {
    const parent = findById(requireId(id))
    const created = createRequirement(parent.path, title, slug, summary)
    return text(
      `已在需求「${parent.title}」下创建子需求「${title}」\n子需求 id：${created.id}\n目录：${created.dir}`,
    )
  },
)

server.registerTool(
  'assign_ids',
  {
    title: '补需求 id',
    description:
      '给还没有 id 的需求生成 id 并写进 requirement.md 的 frontmatter（正文不动）。幂等，已有 id 的不动。',
    inputSchema: {},
  },
  async () => {
    const missing = db().missingIds()
    const done: string[] = []
    for (const r of missing) {
      if (!existsSync(r.path)) continue
      const id = newRequirementId()
      setRequirementId(r.path, id)
      done.push(`${r.project}/${r.slug} → ${id}`)
    }
    if (done.length) db().syncProjects()
    return text(done.length ? `已补 ${done.length} 个：\n${done.join('\n')}` : '所有需求都已有 id')
  },
)

await server.connect(new StdioServerTransport())
