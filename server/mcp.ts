/**
 * easy-flow MCP：终端里的 agent 用它认路、建项目与需求。
 *
 * 数据目录在哪、模板长什么样、目录要摆成什么结构，都由服务端掌握，
 * agent 只需要回答"叫什么、做什么"——不需要被告知自己处在什么环境里。
 *
 * 身份只认 id：需求 id 写在 AGENTS.md 的 frontmatter 里，worktree 的身份由创建时
 * 写进它自己 AGENTS.md 的 id 提供。不拿 cwd、也不拿正文里出现的路径去猜是哪个需求——
 * 猜错了会把状态写到别的需求上，而 id 查不到只会报错。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { BoardDatabase, PRIORITIES, STATUSES, type Priority, type Requirement, type Status, type Worktree } from './db.ts'
import { readConfig } from './config.ts'
import { listProjectDirs, parseFrontmatter, readProjectConvention } from './markdown.ts'
import {
  createProjectDir,
  createRequirementDir,
  newRequirementId,
  newWorktreeId,
  setRequirementId,
} from './convention.ts'
import {
  adoptWorktree,
  deprovisionWorktree,
  linkedWorktrees,
  provisionWorktree,
  resolveCheckout,
  worktreeIdIn,
  worktreePathFor,
} from './worktree.ts'

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

/** id 只认显式传参。env 与 cwd 都不作为来源——猜错了会把状态写到别的需求上 */
function requireId(
  explicit?: string,
  hint = '需求 id（写在需求目录 AGENTS.md 的 frontmatter 里，形如 req-xxxxxxxxxx）',
): string {
  const id = explicit?.trim()
  if (!id) throw new Error(`缺少${hint}：请显式传 id`)
  return id
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
  if (!req) throw new Error(`找不到需求：${id}。id 写在需求目录的 AGENTS.md 里`)
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

/** 需求主体：头部几行 + 项目规范 + 需求描述 + context.md。extraHead 给 worktree 命中时补头 */
function requirementBlocks(req: Requirement, extraHead: string[] = []): string[] {
  const root = join(config.dataDir, req.project)
  const convention = readProjectConvention(root)
  const display = convention ? parseFrontmatter(convention).data.name : ''

  const head = [
    ...extraHead,
    `需求 id：${req.id}`,
    `项目：${req.project}${display && display !== req.project ? `（${display}）` : ''}`,
    `需求：${req.title}（${req.slug}）`,
    `需求目录：${req.path}`,
    `状态：${req.status}${req.priority ? ` · 优先级：${req.priority}` : ''}`,
  ]
  if (req.repos.length) head.push(`涉及仓库：${req.repos.map((r) => `${r.short}=${r.repo ?? ''}`).join('、')}`)
  // context.md 紧接着会整篇打出来，不必再在清单里重复一次
  const docs = req.docs.filter((d) => d.name !== 'requirement.md' && d.name !== 'context.md')
  if (docs.length) head.push(`其他文档：${docs.map((d) => d.name).join('、')}`)

  const blocks = [head.join('\n')]
  if (convention) blocks.push(`## 项目规范（${join(root, 'AGENTS.md')}）\n\n${convention.trim()}`)
  const desc = readIfExists(join(req.path, 'requirement.md'))
  if (desc) blocks.push(`## 需求描述（requirement.md）\n\n${desc.trim()}`)
  const ctx = readIfExists(join(req.path, 'context.md'))
  if (ctx) blocks.push(`## 上下文（context.md）\n\n${ctx.trim()}`)
  return blocks
}

function worktreeLine(w: Worktree): string {
  const short = w.short ? `${w.short} / ` : ''
  return `- ${w.id}  ${short}${w.repo}  ${w.branch}  ${w.path}${w.orphan ? '（目录已失联，可 remove_worktree）' : ''}`
}

/** 项目视图：只给 id / 状态 / 标题与 worktree 计数，不带需求正文——正文要另调一次 */
function projectContext(slug: string): string {
  const board = db()
  const project = board.listProjects().find((p) => p.slug === slug)
  if (!project) {
    const known = board.listProjects().map((p) => p.slug)
    throw new Error(
      `找不到「${slug}」：现有项目 ${known.join('、') || '（还没有项目）'}；需求请传 req-…，worktree 请传 wt-…`,
    )
  }
  const counts = new Map<string, number>()
  for (const w of board.listWorktrees()) {
    counts.set(w.requirementId, (counts.get(w.requirementId) ?? 0) + 1)
  }
  const requirements = board.listIn(project.slug)
  const lines = requirements.map(
    (r) =>
      `- ${r.id || '（无 id）'}  ${r.status}  ${r.slug}  ${r.title}` +
      (counts.get(r.id) ? `（${counts.get(r.id)} 个 worktree）` : ''),
  )
  const blocks = [
    `项目：${project.name}（${project.slug}）\n目录：${project.root}\n需求（${requirements.length}）：\n${
      lines.join('\n') || '（无）'
    }`,
  ]
  if (project.convention) {
    blocks.push(`## 项目规范（${join(project.root, 'AGENTS.md')}）\n\n${project.convention.trim()}`)
  }
  return blocks.join('\n\n')
}

const server = new McpServer({ name: 'easy-flow', version: VERSION })

server.registerTool(
  'get_context',
  {
    title: '取上下文',
    description:
      '按 id 取上下文，返回从命中处向上到项目的整条链（项目规范、需求描述、context.md、状态、文档索引）。' +
      '三种 id 都收：wt-… 是 worktree（在它的 AGENTS.md frontmatter 里）、req-… 是需求（在需求目录的 AGENTS.md 里）、' +
      '裸值当项目标识。id 必须显式传，不做猜测。',
    inputSchema: {
      id: z.string().optional().describe('wt-xxxxxxxxxx / req-xxxxxxxxxx / 项目标识'),
    },
  },
  async ({ id }) => {
    const board = db()
    board.syncProjects()
    const key = requireId(id)

    // 项目名的字符集包含 req-/wt- 前缀，所以 id 查不到时再看一眼项目表
    const asProject = (): string | null =>
      board.listProjects().some((p) => p.slug === key) ? projectContext(key) : null

    if (key.startsWith('wt-')) {
      const wt = board.worktreeById(key)
      const alt = wt ? null : asProject()
      if (alt) return text(alt)
      if (!wt) throw new Error(`找不到 worktree：${key}。id 写在 worktree 的 AGENTS.md 里`)
      const req = board.byId(wt.requirementId)
      if (!req) throw new Error(`worktree ${key} 记的需求 ${wt.requirementId} 不在库里了`)
      const blocks = requirementBlocks(req, [
        `worktree id：${wt.id}`,
        `仓库：${wt.repo}${wt.short ? `（短名 ${wt.short}）` : ''}`,
        `分支：${wt.branch}`,
        `路径：${wt.path}${existsSync(wt.path) ? '' : '（目录已不存在）'}`,
        `主 checkout：${wt.main}`,
        `设计文档：${join(wt.path, 'design')} → ${join(req.path, 'docs', (wt.short || wt.repo).trim())}（软链，写在这儿的东西存在需求目录）`,
      ])
      const siblings = board.listWorktrees(req.id).filter((w) => w.id !== wt.id)
      blocks.push(
        siblings.length
          ? `## 同一需求的其它 worktree\n${siblings.map(worktreeLine).join('\n')}`
          : '## 同一需求的其它 worktree\n（无）',
      )
      return text(blocks.join('\n\n'))
    }

    if (key.startsWith('req-')) {
      const req = board.byId(key)
      const alt = req ? null : asProject()
      if (alt) return text(alt)
      if (!req) throw new Error(`找不到需求：${key}`)
      const wts = board.listWorktrees(req.id)
      const blocks = requirementBlocks(req)
      blocks.push(
        wts.length
          ? `## worktree（${wts.length}）\n${wts.map(worktreeLine).join('\n')}`
          : '## worktree（0）\n还没有工作区；要在某个仓库里动手，先用 create_worktree 建一个',
      )
      return text(blocks.join('\n\n'))
    }

    return text(projectContext(key))
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
      '在项目下新建需求：一次写齐 AGENTS.md（id 写进 frontmatter，并写明目录里每个文件的作用）、' +
      'requirement.md（需求描述骨架，标题取 H1、摘要取「需求」段）与 context.md（上下文骨架），' +
      '随即出现在看板的「澄清」列。',
    inputSchema: {
      title: z.string().describe('需求标题，一行'),
      summary: z.string().optional().describe('一句话说清要做什么、为什么'),
      project: z.string().describe('项目标识（如 onex），必传——环境变量不再兜底'),
      slug: z.string().optional().describe('目录名（英文小写、数字、连字符）；省略则从标题推导'),
    },
  },
  async ({ title, summary, project, slug }) => {
    const p = project.trim()
    if (!p) throw new Error('project 不能为空')
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
      id: z.string().optional().describe('父需求 id（req-xxxxxxxxxx）'),
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
      '给还没有 id 的需求生成 id 并写进 AGENTS.md 的 frontmatter（正文不动）。幂等，已有 id 的不动。',
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

server.registerTool(
  'update_requirement',
  {
    title: '改需求状态',
    description: '改需求的看板状态与优先级。传了哪个改哪个，没传的保持不动。',
    inputSchema: {
      id: z.string().describe('需求 id（req-xxxxxxxxxx）'),
      status: z.enum(STATUSES).optional().describe('看板状态'),
      priority: z
        .union([z.enum(PRIORITIES), z.literal('')])
        .optional()
        .describe('优先级；空串表示清空'),
    },
  },
  async ({ id, status, priority }) => {
    const board = db()
    board.syncProjects()
    const req = findById(requireId(id))
    if (status === undefined && priority === undefined) {
      throw new Error('status 与 priority 至少传一个')
    }
    let next = req
    if (status !== undefined) next = board.setStatus(req.slug, status as Status, req.project)
    if (priority !== undefined) next = board.setPriority(req.slug, priority as Priority, req.project)
    return text(
      `需求：${next.title}（${next.id}）\n状态：${next.status}${
        next.priority ? ` · 优先级：${next.priority}` : ''
      }`,
    )
  },
)

server.registerTool(
  'add_links',
  {
    title: '追加需求链接',
    description:
      '给需求追加外部链接（飞书任务 / 代码 MR / 扩展链接）。只增不删：同一字段重复调用会合并去重，' +
      '已有链接不会被顶掉；要清空得去界面或库里改。',
    inputSchema: {
      id: z.string().describe('需求 id（req-xxxxxxxxxx）'),
      feishuTaskLinks: z.array(z.string()).optional().describe('飞书任务链接'),
      codeLinks: z.array(z.string()).optional().describe('GitLab MR / GitHub PR 链接'),
      extLinks: z
        .array(z.object({ detail: z.string(), url: z.string() }))
        .optional()
        .describe('扩展链接：描述 + 链接'),
    },
  },
  async ({ id, feishuTaskLinks, codeLinks, extLinks }) => {
    const board = db()
    board.syncProjects()
    const req = findById(requireId(id))
    if (!feishuTaskLinks && !codeLinks && !extLinks) throw new Error('至少要传一类链接')

    // 追加而不是替换：这个工具只负责往清单里加东西，删的能力不往外暴露
    const mergedExt = [...req.extLinks]
    for (const e of extLinks ?? []) {
      if (!mergedExt.some((x) => x.url === e.url)) mergedExt.push(e)
    }
    const next = board.setLinks(
      req.slug,
      {
        ...(feishuTaskLinks
          ? { feishuTaskLinks: [...new Set([...req.feishuTaskLinks, ...feishuTaskLinks])] }
          : {}),
        ...(codeLinks ? { codeLinks: [...new Set([...req.codeLinks, ...codeLinks])] } : {}),
        ...(extLinks ? { extLinks: mergedExt } : {}),
      },
      req.project,
    )

    const line = (label: string, list: string[]) => `${label}（${list.length}）：${list.join('、') || '（空）'}`
    return text(
      [
        `需求：${next.title}（${next.id}）`,
        line('飞书任务', next.feishuTaskLinks),
        line('代码链接', next.codeLinks),
        line('扩展链接', next.extLinks.map((l) => `${l.detail} ${l.url}`)),
      ].join('\n'),
    )
  },
)

server.registerTool(
  'create_worktree',
  {
    title: '新建 worktree',
    description:
      '给需求开一个代码工作区：在主 checkout 旁边建 git worktree（名字是 <仓库>.<分支>），' +
      '写进身份文件 AGENTS.md、建一条指向 requirement.md 的软链，并登记到 easy-flow。' +
      '同路径重复调用是幂等的，中途失败也不会动已建好的目录，重试即可。',
    inputSchema: {
      requirementId: z.string().describe('需求 id（req-xxxxxxxxxx）'),
      repo: z.string().describe('仓库名（在仓库根下找），或主 checkout 的绝对路径'),
      branch: z.string().describe('分支名，如 feature-seatmap-truemap；本地已有则复用'),
      base: z.string().optional().describe('新分支起点，缺省用主 checkout 当前的 HEAD'),
      short: z.string().optional().describe('短名（涉及仓库表的短名列），仅用于展示'),
    },
  },
  async ({ requirementId, repo, branch, base, short }) => {
    const board = db()
    board.syncProjects()
    const req = findById(requireId(requirementId))
    if (!existsSync(req.path)) throw new Error(`需求目录不存在：${req.path}`)

    const target = await resolveCheckout(repo)
    const path = worktreePathFor(target.main, branch)
    const known = board.worktreeByPath(path)
    const id = known?.id || worktreeIdIn(path) || newWorktreeId()

    const provision = await provisionWorktree({
      worktreeId: id,
      requirementId: req.id,
      requirementDir: req.path,
      target,
      branch,
      base,
      short,
    })

    try {
      board.addWorktree({
        id,
        requirementId: req.id,
        short: short ?? '',
        repo: target.repo,
        branch,
        path: provision.path,
        main: target.main,
      })
    } catch (err) {
      // 目录已经建好了，不撤——重试会认领它，并从它的 AGENTS.md 读回同一个 id
      throw new Error(
        `登记失败：${(err as Error).message}\n` +
          `worktree 目录已经建好（${provision.path}，id 就写在它的 AGENTS.md 里），再调一次 create_worktree 即可补上登记。`,
      )
    }

    return text(
      [
        provision.created
          ? '已建好 worktree'
          : '这个 worktree 本就存在，只补齐了 easy-flow 的产物（目录与分支没动）',
        `worktree id：${id}`,
        `需求：${req.title}（${req.id}）`,
        `仓库：${target.repo}${short ? `（短名 ${short}）` : ''}`,
        `分支：${branch}（${provision.branchCreated ? `新建，起点 ${base || '主 checkout 的 HEAD'}` : '复用本地已有分支'}）`,
        `路径：${provision.path}`,
        `主 checkout：${target.main}`,
        provision.excludeNote,
        provision.identityInFile
          ? `在这个目录里调 get_context，请传 ${id}。`
          : `注意：目录里已有一份不是 easy-flow 写的 AGENTS.md，没动它，${id} 因此没落进文件。` +
            `顺着软链 requirement.md 能走到需求目录，从那份 AGENTS.md 的 frontmatter 拿需求 id，再 get_context 列出它的 worktree 对号入座。`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  },
)

server.registerTool(
  'remove_worktree',
  {
    title: '移除 worktree',
    description:
      '删掉一个 worktree：目录、git 登记与 easy-flow 里的记录一起清掉，分支保留（里面有提交的可能）。' +
      '有未提交改动时会拒绝，确认丢弃再传 force。',
    inputSchema: {
      id: z.string().describe('worktree id（wt-xxxxxxxxxx）'),
      force: z.boolean().optional().describe('丢弃未提交改动，强制移除'),
    },
  },
  async ({ id, force }) => {
    const board = db()
    board.syncProjects()
    const wt = board.worktreeById(
      requireId(id, 'worktree id（写在它自己 AGENTS.md 的 frontmatter 里，形如 wt-xxxxxxxxxx）'),
    )
    if (!wt) throw new Error(`找不到 worktree：${id}`)
    const result = await deprovisionWorktree({
      path: wt.path,
      main: wt.main,
      branch: wt.branch,
      force: !!force,
    })
    board.removeWorktree(wt.id)
    return text(
      [
        result.missing ? '目录本就不在，已清掉记录与 git 登记' : '已移除 worktree',
        `worktree id：${wt.id}`,
        `路径：${wt.path}`,
        result.discarded.length ? `丢弃了 ${result.discarded.length} 处未提交改动` : '',
        `分支 ${wt.branch} 已保留；要删：git -C ${wt.main} branch -D ${wt.branch}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  },
)

server.registerTool(
  'import_worktrees',
  {
    title: '收编已有 worktree',
    description:
      '把旧工作流留下的 git worktree 登记进 easy-flow：按需求目录里的软链找到它们，' +
      '补上身份文件 AGENTS.md、requirement.md 软链与 info/exclude，并落库。' +
      '已经登记过的会跳过——一个工作区只归一个需求，先登记者得。',
    inputSchema: {
      requirementId: z.string().optional().describe('只收编这个需求；省略则扫所有需求'),
    },
  },
  async ({ requirementId }) => {
    const board = db()
    board.syncProjects()
    const targets = requirementId
      ? [findById(requireId(requirementId))]
      : board.listProjects().flatMap((p) => board.listIn(p.slug))

    const adopted: string[] = []
    const skipped: string[] = []
    for (const req of targets) {
      if (!req.id) {
        skipped.push(`${req.slug}：还没有 id，先跑 assign_ids`)
        continue
      }
      if (!existsSync(req.path)) {
        skipped.push(`${req.slug}：需求目录不在（${req.path}）`)
        continue
      }
      for (const found of linkedWorktrees(req.path)) {
        const owner = board.worktreeByPath(found.path)
        if (owner) {
          const ownerReq = board.byId(owner.requirementId)
          skipped.push(`${found.path}：已归「${ownerReq?.title ?? owner.requirementId}」（${owner.id}）`)
          continue
        }
        const id = worktreeIdIn(found.path) || newWorktreeId()
        const t = await adoptWorktree({
          path: found.path,
          worktreeId: id,
          requirementId: req.id,
          requirementDir: req.path,
          short: found.short,
        })
        board.addWorktree({
          id,
          requirementId: req.id,
          short: found.short,
          repo: t.repo,
          branch: t.branch,
          path: t.path,
          main: t.main,
        })
        adopted.push(`${t.path} → ${id}（${req.title} · ${t.branch}）`)
      }
    }

    return text(
      [
        `收编 ${adopted.length} 个，跳过 ${skipped.length} 个。`,
        adopted.length ? `\n## 已收编\n${adopted.join('\n')}` : '',
        skipped.length ? `\n## 跳过\n${skipped.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  },
)

await server.connect(new StdioServerTransport())
