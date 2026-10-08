/**
 * easy-flow CLI: for agents and humans in a terminal — read context, create projects and
 * requirements, manage worktrees.
 *
 * Plain text by default (cheap for humans and agents to read); add --json for scripts.
 * Identity is explicit only — ids live in the AGENTS.md frontmatter of requirement and
 * worktree dirs. Never guessed from cwd or env: a wrong guess writes state onto another
 * requirement, while an unknown id just errors out.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, readConfig } from './config.ts'
import { createProjectDir, createRequirementDir, newWorktreeId } from './convention.ts'
import {
  BoardDatabase,
  PRIORITIES,
  STATUSES,
  type Priority,
  type Requirement,
  type Status,
  type Worktree,
} from './db.ts'
import { listProjectDirs, parseFrontmatter, readProjectConvention } from './markdown.ts'
import {
  deprovisionWorktree,
  provisionWorktree,
  resolveCheckout,
  worktreeIdIn,
  worktreePathFor,
} from './worktree.ts'

const VERSION = createRequire(import.meta.url)('../package.json').version as string

const config = readConfig()

let instance: BoardDatabase | null = null

/**
 * Open the database lazily: --help / --version must not create one.
 */
function db(): BoardDatabase {
  return (instance ??= new BoardDatabase(config.dataDir))
}

/**
 * --json is for scripts: data on success, { error } on failure, both on stdout.
 */
let asJson = false

function out(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`)
}

function emit(data: unknown, text: string): void {
  out(asJson ? JSON.stringify(data, null, 2) : text)
}

/**
 * Bad arguments: exit 2 with usage; anything else: exit 1.
 */
class UsageError extends Error {
  usage: string

  constructor(message: string, usage = '') {
    super(message)
    this.usage = usage
  }
}

function required(value: string | undefined, message: string, usage: string): string {
  const v = value?.trim()
  if (!v) throw new UsageError(message, usage)
  return v
}

/**
 * Project dir; errors with the known projects when it does not exist.
 */
function projectRoot(project: string): string {
  const root = join(config.dataDir, project)
  if (existsSync(root)) return root
  const known = listProjectDirs(config.dataDir).map((p) => p.slug)
  throw new Error(
    `Project not found: ${project}${
      known.length ? `. Known projects: ${known.join(', ')}` : ' (no projects under the data dir yet)'
    }`,
  )
}

function findById(id: string): Requirement {
  const req = db().byId(id)
  if (!req) throw new Error(`Requirement not found: ${id}. The id lives in the requirement dir's AGENTS.md`)
  return req
}

/**
 * Derive a dir name from the title; non-ASCII titles cannot be derived — pass --slug.
 */
function deriveSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`No ASCII letters or digits in the title, cannot derive a dir name: ${title}. Pass --slug`)
  return slug
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function worktreeLine(w: Worktree): string {
  const short = w.short ? `${w.short} / ` : ''
  return `- ${w.id}  ${short}${w.repo}  ${w.branch}  ${w.path}${
    w.orphan ? '（目录已失联，可 easy-flow wt rm）' : ''
  }`
}

/**
 * Requirement body: header lines + project convention + requirement.md + context.md.
 * extraHead adds lines for a worktree hit.
 */
