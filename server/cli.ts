/**
 * easy-flow CLI: for agents and humans in a terminal — read context, create projects and
 * requirements, manage worktrees.
 *
 * Plain text by default (cheap for humans and agents to read); add --json for scripts.
 * Identity is explicit only — ids live in the AGENTS.md frontmatter of requirement and
 * worktree dirs. Never guessed from cwd or env: a wrong guess writes state onto another
 * requirement, while an unknown id just errors out.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, readConfig } from './config.ts'
import {
  createProjectDir,
  createRequirementDir,
  createTodoDoc,
  newWorktreeId,
  setTodoSummary,
  setTodoTitle,
  titleIsSlug,
} from './convention.ts'
import {
  BoardDatabase,
  PRIORITIES,
  SESSION_AGENTS,
  STATUSES,
  TODO_CHANNELS,
  TODO_SOURCES,
  TODO_STATUSES,
  isOpenTodo,
  todoAgeDays,
  type CodeLink,
  type Priority,
  type Requirement,
  type Session,
  type SessionAgent,
  type Status,
  type Todo,
  type TodoStatus,
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

function cliVersion(): string {
  if (process.env.EASY_FLOW_VERSION) return process.env.EASY_FLOW_VERSION
  try {
    return createRequire(import.meta.url)('../package.json').version as string
  } catch {
    return '0.0.0'
  }
}

const VERSION = cliVersion()

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
    w.missing ? '（目录已失联，可 easy-flow wt rm）' : ''
  }`
}

/**
 * 各 agent 把自己的会话 id 放在哪个环境变量里。agent 自己跑这条命令时，
 * 值就在它的环境里——所以 --id 可以不传，由这里代它认领。
 */
const SESSION_ENV: Record<SessionAgent, string[]> = {
  claude: ['CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'],
  codex: ['CODEX_THREAD_ID'],
  cursor: ['CURSOR_CONVERSATION_ID'],
  chengxiaobang: ['CHENGXIAOBANG_SESSION_ID'],
}

/**
 * desktop 应用的会话 deeplink。推导不出来的（终端里的 claude、cursor 的本地会话）返回空串：
 * 链接格式是各应用自己的事，猜错了比没有更糟；调用方可以用 --link 覆盖。
 */
function sessionLink(agent: SessionAgent, session: string): string {
  if (agent === 'codex') return `codex://threads/${session}`
  // 程小帮当前的系统深链只会聚焦窗口；同一链接在客户端支持 session 路由后可直接打开会话
  if (agent === 'chengxiaobang') return `chengxiaobang://session/${session}`
  // claude 的 desktop（Code 标签页）会话 id 形如 local_…；终端会话是裸 uuid，desktop 里打不开
  if (agent === 'claude' && session.startsWith('local_')) {
    return `claude://claude.ai/epitaxy/${session}`
  }
  return ''
}

// 会话一行；cwd 命中当前工作区时标出来，一眼看出哪个会话就在这儿干活
function sessionLine(s: Session, cwd = ''): string {
  const title = s.title ? `  ${s.title}` : ''
  const here = cwd && s.cwd === cwd ? '（本工作区）' : ''
  const where = s.cwd ? `  ${s.cwd}` : ''
  const link = s.link ? `\n  ${s.link}` : ''
  return `- ${s.agent}  ${s.session}${title}${here}${where}${link}`
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
    // 子需求带状态：接手父需求时，「这串活还剩几块」是决定先干什么的第一件事。
    // 全完成就再点一句——父需求不会自己回头看子需求，这一步只能在这里说
    const tip =
      allDone(children) && req.status !== '已完成'
        ? `\n\n子需求已全部完成——这条需求自己没有别的活就一并收尾：easy-flow req set ${req.id} --status 已完成`
        : ''
    blocks.push(
      `## 子需求（${children.length}）\n${children.map((r) => `${requirementLine(r)}  ${r.status}`).join('\n')}${tip}`,
    )
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

// One requirement per line, for the ancestor / child lists
function requirementLine(r: Requirement): string {
  return `- ${r.id || '（无 id）'}  ${r.slug}  ${r.title}`
}

interface TodoGroups {
  explicit: Todo[]
  candidate: Todo[]
}

/**
 * 待办放过这么多天还没归属就该处置了：做、不做、还是归到某条需求。
 * 只用来标「超期」，不改任何状态——到点只负责把人叫到跟前，决定仍由人做。
 */
const TODO_STALE_DAYS = 7

/**
 * 每段最多列几条。
 * context 的主体仍是需求本身，待办只占末尾一小截。
 */
const TODO_BLOCK_LIMIT = 5

// 一段待办的 id 清单：超出上限只报总数，不把它铺成第二个列表
function todoIds(todos: Todo[]): string {
  const ids = todos
    .slice(0, TODO_BLOCK_LIMIT)
    .map((t) => t.id)
    .join(' ')
  return todos.length > TODO_BLOCK_LIMIT ? `${ids} 等 ${todos.length} 条` : ids
}

/**
 * 开工时看得见的待办。两段分开，因为它们要人做的事不一样：
 *   显式归属 —— 这条需求名下未完成的，直接去做
 *   候选归属 —— 来源会话在这条需求上，但指针没回填。只是推断，得人确认
 * 全局的三种（无归属 / 悬空 / 归属需求已完成）见 todoSection。
 */
function todoBlock({ explicit, candidate }: TodoGroups, reqId: string): string[] {
  const explicitOpen = explicit.filter(isOpenTodo)
  const candidateOpen = candidate.filter(isOpenTodo)
  const blocks: string[] = []

  if (explicitOpen.length) {
    blocks.push(
      `## 待办（${explicitOpen.length}）\n${explicitOpen
        .slice(0, TODO_BLOCK_LIMIT)
        .map((t) => todoLine(t))
        .join('\n')}\n` +
        `做完一条就置 done：easy-flow todo set ${todoIds(explicitOpen)} --status done`,
    )
  }
  if (candidateOpen.length) {
    blocks.push(
      `## 待办 · 归属未确认（${candidateOpen.length}）\n` +
        `${candidateOpen
          .slice(0, TODO_BLOCK_LIMIT)
          .map((t) => todoLine(t))
          .join('\n')}\n` +
        `来源会话登记在本需求上，但待办自己没写归属——确认是这条需求的活就补上：\n` +
        `  easy-flow todo set ${todoIds(candidateOpen)} --req ${reqId}\n` +
        '不是这条需求的活，就归到它该去的那条需求，或者不做（--status cancelled）。',
    )
  }
  return blocks
}

// 无归属那批的口径：只算未完成的，超期与最老天数都从这批里数
function orphanStats(orphans: Todo[]): { open: Todo[]; overdue: Todo[]; oldestDays: number } {
  const open = orphans
    .filter(isOpenTodo)
    .sort((a, b) => todoAgeDays(b.created) - todoAgeDays(a.created))
  return {
    open,
    overdue: open.filter((t) => todoAgeDays(t.created) >= TODO_STALE_DAYS),
    oldestDays: open.length ? todoAgeDays(open[0].created) : 0,
  }
}

/**
 * 无归属的存量：不属于任何需求，也推不出归属。
 * 一行说清有几条、最老多久、是哪几条。
 */
function orphanLine(orphans: Todo[]): string {
  const { open, overdue, oldestDays } = orphanStats(orphans)
  if (!open.length) return ''
  return (
    `## 无归属待办（${open.length}，超期 ${overdue.length}）\n` +
    `最老 ${oldestDays} 天：${todoIds(open)}\n` +
    `不挂在任何需求上，也没法从会话推出归属。逐条处置：做 → todo set <id> --status in_progress；` +
    `不做 → --status cancelled；要交付就立成需求 → easy-flow todo promote <id> --project <项目>`
  )
}

// 指针悬空是全局状态：不属于任何一条现存需求，不跟需求走
function staleLine(stale: Todo[]): string {
  const open = stale.filter(isOpenTodo)
  if (!open.length) return ''
  const lines = open
    .slice(0, TODO_BLOCK_LIMIT)
    .map((t) => `${todoLine(t)}  → 指向 ${t.requirementId}（库里已没有这条需求）`)
  return (
    `## 待办 · 指针悬空（${open.length}）\n${lines.join('\n')}\n` +
    `重新挂到一条存在的需求上：easy-flow todo set ${todoIds(open)} --req <req-…>；不做就 --status cancelled。`
  )
}

// 需求已完成、待办还开着：收尾时没一并了结留下的假线索
function finishedLine(todos: Todo[]): string {
  const open = todos.filter(isOpenTodo)
  if (!open.length) return ''
  const lines = open
    .slice(0, TODO_BLOCK_LIMIT)
    .map((t) => `${todoLine(t)}  → 归属 ${t.requirementId} 已完成`)
  const command =
    open.length <= TODO_BLOCK_LIMIT
      ? `一并了结：easy-flow todo set ${todoIds(open)} --status done`
      : `先 easy-flow todo list --status todo 逐条收，或分批 todo set ${todoIds(open)} --status done`
  return `## 待办 · 归属需求已完成（${open.length}）\n${lines.join('\n')}\n${command}`
}

/**
 * context 末尾的待办段：本需求的两档 + 三种全局点名。
 * 只算一次，块与 --json 共用同一份结果。
 */
function todoSection(board: BoardDatabase, reqId: string | null): {
  groups: TodoGroups | null
  orphans: Todo[]
  blocks: string[]
} {
  const groups = reqId ? board.todosForRequirement(reqId) : null
  const orphans = board.orphanTodos()
  const blocks = [
    ...(reqId && groups ? todoBlock(groups, reqId) : []),
    orphanLine(orphans),
    staleLine(board.stalePointerTodos()),
    finishedLine(board.finishedRequirementTodos()),
  ].filter(Boolean)
  return { groups, orphans, blocks }
}

/**
 * 需求收尾时回头看待办：名下还有未完成的就点一句，超期的无归属也点一句。
 * 与父需求提示同一套道理——只提示、不改状态，收不收由人判。
 */
function todoHint({ explicit, candidate }: TodoGroups, reqId: string): string {
  const open = [...explicit, ...candidate].filter(isOpenTodo)
  if (!open.length) return ''
  const command =
    open.length <= TODO_BLOCK_LIMIT
      ? `收尾时一并了结：easy-flow todo set ${todoIds(open)} --status done`
      : `收尾时一并了结：easy-flow todo list --req ${reqId}，再分批 todo set --status done`
  return `这条需求名下还有 ${open.length} 条未完成待办（${todoIds(open)}）——${command}`
}

// 收尾是必做的处置点：顺手把超期还没人管的无归属待办也顶到眼前
function overdueOrphanHint(orphans: Todo[]): string {
  const { overdue } = orphanStats(orphans)
  if (!overdue.length) return ''
  return (
    `另有 ${overdue.length} 条无归属待办已超期（${todoIds(overdue)}）——三选一：` +
    '归到某条需求（todo set <id> --req <req-…>）/ 立成新需求（todo promote <id> --project <项目>）/ ' +
    '不做（todo set <id> --status cancelled）'
  )
}

// 会话块：这条需求上登记了哪些 agent 会话。cwd 传当前工作区时，命中它的会话会被标出来
function sessionBlock(sessions: Session[], cwd = ''): string[] {
  if (!sessions.length) return []
  return [`## 会话（${sessions.length}）\n${sessions.map((s) => sessionLine(s, cwd)).join('\n')}`]
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
  easy-flow req new|set|link|session …  新建需求 / 改状态优先级 / 追加链接 / 登记 agent 会话
  easy-flow wt new|rm …          开 / 删工作区（git worktree）
  easy-flow todo new|set|list …  全局待办：记一条 / 改状态 / 看待办

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
中文标题推不出目录名，需要显式给 --slug。
标题要写成短句说清「在做什么」，不能等于目录名——看板上它是卡片上唯一能扫的东西。`,

  'req set': `用法：easy-flow req set <id> [--status <澄清|执行中|Review|已完成>] [--priority <p0|p1|p2|p3|"">] [--json]

传了哪个改哪个，都没传会报错。--priority "" 清空优先级。`,

  'req link': `用法：easy-flow req link <id> [--feishu <url>] [--mr <url>|<别名>=<url>>] [--ext "<描述>=<url>"] [--json]

三类链接都可重复传，只增不删：同一字段合并去重，已有链接不会被顶掉。
--ext 的描述与链接按第一个 = 分隔；--mr 同理，别名可省——第一个 = 前面带 :// 就整条当 URL。
同一条链接再传一次只更新别名（这次没给别名就留着旧的）。`,

  'req session': `用法：easy-flow req session add <req-id> --agent <claude|codex|cursor|chengxiaobang> [--id <会话 id>] [--title <标题>] [--cwd <目录>] [--link <url>] [--json]
       easy-flow req session rm <req-id> --agent <…> --id <会话 id> [--json]
       easy-flow req session ls [<req-id>] [--json]

把 agent 会话登记到需求上（只存库，不写进需求目录），看板据此一键回到那个会话。
--id 省略时按 agent 从环境变量取：claude → CLAUDE_CODE_HOST_SESSION_ID / CLAUDE_CODE_SESSION_ID，
codex → CODEX_THREAD_ID，cursor → CURSOR_CONVERSATION_ID，chengxiaobang → CHENGXIAOBANG_SESSION_ID；
一个都没设就报错，不静默写空。
--cwd 缺省用当前目录。--link 是 desktop 应用的 deeplink，缺省按 agent 与 id 推导：
codex → codex://threads/<id>，claude 的 local_ 会话 → claude://claude.ai/epitaxy/<id>，
chengxiaobang → chengxiaobang://session/<id>；cursor 与终端里的 claude 没有会话级 deeplink，只存 id。
同一个会话重复 add 是幂等的：只刷新 title / cwd / link 与时间，不会长出第二条。`,

  'wt new': `用法：easy-flow wt new <req-id> --repo <仓库> --branch <分支> [--base <起点>] [--short <短名>] [--json]

在主 checkout 旁边建 <仓库>.<分支>：写身份文件 AGENTS.md、建 requirement.md 与 design/ 软链，并登记。
--repo 传仓库名（在仓库根下找）或主 checkout 的绝对路径；--base 缺省用主 checkout 的 HEAD。
同路径重复调用是幂等的；--short 是涉及仓库表里的短名，用来给设计目录 docs/<短名>/ 命名并展示。`,

  'wt rm': `用法：easy-flow wt rm <wt-id> [--force] [--json]

删目录、git 登记与 easy-flow 记录，分支保留。有未提交改动会拒绝，--force 丢弃后强删。`,

  'todo new': `用法：easy-flow todo new <标题> [--source <feishu|chat|agent|manual>] [--session <会话>]
       [--channel <at_me|p2p>] [--from <来源人>] [--chat <群/会话名>] [--ref <去重键>]
       [--req <req-…>] [--link <url>] [--at <yyyy-mm-dd HH:mm>] [--summary <可恢复现场的上下文>]
       [--status <todo|in_progress>] [--json]

待办是全局的，不挂在项目下。id 按首次入库日自动编号（T-YYYYMMDD-NNN）。
--summary 要写成"下一个 agent 只看这一条就能接手"：进度、下一步、完成标准、关键 ID、证据入口；
只写现象的口号不算数。--ref 重复时会报出已有条目，不再新建。
--req 是这条待办归属的需求：还没立项就写一条现有的需求也算——不要求先新建需求。
归属、候选（由来源会话推出）与无归属的处置见 todo skill。`,

  'todo set': `用法：easy-flow todo set <id>… [--status <todo|in_progress|done|cancelled>] [--title <标题>]
       [--summary <上下文>] [--source …] [--session …] [--channel …] [--from …] [--chat …]
       [--ref …] [--req <req-…>] [--link …] [--at …] [--json]

传了哪个改哪个，都没传会报错。--title / --summary 改的是 md 的内容（改完自动同步回库），
其余字段只归库。传空串表示清空该字段。--req 是归属的需求；不做（放弃）用 --status cancelled。
一次可以给多个 id（收尾时成批置 done / cancelled），但 --title / --summary 只能配一条。`,

  'todo list': `用法：easy-flow todo list [--status <todo|in_progress|done|cancelled>] [--source <…>] [--req <req-…>]
       [--session <会话 id|链接>] [--orphan] [--all] [--limit <n>] [--json]

默认只列未完成的（todo / in_progress）；--all 连已完成的一起列。按最近更新排，行尾带停留天数。
--req 只看挂在这条需求上的；--session 按来源会话反查（需求收尾时一次收干净）；
--orphan 只看无归属的（没写 --req，也推不出归属）。`,

  'todo show': `用法：easy-flow todo show <id> [--json]

列出这条待办的元数据、md 文件路径与全文。`,

  'todo promote': `用法：easy-flow todo promote <id> --project <项目> [--slug <目录名>] [--title <标题>] [--json]

把一条待办立项成需求，并把归属指针回填——两步合成一次。
标题与摘要沿用待办的（摘要即交接文），--title / --slug 可覆盖。已挂需求的待办会报错并指出那条需求。`,

  'todo import': `用法：easy-flow todo import <目录> [--dry-run] [--json]

把旧 todo 板的按天文件（<目录>/yyyy-mm-dd.md）搬进看板：只搬未完成的（todo / in_progress），
一条一个 md 写进 <数据目录>/_todos/，元数据入库；已完成的留在原处不动。
id 与文件原样保留，已入库的跳过，所以重复跑是安全的。`,
}

const GROUP_USAGE = {
  project: USAGE.project,
  req: [USAGE['req new'], USAGE['req set'], USAGE['req link'], USAGE['req session']].join('\n\n'),
  wt: [USAGE['wt new'], USAGE['wt rm']].join('\n\n'),
  todo: [
    USAGE['todo new'],
    USAGE['todo set'],
    USAGE['todo list'],
    USAGE['todo show'],
    USAGE['todo promote'],
    USAGE['todo import'],
  ].join('\n\n'),
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
    // 会话挂在需求上，工作区视图里照样列出来，并标出哪个会话就在这个目录里干活
    const sessions = board.listSessions(req.id)
    view.blocks.push(...sessionBlock(sessions, wt.path))
    // 待办跟着需求走：在工作区里开工，与在需求目录里开工看到的是同一批
    const todos = todoSection(board, req.id)
    view.blocks.push(...todos.blocks)
    return emit(
      {
        kind: 'worktree',
        worktree: wt,
        sessions,
        ...view.data,
        siblings,
        todoGroups: todos.groups,
        orphanTodos: todos.orphans,
      },
      view.blocks.join('\n\n'),
    )
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
    const sessions = board.listSessions(req.id)
    view.blocks.push(...sessionBlock(sessions))
    const todos = todoSection(board, req.id)
    view.blocks.push(...todos.blocks)
    return emit(
      {
        kind: 'requirement',
        sessions,
        ...view.data,
        worktrees: wts,
        todoGroups: todos.groups,
        orphanTodos: todos.orphans,
      },
      view.blocks.join('\n\n'),
    )
  }

  const view = projectView(key)
  const todos = todoSection(board, null)
  emit(
    { kind: 'project', ...view.data, orphanTodos: todos.orphans },
    [...view.blocks, ...todos.blocks].join('\n\n'),
  )
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
  if (titleIsSlug(title, slug)) {
    throw new UsageError(
      `Title repeats the directory name, which tells nobody what the requirement does: ${title}. Write it as a short phrase instead — what it does, and where or why.`,
      USAGE['req new'],
    )
  }
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

  // 刚收掉最后一个子需求时提一句父需求，但不替它改状态——父需求自己可能还有整体验收
  const hint = status === '已完成' && req.status !== '已完成' ? parentHint(board, next) : ''
  // 收尾时待办也回头看一眼：只提示，不改状态。与父需求提示同一套道理
  const todoReminder =
    status === '已完成' || status === 'Review'
      ? [todoHint(board.todosForRequirement(next.id), next.id), overdueOrphanHint(board.orphanTodos())]
          .filter(Boolean)
          .join('\n')
      : ''

  emit(
    {
      ok: true,
      id: next.id,
      title: next.title,
      status: next.status,
      priority: next.priority,
      parentHint: hint || undefined,
      todoHint: todoReminder || undefined,
    },
    `需求：${next.title}（${next.id}）\n状态：${next.status}${
      next.priority ? ` · 优先级：${next.priority}` : ''
    }${hint ? `\n${hint}` : ''}${todoReminder ? `\n${todoReminder}` : ''}`,
  )
}

/**
 * 子需求全完成时回头看一眼父需求：只提示，不动父需求的状态。
 * 父需求自己可能还有整体验收——它不是一个纯归集点，自动跟着关等于把它谎报成完成，
 * 收不收由人看着办。
 */
function parentHint(board: BoardDatabase, child: Requirement): string {
  if (!child.parentId) return ''
  // siblings 按 parent_id 查，必然含 child 自己，不会是空数组
  const siblings = board.children(child.parentId)
  if (!allDone(siblings)) return ''
  const parent = board.byId(child.parentId)
  if (!parent || parent.status === '已完成') return ''
  return `父需求「${parent.title}」的 ${siblings.length} 个子需求已全部完成——它自己没有别的活就一并收尾：easy-flow req set ${parent.id} --status 已完成`
}

// 这批需求是不是都到了终态。「全完成」只有这一处定义，`req set` 与 `context` 共用
function allDone(reqs: Requirement[]): boolean {
  return reqs.every((r) => r.status === '已完成')
}

/**
 * --mr 收两种写法：纯 URL，或 "<别名>=<url>"。
 * 第一个 = 前面带 :// 就整条当 URL（协议交给写侧校验），URL 自带的 = 不会被拆成别名。
 */
function parseMrArg(item: string): CodeLink {
  const at = item.indexOf('=')
  const head = at < 0 ? item : item.slice(0, at)
  if (head.includes('://')) return { label: '', url: item }
  if (at < 1) throw new Error(`--mr expects a url or "<别名>=<url>": ${item}`)
  return { label: item.slice(0, at).trim(), url: item.slice(at + 1).trim() }
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
  const codeLinks = strs(values.mr).map(parseMrArg)
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
  const mergedCode = req.codeLinks.map((l) => ({ ...l }))
  for (const l of codeLinks) {
    const hit = mergedCode.find((x) => x.url === l.url)
    if (!hit) mergedCode.push(l)
    else if (l.label) hit.label = l.label
  }
  const next = board.setLinks(
    req.slug,
    {
      ...(feishuTaskLinks.length
        ? { feishuTaskLinks: [...new Set([...req.feishuTaskLinks, ...feishuTaskLinks])] }
        : {}),
      ...(codeLinks.length ? { codeLinks: mergedCode } : {}),
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
      line('代码链接', next.codeLinks.map((l) => (l.label ? `${l.label} ${l.url}` : l.url))),
      line('扩展链接', next.extLinks.map((l) => `${l.detail} ${l.url}`)),
    ].join('\n'),
  )
}

// 登记会话时把 agent 的原生会话 id 认出来：--id 优先，否则按 agent 读它的环境变量
function sessionIdFrom(values: Record<string, unknown>, agent: SessionAgent): string {
  const explicit = str(values.id)?.trim()
  if (explicit) return explicit
  const names = SESSION_ENV[agent]
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(
    `Missing --id, and none of ${names.join(' / ')} is set in this shell. ` +
      `在 ${agent} 的会话里跑这条命令，或显式 --id <会话 id>`,
  )
}

async function cmdReqSessionAdd(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    agent: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    cwd: { type: 'string' },
    link: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['req session'])

  const reqId = required(positionals[0], 'Missing requirement id (req-…)', USAGE['req session'])
  const agent = required(str(values.agent), 'Missing --agent (claude / codex / cursor / chengxiaobang)', USAGE['req session']) as SessionAgent
  oneOf(agent, SESSION_AGENTS, 'agent')
  const session = sessionIdFrom(values, agent)
  const title = str(values.title)?.trim() ?? ''
  const cwd = str(values.cwd)?.trim() || process.cwd()
  const link = str(values.link)?.trim() || sessionLink(agent, session)

  const board = db()
  board.syncProjects()
  const req = findById(reqId)
  const saved = board.addSession({ requirementId: req.id, agent, session, title, cwd, link })

  emit(
    { ok: true, ...saved },
    [
      `已登记会话到需求「${req.title}」（${req.id}）`,
      sessionLine(saved),
      saved.link
        ? '看板详情页点这一行即在 desktop 应用里打开；重复登记只刷新字段。'
        : '这个 agent 没有会话级 deeplink，看板上只展示与复制会话 id。',
    ].join('\n'),
  )
}

async function cmdReqSessionRm(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, { agent: { type: 'string' }, id: { type: 'string' } })
  if (bool(values.help)) return out(USAGE['req session'])

  const reqId = required(positionals[0], 'Missing requirement id (req-…)', USAGE['req session'])
  const agent = required(str(values.agent), 'Missing --agent (claude / codex / cursor / chengxiaobang)', USAGE['req session']) as SessionAgent
  oneOf(agent, SESSION_AGENTS, 'agent')
  const session = required(str(values.id), 'Missing --id (the session id)', USAGE['req session'])

  const board = db()
  board.syncProjects()
  const req = findById(reqId)
  const removed = board.removeSession(agent, session)
  if (!removed) throw new Error(`Session not found on ${req.id}: ${agent} ${session}`)

  emit(
    { ok: true, requirementId: req.id, agent, session },
    `已从需求「${req.title}」摘掉会话 ${agent} ${session}（会话本身没动）`,
  )
}

async function cmdReqSessionLs(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {})
  if (bool(values.help)) return out(USAGE['req session'])

  const board = db()
  board.syncProjects()
  const reqId = str(positionals[0])?.trim()
  if (!reqId) {
    const sessions = board.listSessions()
    const groups = new Map<string, Session[]>()
    for (const s of sessions) {
      groups.set(s.requirementId, [...(groups.get(s.requirementId) ?? []), s])
    }
    const blocks = [...groups].map(([id, list]) => {
      const req = board.byId(id)
      const head = req ? `${req.slug}（${id}）` : `（需求已不在库里：${id}）`
      return `## ${head}\n${list.map((s) => sessionLine(s)).join('\n')}`
    })
    return emit(
      { sessions, total: sessions.length },
      blocks.length ? `会话（${sessions.length}）：\n\n${blocks.join('\n\n')}` : '还没有登记过任何会话。',
    )
  }

  const req = findById(reqId)
  const sessions = board.listSessions(req.id)
  emit(
    { requirementId: req.id, sessions, total: sessions.length },
    sessions.length
      ? `需求「${req.title}」的会话（${sessions.length}）：\n${sessions.map((s) => sessionLine(s)).join('\n')}`
      : `需求「${req.title}」上还没有登记会话；在会话里跑 easy-flow req session add ${req.id} --agent <claude|codex|cursor|chengxiaobang>`,
  )
}