function requirementView(req: Requirement, extraHead: string[] = []) {
  const root = join(config.dataDir, req.project)
  const convention = readProjectConvention(root)
  const display = convention ? parseFrontmatter(convention).data.name : ''
  const requirementMd = readIfExists(join(req.path, 'requirement.md'))
  const contextMd = readIfExists(join(req.path, 'context.md'))

  const head = [
    ...extraHead,
    `需求 id：${req.id}`,
    `项目：${req.project}${display && display !== req.project ? `（${display}）` : ''}`,
    `需求：${req.title}（${req.slug}）`,
    `需求目录：${req.path}`,
    `状态：${req.status}${req.priority ? ` · 优先级：${req.priority}` : ''}`,
  ]
  if (req.repos.length) head.push(`涉及仓库：${req.repos.map((r) => `${r.short}=${r.repo ?? ''}`).join('、')}`)
  // context.md follows in full right after, no need to list it twice
  const docs = req.docs.filter((d) => d.name !== 'requirement.md' && d.name !== 'context.md')
  if (docs.length) head.push(`其他文档：${docs.map((d) => d.name).join('、')}`)

  const blocks = [head.join('\n')]
  // Hierarchy is how a requirement gets split: a sub-requirement needs its parents in view,
  // a parent needs to see what hangs below it. Only the nearest parent's body is included —
  // going further up is one more `context` call away.
  const board = db()
  const ancestors = board.ancestors(req)
  if (ancestors.length) {
    blocks.push(`## 上层需求（从近到远）\n${ancestors.map(requirementLine).join('\n')}`)
    const parentMd = readIfExists(join(ancestors[0].path, 'requirement.md'))
    if (parentMd) blocks.push(`## 父需求描述（${ancestors[0].slug}/requirement.md）\n\n${parentMd.trim()}`)
  }
  if (convention) blocks.push(`## 项目规范（${join(root, 'AGENTS.md')}）\n\n${convention.trim()}`)
  if (requirementMd) blocks.push(`## 需求描述（requirement.md）\n\n${requirementMd.trim()}`)
  if (contextMd) blocks.push(`## 上下文（context.md）\n\n${contextMd.trim()}`)
  const children = board.children(req.id)
  if (children.length) {
    blocks.push(`## 子需求（${children.length}）\n${children.map(requirementLine).join('\n')}`)
  }

  const data = {
    requirement: {
      id: req.id,
      parentId: req.parentId,
      project: req.project,
      title: req.title,
      slug: req.slug,
      path: req.path,
      status: req.status,
      priority: req.priority,
      summary: req.summary,
      repos: req.repos,
      docs: req.docs,
    },
    ancestors: ancestors.map((r) => ({ id: r.id, slug: r.slug, title: r.title })),
    children: children.map((r) => ({ id: r.id, slug: r.slug, title: r.title, status: r.status })),
    projectConvention: convention,
    requirementMd,
    contextMd,
  }
  return { blocks, data }
}

/** One requirement per line, for the ancestor / child lists */
function requirementLine(r: Requirement): string {
  return `- ${r.id || '（无 id）'}  ${r.slug}  ${r.title}`
}

/**
 * Project view: id / status / title and worktree counts only; bodies need their own call.
 */