async function cmdReqSession(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(USAGE['req session'])
  if (!action) throw new UsageError('req session needs a subcommand: add / rm / ls', USAGE['req session'])
  if (action === 'add') return cmdReqSessionAdd(argv)
  if (action === 'rm') return cmdReqSessionRm(argv)
  if (action === 'ls') return cmdReqSessionLs(argv)
  throw new UsageError(`Unknown subcommand: req session ${action}`, USAGE['req session'])
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
      { cause: err },
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

// ------------------------------------------------------------------ 待办

// new 与 set 共用的元数据选项
const TODO_FIELDS = {
  source: { type: 'string' },
  session: { type: 'string' },
  channel: { type: 'string' },
  from: { type: 'string' },
  chat: { type: 'string' },
  ref: { type: 'string' },
  req: { type: 'string' },
  link: { type: 'string' },
  at: { type: 'string' },
} as const

interface TodoPatch {
  source?: string
  session?: string
  channel?: string
  origin?: string
  chat?: string
  ref?: string
  requirementId?: string
  link?: string
  happened?: string
}

// 把命令行取值收成补丁：没传的字段留 undefined（表示不动），空串表示清空
function todoPatch(values: Record<string, unknown>): TodoPatch {
  const patch: TodoPatch = {}
  const put = (key: keyof TodoPatch, value: string | undefined) => {
    if (value !== undefined) patch[key] = value
  }
  const link = str(values.link)?.trim()
  if (link && !/^https?:\/\//i.test(link)) throw new Error(`Link must start with http(s)://: ${link}`)
  put('source', str(values.source)?.trim())
  put('session', str(values.session))
  put('channel', str(values.channel)?.trim())
  put('origin', str(values.from))
  put('chat', str(values.chat))
  put('ref', str(values.ref)?.trim())
  put('requirementId', str(values.req)?.trim())
  put('link', link)
  put('happened', str(values.at)?.trim())
  return patch
}

// 校验枚举值，报错时列出合法取值——agent 据此就能自己纠正
function oneOf(value: string, valid: readonly string[], what: string): void {
  if (!valid.includes(value)) throw new Error(`Unknown ${what}: ${value}. Valid: ${valid.join(', ')}`)
}

// --req 只收真实存在的需求 id：写错了需求详情页只会一直空着，不如当场报错
function checkTodoReq(board: BoardDatabase, req: string | undefined): void {
  if (req && !board.byId(req)) {
    throw new Error(`Requirement not found: ${req}. --req 是归属的需求；要新建一条需求用 easy-flow todo promote`)
  }
}

function todoLine(t: Todo): string {
  const who = t.origin || t.chat
  const days = todoAgeDays(t.created)
  const age = days > 0 ? `  ${days}天` : ''
  const overdue = days >= TODO_STALE_DAYS && isOpenTodo(t) ? '  超期' : ''
  return `- ${t.id}  ${t.status.padEnd(11)} ${t.source || '—'}  ${t.title}${who ? `（${who}）` : ''}${age}${overdue}`
}

// 元数据一行一个，new 与 show 共用
function todoHead(t: Todo, file: string): string[] {
  const head = [
    `待办 id：${t.id}`,
    `待办：${t.title}`,
    `状态：${t.status}`,
    `文件：${file}`,
    `来源：${t.source || '（未记）'}${t.channel ? ` · ${t.channel}` : ''}`,
  ]
  if (t.origin) head.push(`来源人：${t.origin}`)
  if (t.chat) head.push(`上下文：${t.chat}`)
  if (t.session) head.push(`会话：${t.session}`)
  if (t.ref) head.push(`去重键：${t.ref}`)
  if (t.requirementId) head.push(`需求：${t.requirementId}`)
  if (t.link) head.push(`链接：${t.link}`)
  if (t.happened) head.push(`源事件时间：${t.happened}`)
  head.push(`入库：${t.created} · 更新：${t.updated}`)
  return head
}

async function cmdTodoNew(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    ...TODO_FIELDS,
    summary: { type: 'string' },
    status: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['todo new'])

  const title = required(positionals[0], 'Missing todo title', USAGE['todo new'])
  const patch = todoPatch(values)
  const status = (str(values.status)?.trim() || 'todo') as TodoStatus
  if (patch.source) oneOf(patch.source, TODO_SOURCES, 'source')
  if (patch.channel) oneOf(patch.channel, TODO_CHANNELS, 'channel')
  oneOf(status, TODO_STATUSES, 'status')

  const summary = str(values.summary) ?? ''
  const board = db()
  board.syncTodos()
  checkTodoReq(board, patch.requirementId)

  // ref 是去重键：命中已有条目就报出它，让调用方去补内容而不是再建一条
  if (patch.ref) {
    const dup = board.todoByRef(patch.ref)
    if (dup) {
      throw new Error(
        `Ref already used by ${dup.id}（${dup.title}）; 要补内容用 easy-flow todo set ${dup.id}`,
      )
    }
  }

  const id = board.nextTodoId()
  const { file } = createTodoDoc(config.dataDir, id, title, summary)
  board.addTodo({ id, title, status, summary, path: file, ...patch })
  // 标题与摘要以 md 为准，同步一次把它们对齐（顺带填上文件时间）
  board.syncTodos()
  const todo = board.todoById(id)!

  emit(
    { ok: true, ...todo },
    [`已记一条待办`, ...todoHead(todo, file), '', '内容写在这个文件里（摘要 = 交接说明，进度往下续）。'].join('\n'),
  )
}

async function cmdTodoSet(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    ...TODO_FIELDS,
    status: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['todo set'])

  const ids = positionals.map((p) => p.trim()).filter(Boolean)
  if (!ids.length) throw new UsageError('Missing todo id (T-…)', USAGE['todo set'])
  const patch = todoPatch(values)
  const status = str(values.status)?.trim()
  const title = str(values.title)?.trim()
  const summary = str(values.summary)
  if (status === undefined && title === undefined && summary === undefined && !Object.keys(patch).length) {
    throw new UsageError('Pass at least one field to change', USAGE['todo set'])
  }
  // 标题与摘要是 md 的正文，一条一份文件；批量只做字段与状态，避免改串
  if (ids.length > 1 && (title !== undefined || summary !== undefined)) {
    throw new UsageError('--title / --summary 一次只能改一条待办', USAGE['todo set'])
  }
  if (status !== undefined) oneOf(status, TODO_STATUSES, 'status')
  if (patch.source) oneOf(patch.source, TODO_SOURCES, 'source')
  if (patch.channel) oneOf(patch.channel, TODO_CHANNELS, 'channel')

  const board = db()
  board.syncTodos()
  checkTodoReq(board, patch.requirementId)
  const unknown = ids.filter((id) => !board.todoById(id))
  if (unknown.length) {
    throw new Error(
      `Todo not found: ${unknown.join(', ')}. id 就是文件名（${join(config.dataDir, '_todos', '<id>.md')}）`,
    )
  }

  for (const id of ids) {
    if (status !== undefined) board.setTodoStatus(id, status as TodoStatus)
    if (Object.keys(patch).length) board.setTodoFields(id, patch)
    // 标题与摘要是 md 的内容：改文件，再由同步带回归库
    if (title !== undefined || summary !== undefined) {
      const { content } = board.readTodoDoc(id)
      let next = content
      if (title !== undefined) next = setTodoTitle(next, title)
      if (summary !== undefined) next = setTodoSummary(next, summary)
      board.writeTodoDoc(id, next)
    }
  }

  const todos = ids.map((id) => board.todoById(id)!)
  if (todos.length === 1) {
    const [todo] = todos
    return emit({ ok: true, ...todo }, [`待办：${todo.title}（${todo.id}）`, `状态：${todo.status}`].join('\n'))
  }
  emit(
    { ok: true, todos },
    [`已更新 ${todos.length} 条待办：`, ...todos.map((t) => `- ${t.id}  ${t.title}  ${t.status}`)].join('\n'),
  )
}

async function cmdTodoList(argv: string[]): Promise<void> {
  const { values } = parse(argv, {
    status: { type: 'string' },
    source: { type: 'string' },
    req: { type: 'string' },
    session: { type: 'string' },
    orphan: { type: 'boolean' },
    all: { type: 'boolean' },
    limit: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['todo list'])

  const status = str(values.status)?.trim()
  const source = str(values.source)?.trim()
  const req = str(values.req)?.trim()
  const session = str(values.session)?.trim()
  if (status !== undefined) oneOf(status, TODO_STATUSES, 'status')
  if (source !== undefined) oneOf(source, TODO_SOURCES, 'source')
  if (req && bool(values.orphan)) throw new UsageError('Pass either --req or --orphan', USAGE['todo list'])
  if (session && (req || bool(values.orphan))) {
    throw new UsageError('Pass --session on its own', USAGE['todo list'])
  }

  const board = db()
  board.syncTodos()
  checkTodoReq(board, req)
  // --session 按会话反查：需求收尾时「这条会话冒出来的活」要能一次收干净
  const all = session ? board.listTodosBySession(session) : board.listTodos(req || undefined)
  const open = all.filter(isOpenTodo)
  let todos = status ? all.filter((t) => t.status === status) : bool(values.all) ? all : open
  if (source) todos = todos.filter((t) => t.source === source)
  // 无归属只算这一个口径；过滤与摘要共用同一次结果，别扫两遍
  const orphans = board.orphanTodos()
  if (bool(values.orphan)) {
    const orphanIds = new Set(orphans.map((t) => t.id))
    todos = todos.filter((t) => orphanIds.has(t.id))
  }

  const limit = Number(str(values.limit) ?? '') || 0
  const shown = limit > 0 ? todos.slice(0, limit) : todos
  const hidden = todos.length - shown.length

  const scope = req
    ? `需求 ${req} 的`
    : session
      ? `会话 ${session} 的`
      : bool(values.orphan)
        ? '无归属的'
        : ''
  const blocks = [
    `${status ? `状态 ${status}` : bool(values.all) ? `${scope}全部待办` : `${scope}未完成的待办`}（${todos.length}）：`,
    shown.map(todoLine).join('\n') || '（无）',
  ]
  if (hidden > 0) blocks.push(`（还有 ${hidden} 条，--limit 调大或加 --status）`)
  if (!status && !bool(values.all) && !req && !session && !bool(values.orphan)) {
    const rest = all.length - open.length
    if (rest > 0) blocks.push(`（已完成/已取消 ${rest} 条，--all 看全部）`)
  }
  // 验收要的那一条：未归属 N、超期 M、最老 K 天
  if (bool(values.orphan)) {
    const stats = orphanStats(orphans)
    blocks.push(`（未归属 ${stats.open.length} 条、其中超期 ${stats.overdue.length} 条、最老 ${stats.oldestDays} 天）`)
  }

  emit(
    {
      todos: shown,
      total: todos.length,
      open: open.length,
      all: all.length,
      orphan: orphans.filter(isOpenTodo).length,
      stale: board.stalePointerTodos().filter(isOpenTodo).length,
      finished: board.finishedRequirementTodos().filter(isOpenTodo).length,
    },
    blocks.join('\n'),
  )
}

async function cmdTodoShow(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {})
  if (bool(values.help)) return out(USAGE['todo show'])

  const id = required(positionals[0], 'Missing todo id (T-…)', USAGE['todo show'])
  const board = db()
  board.syncTodos()
  const todo = board.todoById(id)
  if (!todo) throw new Error(`Todo not found: ${id}`)
  const { path, content } = board.readTodoDoc(id)

  emit(
    { todo, path, content },
    [todoHead(todo, path).join('\n'), `## 内容（${path}）\n\n${content.trim()}`].join('\n\n'),
  )
}