function projectView(slug: string) {
  const board = db()
  const project = board.listProjects().find((p) => p.slug === slug)
  if (!project) {
    const known = board.listProjects().map((p) => p.slug)
    throw new Error(
      `Not found: ${slug}. Known projects: ${known.join(', ') || '(none yet)'}; pass req-… for requirements, wt-… for worktrees`,
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
  const data = {
    project: {
      slug: project.slug,
      name: project.name,
      root: project.root,
      convention: project.convention ?? null,
    },
    requirements: requirements.map((r) => ({
      id: r.id,
      status: r.status,
      slug: r.slug,
      title: r.title,
      worktreeCount: counts.get(r.id) ?? 0,
    })),
  }
  return { blocks, data }
}

const ROOT_USAGE = `easy-flow：需求看板命令行——终端里认路、建项目与需求、开工作区。

用法：
  easy-flow context <id>         取上下文（id ∈ req-… / wt-… / 项目标识）
  easy-flow dir                  打印数据目录（需求都在哪）
  easy-flow project new <slug>   新建项目
  easy-flow req new|set|link …   新建需求 / 改状态优先级 / 追加链接
  easy-flow wt new|rm …          开 / 删工作区（git worktree）

选项：
  --json      输出 JSON（给脚本解析），出错也是 JSON
  --help      每个命令都可跟：easy-flow req new --help
  --version   版本号`

const USAGE = {
  context: `用法：easy-flow context <id> [--json]

id 三种都收：req-…（需求）、wt-…（工作区）、项目标识（项目）。
id 必须显式传：需求 id 在需求目录 AGENTS.md 的 frontmatter 里，worktree id 在它自己的 AGENTS.md 里。`,

  dir: `用法：easy-flow dir [--json]

打印数据目录——需求都在它下面（<数据目录>/<项目>/<需求>/）。
路径由配置决定，不要写死。--json 另带配置文件路径与当前项目。`,

  project: `用法：easy-flow project new <slug> [--name <显示名>] [--json]

项目是需求的容器，通常按业务线划分。slug 用英文小写、数字、连字符。`,

  'req new': `用法：easy-flow req new <标题> (--project <项目> | --parent <req-…>) [--slug <目录名>] [--summary <一句话>] [--json]

--parent 建子需求：目录嵌在父需求里，结构同普通需求。子需求一样入库、一样出现在看板上，
也能按 id 反查；层级可以往下续，slug 是相对项目根的路径（如 parent/child）。
中文标题推不出目录名，需要显式给 --slug。`,

  'req set': `用法：easy-flow req set <id> [--status <澄清|执行中|Review|已完成>] [--priority <p0|p1|p2|p3|"">] [--json]

传了哪个改哪个，都没传会报错。--priority "" 清空优先级。`,

  'req link': `用法：easy-flow req link <id> [--feishu <url>] [--mr <url>] [--ext "<描述>=<url>"] [--json]

三类链接都可重复传，只增不删：同一字段合并去重，已有链接不会被顶掉。
--ext 的描述与链接按第一个 = 分隔。`,

  'wt new': `用法：easy-flow wt new <req-id> --repo <仓库> --branch <分支> [--base <起点>] [--short <短名>] [--json]

在主 checkout 旁边建 <仓库>.<分支>：写身份文件 AGENTS.md、建 requirement.md 与 design/ 软链，并登记。
--repo 传仓库名（在仓库根下找）或主 checkout 的绝对路径；--base 缺省用主 checkout 的 HEAD。
同路径重复调用是幂等的；--short 是涉及仓库表里的短名，用来给设计目录 docs/<短名>/ 命名并展示。`,

  'wt rm': `用法：easy-flow wt rm <wt-id> [--force] [--json]

删目录、git 登记与 easy-flow 记录，分支保留。有未提交改动会拒绝，--force 丢弃后强删。`,
}

const GROUP_USAGE = {
  project: USAGE.project,
  req: [USAGE['req new'], USAGE['req set'], USAGE['req link']].join('\n\n'),
  wt: [USAGE['wt new'], USAGE['wt rm']].join('\n\n'),
}

type OptSpec = Record<string, { type: 'boolean' | 'string'; multiple?: boolean }>

function parse(argv: string[], options: OptSpec): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { help: { type: 'boolean' }, ...options },
      allowPositionals: true,
    })
    return { values, positionals }
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strs = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
const bool = (v: unknown): boolean => v === true

/**
 * 数据目录从哪来：只读配置，不开库——db 坏了、数据目录还没建，这条命令也该能答。
 */
async function cmdDir(argv: string[]): Promise<void> {
  const { values } = parse(argv, {})
  if (bool(values.help)) return out(USAGE.dir)
  emit(
    { dataDir: config.dataDir, configPath: configPath(), activeProject: config.activeProject },
    `数据目录：${config.dataDir}\n配置文件：${configPath()}`,
  )
}