/**
 * 待办立项成需求，并把指针回填——两步合成一次，因为分两步就一定有人忘第二步。
 * 已挂需求的待办直接报错并指出那条需求：重复调用不该长出第二条需求。
 */
async function cmdTodoPromote(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    project: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['todo promote'])

  const id = required(positionals[0], 'Missing todo id (T-…)', USAGE['todo promote'])
  const project = required(str(values.project)?.trim(), 'Missing --project', USAGE['todo promote'])

  const board = db()
  board.syncTodos()
  const todo = board.todoById(id)
  if (!todo) throw new Error(`Todo not found: ${id}`)
  if (todo.requirementId) {
    throw new Error(
      `Todo ${id} already belongs to ${todo.requirementId}. 要换归属用 easy-flow todo set ${id} --req <req-…>`,
    )
  }

  const title = str(values.title)?.trim() || todo.title
  const slug = str(values.slug)?.trim() || deriveSlug(title)
  if (titleIsSlug(title, slug)) {
    throw new UsageError(
      `Title repeats the directory name, which tells nobody what the requirement does: ${title}. 用 --title 或 --slug 改一个`,
      USAGE['todo promote'],
    )
  }
  // 摘要照搬待办的交接文：下一个 agent 读需求时，来源与现场也在
  const created = createRequirementDir(projectRoot(project), slug, title, todo.summary)
  // 建目录与回填指针要一起成立：入库或写指针失败就把刚建的空需求收掉，不留半截
  try {
    board.syncProjects()
    board.setTodoFields(id, { requirementId: created.id })
  } catch (err) {
    rmSync(created.dir, { recursive: true, force: true })
    throw err
  }
  const requirementId = created.id
  const stored = board.byId(requirementId)

  emit(
    {
      ok: true,
      todo: board.todoById(id),
      requirement: { id: requirementId, slug: stored?.slug ?? slug, project, title, dir: created.dir },
    },
    [
      `已立项：${todo.title}（${id}）`,
      `需求 id：${requirementId}`,
      `目录：${created.dir}`,
      `看板状态默认「澄清」。待办已挂到这条需求上。`,
      '',
      `下一步：easy-flow wt new ${requirementId} --repo <仓库> --branch feature-${stored?.slug ?? slug}`,
    ].join('\n'),
  )
}