async function cmdContext(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {})
  if (bool(values.help)) return out(USAGE.context)

  const board = db()
  board.syncProjects()
  const key = required(positionals[0], 'Missing id (req-… / wt-… / project slug)', USAGE.context)

  // project slugs may look like req-/wt- ids, so fall back to the project table when the id is unknown
  const tryProject = () => (board.listProjects().some((p) => p.slug === key) ? projectView(key) : null)

  if (key.startsWith('wt-')) {
    const wt = board.worktreeById(key)
    if (!wt) {
      const alt = tryProject()
      if (alt) return emit({ kind: 'project', ...alt.data }, alt.blocks.join('\n\n'))
      throw new Error(`Worktree not found: ${key}. The id lives in the worktree's AGENTS.md`)
    }
    const req = board.byId(wt.requirementId)
    if (!req) throw new Error(`Worktree ${key} refers to requirement ${wt.requirementId}, which is no longer in the db`)
    const view = requirementView(req, [
      `worktree id：${wt.id}`,
      `仓库：${wt.repo}${wt.short ? `（短名 ${wt.short}）` : ''}`,
      `分支：${wt.branch}`,
      `路径：${wt.path}${existsSync(wt.path) ? '' : '（目录已不存在）'}`,
      `主 checkout：${wt.main}`,
      `设计文档：${join(wt.path, 'design')} → ${join(req.path, 'docs', (wt.short || wt.repo).trim())}（软链，写在这儿的东西存在需求目录）`,
    ])
    const siblings = board.listWorktrees(req.id).filter((w) => w.id !== wt.id)
    view.blocks.push(
      siblings.length
        ? `## 同一需求的其它 worktree\n${siblings.map(worktreeLine).join('\n')}`
        : '## 同一需求的其它 worktree\n（无）',
    )
    return emit({ kind: 'worktree', worktree: wt, ...view.data, siblings }, view.blocks.join('\n\n'))
  }

  if (key.startsWith('req-')) {
    const req = board.byId(key)
    if (!req) {
      const alt = tryProject()
      if (alt) return emit({ kind: 'project', ...alt.data }, alt.blocks.join('\n\n'))
      throw new Error(`Requirement not found: ${key}`)
    }
    const wts = board.listWorktrees(req.id)
    const view = requirementView(req)
    view.blocks.push(
      wts.length
        ? `## worktree（${wts.length}）\n${wts.map(worktreeLine).join('\n')}`
        : '## worktree（0）\n还没有工作区；要在某个仓库里动手，先 easy-flow wt new 建一个',
    )
    return emit({ kind: 'requirement', ...view.data, worktrees: wts }, view.blocks.join('\n\n'))
  }

  const view = projectView(key)
  emit({ kind: 'project', ...view.data }, view.blocks.join('\n\n'))
}

async function cmdProject(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.project)
  if (!action) throw new UsageError('project needs a subcommand: new', GROUP_USAGE.project)
  if (action !== 'new') throw new UsageError(`Unknown subcommand: project ${action}`, GROUP_USAGE.project)

  const { values, positionals } = parse(argv, { name: { type: 'string' } })
  if (bool(values.help)) return out(USAGE.project)

  const slug = required(positionals[0], 'Missing project slug (lowercase letters, digits, hyphens)', USAGE.project)
  const display = str(values.name)?.trim() || slug
  const dir = createProjectDir(config.dataDir, slug, display)
  db().syncProjects()
  emit({ ok: true, slug, name: display, dir }, `已创建项目「${display}」（${slug}）\n目录：${dir}`)
}

async function cmdReqNew(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    project: { type: 'string' },
    parent: { type: 'string' },
    slug: { type: 'string' },
    summary: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['req new'])

  const title = required(positionals[0], 'Missing requirement title', USAGE['req new'])
  const parentId = str(values.parent)?.trim()
  const project = str(values.project)?.trim()
  if (parentId && project) throw new UsageError('Pass either --project or --parent, not both', USAGE['req new'])
  if (!parentId && !project) throw new UsageError('Pass one of --project / --parent', USAGE['req new'])

  const slug = str(values.slug)?.trim() || deriveSlug(title)
  const summary = str(values.summary) ?? ''

  let created: { dir: string; id: string }
  let text: string
  if (parentId) {
    const parent = findById(parentId)
    created = createRequirementDir(parent.path, slug, title, summary)
    text = `已在需求「${parent.title}」下创建子需求「${title}」`
  } else {
    created = createRequirementDir(projectRoot(project!), slug, title, summary)
    text = `已在项目「${project}」下创建需求「${title}」`
  }
  db().syncProjects()

  // Report the stored slug, not the --slug argument: a sub-requirement's slug is its path
  // from the project root (seatmap/gateway), and callers of --json should get the real one
  const stored = db().byId(created.id)
  emit(
    { ok: true, ...created, title, slug: stored?.slug ?? slug, project: stored?.project ?? project ?? null, parent: parentId ?? null },
    `${text}\n需求 id：${created.id}\n目录：${created.dir}\n看板状态默认「澄清」。`,
  )
}

async function cmdReqSet(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, { status: { type: 'string' }, priority: { type: 'string' } })
  if (bool(values.help)) return out(USAGE['req set'])

  const id = required(positionals[0], 'Missing requirement id (req-…)', USAGE['req set'])
  const status = str(values.status)?.trim()
  const priority = str(values.priority)?.trim()
  if (status === undefined && priority === undefined) {
    throw new UsageError('Pass at least one of --status / --priority', USAGE['req set'])
  }
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unknown status: ${status}. Valid: ${STATUSES.join(', ')}`)
  }
  if (priority !== undefined && priority !== '' && !(PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(`Unknown priority: ${priority}. Valid: ${PRIORITIES.join(', ')}; an empty string clears it`)
  }

  const board = db()
  board.syncProjects()
  const req = findById(id)
  let next = req
  if (status !== undefined) next = board.setStatus(req.slug, status as Status, req.project)
  if (priority !== undefined) next = board.setPriority(req.slug, priority as Priority, req.project)

  emit(
    { ok: true, id: next.id, title: next.title, status: next.status, priority: next.priority },
    `需求：${next.title}（${next.id}）\n状态：${next.status}${
      next.priority ? ` · 优先级：${next.priority}` : ''
    }`,
  )
}

async function cmdReqLink(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    feishu: { type: 'string', multiple: true },
    mr: { type: 'string', multiple: true },
    ext: { type: 'string', multiple: true },
  })
  if (bool(values.help)) return out(USAGE['req link'])

  const id = required(positionals[0], 'Missing requirement id (req-…)', USAGE['req link'])
  const feishuTaskLinks = strs(values.feishu)
  const codeLinks = strs(values.mr)
  const rawExt = strs(values.ext)
  if (!feishuTaskLinks.length && !codeLinks.length && !rawExt.length) {
    throw new UsageError('Pass at least one kind of link (--feishu / --mr / --ext)', USAGE['req link'])
  }
  const extLinks = rawExt.map((item) => {
    const at = item.indexOf('=')
    if (at < 1) throw new Error(`--ext expects "<detail>=<url>": ${item}`)
    return { detail: item.slice(0, at).trim(), url: item.slice(at + 1).trim() }
  })

  const board = db()
  board.syncProjects()
  const req = findById(id)

  // append, never replace: this command only adds to the lists; deleting stays out of the CLI
  const mergedExt = [...req.extLinks]
  for (const e of extLinks) {
    if (!mergedExt.some((x) => x.url === e.url)) mergedExt.push(e)
  }
  const next = board.setLinks(
    req.slug,
    {
      ...(feishuTaskLinks.length
        ? { feishuTaskLinks: [...new Set([...req.feishuTaskLinks, ...feishuTaskLinks])] }
        : {}),
      ...(codeLinks.length ? { codeLinks: [...new Set([...req.codeLinks, ...codeLinks])] } : {}),
      ...(extLinks.length ? { extLinks: mergedExt } : {}),
    },
    req.project,
  )

  const line = (label: string, list: string[]) => `${label}（${list.length}）：${list.join('、') || '（空）'}`
  emit(
    {
      ok: true,
      id: next.id,
      title: next.title,
      feishuTaskLinks: next.feishuTaskLinks,
      codeLinks: next.codeLinks,
      extLinks: next.extLinks,
    },
    [
      `需求：${next.title}（${next.id}）`,
      line('飞书任务', next.feishuTaskLinks),
      line('代码链接', next.codeLinks),
      line('扩展链接', next.extLinks.map((l) => `${l.detail} ${l.url}`)),
    ].join('\n'),
  )
}

async function cmdWtNew(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    repo: { type: 'string' },
    branch: { type: 'string' },
    base: { type: 'string' },
    short: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['wt new'])

  const requirementId = required(positionals[0], 'Missing requirement id (req-…)', USAGE['wt new'])
  const repo = str(values.repo)?.trim()
  const branch = str(values.branch)?.trim()
  if (!repo) throw new UsageError('Missing --repo (repo name or main checkout path)', USAGE['wt new'])
  if (!branch) throw new UsageError('Missing --branch (branch name)', USAGE['wt new'])
  const base = str(values.base)
  const short = str(values.short)

  const board = db()
  board.syncProjects()
  const req = findById(requirementId)
  if (!existsSync(req.path)) throw new Error(`Requirement dir does not exist: ${req.path}`)

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
    // the dir is already created — do not roll back; a retry adopts it and reads the same id from its AGENTS.md
    throw new Error(
      `Failed to register: ${(err as Error).message}\n` +
        `The worktree dir is already created (${provision.path}, its id lives in its AGENTS.md); run easy-flow wt new again to finish the registration.`,
    )
  }

  emit(
    {
      ok: true,
      id,
      requirementId: req.id,
      repo: target.repo,
      branch,
      path: provision.path,
      main: target.main,
      created: provision.created,
      branchCreated: provision.branchCreated,
    },
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
        ? `在这个目录里取上下文：easy-flow context ${id}`
        : `注意：目录里已有一份不是 easy-flow 写的 AGENTS.md，没动它，${id} 因此没落进文件。` +
          `顺着软链 requirement.md 能走到需求目录，从那份 AGENTS.md 的 frontmatter 拿需求 id，再 easy-flow context 列出它的 worktree 对号入座。`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function cmdWtRm(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, { force: { type: 'boolean' } })
  if (bool(values.help)) return out(USAGE['wt rm'])

  const id = required(positionals[0], 'Missing worktree id (wt-…)', USAGE['wt rm'])
  const board = db()
  board.syncProjects()
  const wt = board.worktreeById(id)
  if (!wt) throw new Error(`Worktree not found: ${id}`)

  const result = await deprovisionWorktree({
    path: wt.path,
    main: wt.main,
    branch: wt.branch,
    force: bool(values.force),
  })
  board.removeWorktree(wt.id)

  emit(
    {
      ok: true,
      id: wt.id,
      path: wt.path,
      branch: wt.branch,
      main: wt.main,
      discarded: result.discarded.length,
      missing: result.missing,
    },
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
}

async function cmdReq(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.req)
  if (!action) throw new UsageError('req needs a subcommand: new / set / link', GROUP_USAGE.req)
  if (action === 'new') return cmdReqNew(argv)
  if (action === 'set') return cmdReqSet(argv)
  if (action === 'link') return cmdReqLink(argv)
  throw new UsageError(`Unknown subcommand: req ${action}`, GROUP_USAGE.req)
}

async function cmdWt(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.wt)
  if (!action) throw new UsageError('wt needs a subcommand: new / rm', GROUP_USAGE.wt)
  if (action === 'new') return cmdWtNew(argv)
  if (action === 'rm') return cmdWtRm(argv)
  throw new UsageError(`Unknown subcommand: wt ${action}`, GROUP_USAGE.wt)
}

async function run(argv: string[]): Promise<void> {
  const [group, action, ...rest] = argv
  if (!group || group === '--help' || group === '-h') return out(ROOT_USAGE)
  if (group === '--version' || group === '-v') return out(VERSION)
  if (group === 'context') return cmdContext(argv.slice(1))
  if (group === 'dir') return cmdDir(argv.slice(1))
  if (group === 'project') return cmdProject(action, rest)
  if (group === 'req') return cmdReq(action, rest)
  if (group === 'wt') return cmdWt(action, rest)
  throw new UsageError(`Unknown command: ${group}`, ROOT_USAGE)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  asJson = argv.includes('--json')
  try {
    await run(argv.filter((a) => a !== '--json'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (asJson) {
      out(JSON.stringify({ error: message }))
    } else {
      process.stderr.write(`error: ${message}\n`)
      if (err instanceof UsageError && err.usage) process.stderr.write(`\n${err.usage}\n`)
    }
    process.exitCode = err instanceof UsageError ? 2 : 1
  }
}

await main()