// 旧 todo 板的一块：`### T-YYYYMMDD-NNN | status` + 若干 `- key: value`
interface LegacyTodo {
  id: string
  status: string
  fields: Record<string, string>
}

/**
 * 解析旧 todo 板的按天文件。字段值可能折行，续行并进上一个字段——
 * 旧文件是手工/agent 写的，不能假设一个字段只占一行。
 */
function parseLegacyTodoFile(text: string): LegacyTodo[] {
  const out: LegacyTodo[] = []
  let current: LegacyTodo | null = null
  let lastKey = ''
  for (const line of text.split('\n')) {
    const head = /^###\s+(T-\d{8}-\d{3})\s*\|\s*(\S+)\s*$/.exec(line)
    if (head) {
      current = { id: head[1], status: head[2], fields: {} }
      lastKey = ''
      out.push(current)
      continue
    }
    if (!current) continue
    const field = /^-\s+([A-Za-z]+):\s*(.*)$/.exec(line)
    if (field) {
      lastKey = field[1]
      current.fields[lastKey] = field[2].trim()
      continue
    }
    if (lastKey && line.trim()) current.fields[lastKey] += ` ${line.trim()}`
  }
  return out
}

async function cmdTodoImport(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, { 'dry-run': { type: 'boolean' } })
  if (bool(values.help)) return out(USAGE['todo import'])

  const dir = required(positionals[0], 'Missing source dir (the old todo board, e.g. ~/todo)', USAGE['todo import'])
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`)
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
  if (!files.length) throw new Error(`No yyyy-mm-dd.md under ${dir}`)

  const dryRun = bool(values['dry-run'])
  const board = db()
  board.syncTodos()

  const created: string[] = []
  const skipped: string[] = []
  let finished = 0
  for (const file of files) {
    for (const entry of parseLegacyTodoFile(readFileSync(join(dir, file), 'utf8'))) {
      // 只搬未完成的：已完成的留在原处当历史，进看板只会淹没真正要做的事
      if (entry.status !== 'todo' && entry.status !== 'in_progress') {
        finished++
        continue
      }
      if (board.todoById(entry.id)) {
        skipped.push(entry.id)
        continue
      }
      created.push(entry.id)
      if (dryRun) continue

      const f = entry.fields
      const title = f.title || entry.id
      const summary = f.summary ?? ''
      const source = f.source ?? ''
      const { file: doc } = createTodoDoc(config.dataDir, entry.id, title, summary)
      board.addTodo({
        id: entry.id,
        title,
        status: entry.status as TodoStatus,
        // 来源只认已知取值：历史文件里可能写过别的，宁可留空也不让导入失败
        source: (TODO_SOURCES as readonly string[]).includes(source) ? source : '',
        session: f.session ?? '',
        channel: f.channel ?? '',
        origin: f.from ?? '',
        chat: f.chat ?? '',
        ref: f.ref ?? '',
        link: f.link ?? '',
        happened: f.at ?? '',
        summary,
        path: doc,
        // 保住原来的时间线，别让 14 条历史条目都挤在"刚刚"
        created: f.updated ?? '',
        updated: f.updated ?? '',
      })
    }
  }

  emit(
    {
      ok: true,
      dryRun,
      created,
      skipped,
      finished,
      sourceDir: dir,
      todosDir: join(config.dataDir, '_todos'),
    },
    [
      dryRun ? `将迁移 ${created.length} 条未完成的待办（--dry-run，没落盘）` : `已迁移 ${created.length} 条未完成的待办`,
      created.length ? `id：${created.join('、')}` : '',
      skipped.length ? `已存在跳过 ${skipped.length} 条：${skipped.join('、')}` : '',
      finished ? `已完成/已取消 ${finished} 条留在原处不动` : '',
      `待办文件目录：${join(config.dataDir, '_todos')}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function cmdTodo(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.todo)
  if (!action) throw new UsageError('todo needs a subcommand: new / set / list / show / promote / import', GROUP_USAGE.todo)
  if (action === 'new') return cmdTodoNew(argv)
  if (action === 'set') return cmdTodoSet(argv)
  if (action === 'list') return cmdTodoList(argv)
  if (action === 'show') return cmdTodoShow(argv)
  if (action === 'promote') return cmdTodoPromote(argv)
  if (action === 'import') return cmdTodoImport(argv)
  throw new UsageError(`Unknown subcommand: todo ${action}`, GROUP_USAGE.todo)
}

async function cmdReq(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.req)
  if (!action) throw new UsageError('req needs a subcommand: new / set / link / session', GROUP_USAGE.req)
  if (action === 'new') return cmdReqNew(argv)
  if (action === 'set') return cmdReqSet(argv)
  if (action === 'link') return cmdReqLink(argv)
  if (action === 'session') return cmdReqSession(argv[0], argv.slice(1))
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
  if (group === 'todo') return cmdTodo(action, rest)
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
