import { TodoState } from '../src/shared/domain.ts'
import { SessionAnalysisState } from '../src/shared/domain.ts'
import { AgentId } from '../src/shared/domain.ts'
import { canOpenWorkspace, workspaceOpenHint } from '../src/shared/agents.ts'
import { requirementStatusLabel } from '../src/shared/i18n.ts'
import { normalizeRequirementStatus } from '../src/shared/domain.ts'
import { getLanguage, isLanguage, setLanguage } from '../src/shared/i18n.ts'
import { RequirementStatus } from '../src/shared/domain.ts'
import { t as tr } from "../src/shared/i18n.ts"
/**
 * easy-flow CLI: for agents and humans in a terminal — read context, create projects and
 * requirements, manage worktrees.
 *
 * Plain text by default (cheap for humans and agents to read); add --json for scripts.
 * Identity is explicit only — a requirement id lives at the top of requirement.md,
 * a worktree id at the top of that worktree's AGENTS.md. Never guessed from cwd or env: a wrong guess writes state onto another
 * requirement, while an unknown id just errors out.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, readConfig } from './config.ts'
import { linkLabel } from '../shared/link.ts'
import {
  SESSION_ANALYSIS_LABELS,
  SESSION_ANALYSIS_STATUSES,
  type SessionAnalysisStatus,
} from '../src/shared/session-analysis.ts'
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
  TAG_LIMIT,
  TODO_CHANNELS,
  TODO_SOURCES,
  TODO_STATUSES,
  isOpenTodo,
  normalizeTags,
  tagKey,
  todoAgeDays,
  type LinkItem,
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
import { reviewWorktree } from './review.ts'
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
const languageArgs = process.argv.slice(2)
const initialLanguageFlag = languageArgs.find(arg => arg.startsWith('--lang='))?.slice(7)
  ?? (languageArgs.includes('--lang') ? languageArgs[languageArgs.indexOf('--lang') + 1] : undefined)
setLanguage(isLanguage(initialLanguageFlag) ? initialLanguageFlag
  : isLanguage(process.env.EASY_FLOW_LANG) ? process.env.EASY_FLOW_LANG : config.language)

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
    tr("Project not found: {0}{1}", [project, known.length ? tr('. Known projects: {0}', [known.join(', ')]) : tr(' (no projects under the data dir yet)')]),
  )
}

function findById(id: string): Requirement {
  const req = db().byId(id)
  if (!req) throw new Error(tr("Requirement not found: {0}. The id lives at the top of the requirement's requirement.md", [id]))
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
  if (!slug) throw new Error(tr("No ASCII letters or digits in the title, cannot derive a dir name: {0}. Pass --slug", [title]))
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
    w.missing ? tr("(directory missing; use easy-flow wt rm)") : ''
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
  // Antigravity 把当前对话 id 注入 agent 的 shell
  antigravity: ['ANTIGRAVITY_CONVERSATION_ID'],
}

/**
 * desktop 应用的会话 deeplink。推导不出来的（终端里的 claude、cursor / antigravity 的本地会话）返回空串：
 * 链接格式是各应用自己的事，猜错了比没有更糟；调用方可以用 --link 覆盖。
 */
function sessionLink(agent: SessionAgent, session: string): string {
  if (agent === AgentId.Codex) return `codex://threads/${session}`
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
  const here = cwd && s.cwd === cwd ? tr("(current workspace)") : ''
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
    tr("Requirement ID: {0}", [req.id]),
    tr("Project: {0}{1}", [req.project, display && display !== req.project ? `（${display}）` : '']),
    tr("Requirement: {0} ({1})", [req.title, req.slug]),
    tr("Requirement directory: {0}", [req.path]),
    tr("Status: {0}{1}", [requirementStatusLabel(req.status), req.priority ? tr(" · Priority: {0}", [req.priority]) : '']),
    tr("Session analysis: {0}", [SESSION_ANALYSIS_LABELS[req.sessionAnalysisStatus]]),
  ]
  if (req.tags.length) head.push(tr("Tags: {0}", [req.tags.join(' · ')]))
  if (req.repos.length) head.push(tr("Repositories: {0}", [req.repos.map((r) => `${r.short}=${r.repo ?? ''}`).join('、')]))
  // context.md follows in full right after, no need to list it twice
  const docs = req.docs.filter((d) => d.name !== 'requirement.md' && d.name !== 'context.md')
  if (docs.length) head.push(tr("Other documents: {0}", [docs.map((d) => d.name).join('、')]))

  const blocks = [head.join('\n')]
  // Hierarchy is how a requirement gets split: a sub-requirement needs its parents in view,
  // a parent needs to see what hangs below it. Only the nearest parent's body is included —
  // going further up is one more `context` call away.
  const board = db()
  const ancestors = board.ancestors(req)
  if (ancestors.length) {
    blocks.push(tr("## Ancestor requirements (nearest first)\n{0}", [ancestors.map(requirementLine).join('\n')]))
    const parentMd = readIfExists(join(ancestors[0].path, 'requirement.md'))
    if (parentMd) blocks.push(tr("## Parent requirement ({0}/requirement.md)\n\n{1}", [ancestors[0].slug, parentMd.trim()]))
  }
  if (convention) blocks.push(tr("## Project conventions ({0})\n\n{1}", [join(root, 'AGENTS.md'), convention.trim()]))
  if (requirementMd) blocks.push(tr("## Requirement (requirement.md)\n\n{0}", [requirementMd.trim()]))
  if (contextMd) blocks.push(tr("## Context (context.md)\n\n{0}", [contextMd.trim()]))
  const children = board.children(req.id)
  if (children.length) {
    // 子需求带状态：接手父需求时，「这串活还剩几块」是决定先干什么的第一件事。
    // 全完成就再点一句——父需求不会自己回头看子需求，这一步只能在这里说
    const tip =
      allDone(children) && req.status !== RequirementStatus.Completed
        ? tr("\n\nAll child requirements are complete. If no other work remains, close this requirement: easy-flow req set {0} --status completed", [req.id])
        : ''
    blocks.push(
      tr("## Child requirements ({0})\n{1}{2}", [children.length, children.map((r) => `${requirementLine(r)}  ${requirementStatusLabel(r.status)}`).join('\n'), tip]),
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
      sessionAnalysisStatus: req.sessionAnalysisStatus,
      priority: req.priority,
      summary: req.summary,
      repos: req.repos,
      tags: req.tags,
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
  return `- ${r.id || tr("(no ID)")}  ${r.slug}  ${r.title}`
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
  return todos.length > TODO_BLOCK_LIMIT ? tr("{0} and {1} items in total", [ids, todos.length]) : ids
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
      tr("## Todos ({0})\n{1}\n", [explicitOpen.length, explicitOpen
        .slice(0, TODO_BLOCK_LIMIT)
        .map((t) => todoLine(t))
        .join('\n')]) +
        tr("Mark finished items done: easy-flow todo set {0} --status done", [todoIds(explicitOpen)]),
    )
  }
  if (candidateOpen.length) {
    blocks.push(
      tr("## Todos with unconfirmed ownership ({0})\n", [candidateOpen.length]) +
        `${candidateOpen
          .slice(0, TODO_BLOCK_LIMIT)
          .map((t) => todoLine(t))
          .join('\n')}\n` +
        tr("The source session belongs to this requirement, but the todo has no owner. Confirm ownership and run:\n") +
        `  easy-flow todo set ${todoIds(candidateOpen)} --req ${reqId}\n` +
        tr("Otherwise assign the correct requirement or cancel it (--status cancelled)."),
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
    tr("## Unassigned todos ({0}, overdue {1})\n", [open.length, overdue.length]) +
    tr("Oldest: {0} days: {1}\n", [oldestDays, todoIds(open)]) +
    tr("No requirement or inferred session owner. Decide for each: work on it → todo set <id> --status in_progress;") +
    tr("cancel it → --status cancelled; or promote it → easy-flow todo promote <id> --project <project>")
  )
}

// 指针悬空是全局状态：不属于任何一条现存需求，不跟需求走
function staleLine(stale: Todo[]): string {
  const open = stale.filter(isOpenTodo)
  if (!open.length) return ''
  const lines = open
    .slice(0, TODO_BLOCK_LIMIT)
    .map((t) => tr("{0} → points to {1} (requirement no longer exists)", [todoLine(t), t.requirementId]))
  return (
    tr("## Todos with missing requirements ({0})\n{1}\n", [open.length, lines.join('\n')]) +
    tr("Assign an existing requirement: easy-flow todo set {0} --req <req-…>; otherwise use --status cancelled.", [todoIds(open)])
  )
}

// 需求已完成、待办还开着：收尾时没一并了结留下的假线索
function finishedLine(todos: Todo[]): string {
  const open = todos.filter(isOpenTodo)
  if (!open.length) return ''
  const lines = open
    .slice(0, TODO_BLOCK_LIMIT)
    .map((t) => tr("{0} → requirement {1} is complete", [todoLine(t), t.requirementId]))
  const command =
    open.length <= TODO_BLOCK_LIMIT
      ? tr("Close together: easy-flow todo set {0} --status done", [todoIds(open)])
      : tr("Run easy-flow todo list --status todo, then close individually or in batches: todo set {0} --status done", [todoIds(open)])
  return tr("## Todos owned by completed requirements ({0})\n{1}\n{2}", [open.length, lines.join('\n'), command])
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
      ? tr("Close remaining work: easy-flow todo set {0} --status done", [todoIds(open)])
      : tr("Check easy-flow todo list --req {0}, then close finished todos in batches with todo set --status done", [reqId])
  return tr("This requirement has {0} unfinished todos ({1}) — {2}", [open.length, todoIds(open), command])
}

// 收尾是必做的处置点：顺手把超期还没人管的无归属待办也顶到眼前
function overdueOrphanHint(orphans: Todo[]): string {
  const { overdue } = orphanStats(orphans)
  if (!overdue.length) return ''
  return (
    tr("There are also {0} overdue unassigned todos ({1}) — choose:", [overdue.length, todoIds(overdue)]) +
    tr("assign a requirement (todo set <id> --req <req-…>) / promote to a requirement (todo promote <id> --project <project>) /") +
    tr("cancel (todo set <id> --status cancelled)")
  )
}

// 会话块：这条需求上登记了哪些 agent 会话。cwd 传当前工作区时，命中它的会话会被标出来
function sessionBlock(sessions: Session[], cwd = ''): string[] {
  if (!sessions.length) return []
  return [tr("## Sessions ({0})\n{1}", [sessions.length, sessions.map((s) => sessionLine(s, cwd)).join('\n')])]
}

/**
 * 有工作区、或状态走到 Review 之后，看板上没有链接等于没有入口可点。
 */
function missingLinks(req: Requirement, hasWorktree: boolean): boolean {
  return req.linkItems.length === 0 && (hasWorktree || req.status === RequirementStatus.Review || req.status === RequirementStatus.Completed)
}

// 登记链接的命令，提示里共用这一句
function linkCommand(id: string): string {
  return tr("easy-flow req link {0} \"<label>=<url>\"", [id])
}

/**
 * 没有链接、又已经开工时，把登记命令打出来。
 */
function linkBlock(req: Requirement, hasWorktree: boolean): string {
  if (!req.linkItems.length) {
    const command = missingLinks(req, hasWorktree)
      ? tr("\nWork has started but no links are registered. Attach the MR, task, or document:\n{0}", [linkCommand(req.id)])
      : ''
    return tr("## Links (0){0}", [command || tr("\n(none)")])
  }
  return tr("## Links ({0})\n{1}", [req.linkItems.length, req.linkItems
    .map((l) => `- ${linkLabel(l)}  ${l.url}`)
    .join('\n')])
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
      tr("Not found: {0}. Known projects: {1}; pass req-… for requirements, wt-… for worktrees", [slug, known.join(', ') || tr('(none)')]),
    )
  }
  const counts = new Map<string, number>()
  for (const w of board.listWorktrees()) {
    counts.set(w.requirementId, (counts.get(w.requirementId) ?? 0) + 1)
  }
  const requirements = board.listIn(project.slug)
  const lines = requirements.map(
    (r) =>
      `- ${r.id || tr("(no ID)")}  ${requirementStatusLabel(r.status)}  ${r.slug}  ${r.title}` +
      (counts.get(r.id) ? tr("({0} worktrees)", [counts.get(r.id)]) : ''),
  )
  const blocks = [
    tr("Project: {0} ({1})\nDirectory: {2}\nRequirements ({3}):\n{4}", [project.name, project.slug, project.root, requirements.length, lines.join('\n') || tr("(none)")]),
  ]
  if (project.convention) {
    blocks.push(tr("## Project conventions ({0})\n\n{1}", [join(project.root, 'AGENTS.md'), project.convention.trim()]))
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

const ROOT_USAGE = tr("easy-flow: requirements, context, workspaces, and todos.\n\nUsage:\n  easy-flow context <id>                  Read requirement, workspace, or project context\n  easy-flow dir                           Locate data and configuration\n  easy-flow project new <slug>             Create a project\n  easy-flow req new|set|link|session …      Manage requirements and sessions\n  easy-flow req tag add|rm|set|ls …         Manage requirement tags\n  easy-flow taglist                        List existing tags and usage\n  easy-flow wt new|rm …                    Manage Git workspaces\n  easy-flow review <wt-id>                 Run an independent Codex review\n  easy-flow todo new|set|list|show …        Manage global todos\n\nOptions:\n  --lang en|zh    Output language (overrides saved preference and EASY_FLOW_LANG)\n  --json          Structured output, including errors\n  --help          Command help, e.g. easy-flow req new --help\n  --version       Print version")

const USAGE = {
  get review() { return tr("Usage: easy-flow review <wt-id> [--base <ref>] [--recheck <report-path>] [--model <model>] [--json]\n\nWait for an independent read-only Codex review. Reports and logs are saved under docs/review/.\nA requirement/workspace pair reuses one bound reviewer for ordinary reviews, baseline/model changes, retries, and rechecks.\nReview includes committed, staged, unstaged, and untracked changes since the baseline (default: merge base with main-checkout HEAD).\n--recheck inherits the baseline and reads dispositions from the previous successful or failed report; it cannot be combined with --base.\nSuccess means a report was obtained; read its findings. Failure exits 1 and preserves a diagnostic report.\nThe coding session waits without modifying code, then reads the report and addresses findings.") },
  get context() { return tr("Usage: easy-flow context <id> [--json]\n\nAccepts req-… (requirement), wt-… (workspace), or a project slug.\nPass the explicit ID from requirement.md or the workspace's identity document.") },

  get dir() { return tr("Usage: easy-flow dir [--json]\n\nPrint the configured data directory (<data>/<project>/<requirement>/).\nDo not hardcode this path. JSON also includes the config path and active project.") },

  get project() { return tr("Usage: easy-flow project new <slug> [--name <display-name>] [--json]\n\nCreate a project for requirements. Slugs use lowercase letters, digits, and hyphens.") },

  get 'req new'() { return tr("Usage: easy-flow req new <title> (--project <project> | --parent <req-id>) [--slug <slug>] [--summary <sentence>] [--json]\n\n--parent creates a nested child requirement with a project-relative slug (parent/child).\nUse --slug for non-ASCII titles. Describe the deliverable in the title; it cannot equal its directory name.") },

  get 'req set'() { return tr("Usage: easy-flow req set <id> [--status <clarification|in_progress|review|completed>] [--priority <p0|p1|p2|p3|\"\">]\n       [--session-analysis <pending|completed|skipped>] [--json]\n\nOnly supplied fields change; an empty update is rejected. --priority \"\" clears priority.\nLegacy Chinese requirement status values and Review remain accepted as input aliases.\nCLI completion requires completed session analysis. Arrange a separate session to analyze all linked sessions, save the conclusions in requirement documents, and register --session-analysis completed.") },

  get 'req link'() { return tr("Usage: easy-flow req link <id> \"<label>=<url>\" [\"<label>=<url>\" …] [--json]\n\nAttach related tasks, MRs/PRs, designs, documents, monitoring, and screenshots.\nRepeated URLs update their labels without removing links. Labels are optional.") },

  get 'req tag'() { return tr("Usage: easy-flow req tag add <req-id> <tag>… [--json]\n       easy-flow req tag rm <req-id> <tag>… [--json]\n       easy-flow req tag set <req-id> [<tag>…] [--json]\n       easy-flow req tag ls <req-id> [--json]\n\nTags live in the database, never requirement.md. Check taglist before adding terms.\nAt most 3 tags per requirement and 24 characters per tag; no whitespace or leading #.\nAt capacity, remove a tag or replace the set. set without tags clears it.\nMatching trims and ignores case, preserving the established spelling.") },

  get taglist() { return tr("Usage: easy-flow taglist [--project <project>] [--json]\n\nList tags and usage counts, sorted by descending usage then name.\nCheck existing vocabulary before creating a new term. --project limits the scope.") },

  get 'req session'() { return tr("Usage: easy-flow req session add <req-id> --agent <claude|codex|cursor|chengxiaobang|antigravity> [--id <session-id>] [--title <title>] [--cwd <directory>] [--link <url>] [--json]\n       easy-flow req session rm <req-id> --agent <agent> --id <session-id> [--json]\n       easy-flow req session ls [<req-id>] [--json]\n\nRegister sessions in the database for navigation from the board. --cwd defaults to the current directory.\nIf --id is omitted, read CLAUDE_CODE_HOST_SESSION_ID / CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, CURSOR_CONVERSATION_ID, CHENGXIAOBANG_SESSION_ID, or ANTIGRAVITY_CONVERSATION_ID for the selected agent. Missing IDs are rejected.\nDefault deep links exist for Codex, desktop Claude local_ sessions, and Chengxiaobang. Cursor, Antigravity App, and terminal Claude have no session-level deep link.\nRepeated registration refreshes fields without creating a duplicate.") },

  get 'wt new'() { return tr("Usage: easy-flow wt new <req-id> --repo <repository> --branch <branch> [--base <ref>] [--short <short-name>] [--json]\n\nCreate <repository>.<branch> beside the main checkout with identity AGENTS.md and requirement.md / design symlinks.\n--repo accepts a repository name or absolute main-checkout path. --base defaults to main-checkout HEAD.\nCreation is idempotent. --short selects the requirement's docs/<short-name>/ directory.") },

  get 'wt rm'() { return tr("Usage: easy-flow wt rm <wt-id> [--force] [--json]\n\nRemove the directory, Git registration, and easy-flow record while retaining the branch.\nReject uncommitted changes unless --force is authorized to discard them.") },

  get 'todo new'() { return tr("Usage: easy-flow todo new <title> [--source <feishu|chat|agent|manual>] [--session <session-id>]\n       [--channel <at_me|p2p>] [--from <sender>] [--chat <conversation>] [--ref <dedup-key>]\n       [--req <req-id>] [--link <url>] [--at <yyyy-mm-dd HH:mm>] [--summary <handoff>]\n       [--status <todo|in_progress>] [--json]\n\nTodos are global. IDs are assigned as T-YYYYMMDD-NNN on capture.\nInclude known results, next action, completion criteria, key IDs, and evidence in --summary.\nDuplicate --ref values return the existing entry. --req selects an existing owner without requiring promotion.\nAgent/chat sources require the actual source session ID. See the skill for ownership rules.") },

  get 'todo set'() { return tr("Usage: easy-flow todo set <id>… [--status <todo|in_progress|done|cancelled>] [--title <title>]\n       [--summary <handoff>] [--source …] [--session …] [--channel …] [--from …] [--chat …]\n       [--ref …] [--req <req-id>] [--link …] [--at …] [--json]\n\nOnly supplied fields change. Titles/summaries update Markdown and its index; metadata stays in the database.\nAn empty string clears a field. --req changes ownership; use cancelled to abandon work.\nBatch status changes accept several IDs; title/summary changes require one ID.") },

  get 'todo list'() { return tr("Usage: easy-flow todo list [--status <todo|in_progress|done|cancelled>] [--source <source>] [--req <req-id>]\n       [--session <session-id-or-link>] [--orphan] [--all] [--limit <n>] [--json]\n\nShow unfinished todos by default; --all includes finished entries. Sort by latest update and show age.\nFilter by owner, source session, or --orphan (neither explicit nor inferred ownership).") },

  get 'todo show'() { return tr("Usage: easy-flow todo show <id> [--json]\n\nPrint metadata, Markdown path, and full content.") },

  get 'todo promote'() { return tr("Usage: easy-flow todo promote <id> --project <project> [--slug <slug>] [--title <title>] [--json]\n\nCreate a requirement from a todo and assign its owner in one operation.\nReuse its title and handoff summary unless overridden. Already-owned todos are rejected.") },

  get 'todo import'() { return tr("Usage: easy-flow todo import <directory> [--dry-run] [--json]\n\nImport unfinished legacy daily todos (<directory>/yyyy-mm-dd.md) into <data>/_todos/ and the database.\nLeave completed entries in place. Preserve IDs and files, skip existing entries, and preview with --dry-run.") },
}

const GROUP_USAGE = {
  project: USAGE.project,
  req: [USAGE['req new'], USAGE['req set'], USAGE['req link'], USAGE['req tag'], USAGE['req session']].join('\n\n'),
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
const bool = (v: unknown): boolean => v === true

/**
 * 数据目录从哪来：只读配置，不开库——db 坏了、数据目录还没建，这条命令也该能答。
 */
async function cmdDir(argv: string[]): Promise<void> {
  const { values } = parse(argv, {})
  if (bool(values.help)) return out(USAGE.dir)
  emit(
    { dataDir: config.dataDir, configPath: configPath(), activeProject: config.activeProject },
    tr("Data directory: {0}\nConfiguration file: {1}", [config.dataDir, configPath()]),
  )
}

async function cmdReview(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    base: { type: 'string' },
    recheck: { type: 'string' },
    model: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE.review)
  const id = required(positionals[0], tr('Missing worktree id (wt-…)'), USAGE.review)
  if (positionals.length !== 1) throw new UsageError(tr("Review accepts one worktree id"), USAGE.review)
  if (values.base !== undefined && values.recheck !== undefined) {
    throw new UsageError(tr("--base and --recheck cannot be combined"), USAGE.review)
  }
  const board = db()
  board.syncProjects()
  const worktree = board.worktreeById(id)
  if (!worktree) throw new Error(tr("Worktree not found: {0}", [id]))
  const req = findById(worktree.requirementId)
  const title = `${values.recheck ? tr("Recheck") : tr("Review")}：${req.title}`
  const view = requirementView(req)
  view.blocks.push(linkBlock(req, true))
  view.blocks.push(tr("## Related workspaces\n{0}", [board.listWorktrees(req.id).map(worktreeLine).join('\n')]))
  const result = await reviewWorktree({
    worktree,
    requirementPath: req.path,
    context: view.blocks.join('\n\n'),
    title,
    base: str(values.base),
    recheck: str(values.recheck),
    model: str(values.model),
    getSession: () => board.reviewSession(req.id, worktree.id),
    onSessionResolved(session) {
      board.bindReviewSession(req.id, worktree.id, session)
      board.addSession({
        requirementId: req.id, agent: AgentId.Codex, session,
        title,
        cwd: worktree.path, link: sessionLink(AgentId.Codex, session),
      })
    },
  })
  emit(result, [
    result.ok ? tr("Review completed. Read the report and address its findings.") : result.error,
    tr("Report: {0}", [result.reportPath]),
    tr("Log: {0}", [result.logPath]),
  ].join('\n'))
  if (!result.ok) process.exitCode = 1
}

async function cmdContext(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {})
  if (bool(values.help)) return out(USAGE.context)

  const board = db()
  board.syncProjects()
  const key = required(positionals[0], tr('Missing id (req-… / wt-… / project slug)'), USAGE.context)

  // project slugs may look like req-/wt- ids, so fall back to the project table when the id is unknown
  const tryProject = () => (board.listProjects().some((p) => p.slug === key) ? projectView(key) : null)

  if (key.startsWith('wt-')) {
    const wt = board.worktreeById(key)
    if (!wt) {
      const alt = tryProject()
      if (alt) return emit({ kind: 'project', ...alt.data }, alt.blocks.join('\n\n'))
      throw new Error(tr("Worktree not found: {0}. The id lives in the worktree's AGENTS.md", [key]))
    }
    const req = board.byId(wt.requirementId)
    if (!req) throw new Error(tr("Worktree {0} refers to requirement {1}, which is no longer in the db", [key, wt.requirementId]))
    const view = requirementView(req, [
      `worktree id：${wt.id}`,
      tr("Repository: {0}{1}", [wt.repo, wt.short ? tr("(short name {0})", [wt.short]) : '']),
      tr("Branch: {0}", [wt.branch]),
      tr("Path: {0}{1}", [wt.path, existsSync(wt.path) ? '' : tr("(directory no longer exists)")]),
      tr("Main checkout: {0}", [wt.main]),
      tr("Design documents: {0} → {1} (symlink; files live in the requirement directory)", [join(wt.path, 'design'), join(req.path, 'docs', (wt.short || wt.repo).trim())]),
    ])
    const siblings = board.listWorktrees(req.id).filter((w) => w.id !== wt.id)
    view.blocks.push(
      siblings.length
        ? tr("## Other worktrees for this requirement\n{0}", [siblings.map(worktreeLine).join('\n')])
        : tr("## Other worktrees for this requirement\n(none)"),
    )
    // 会话挂在需求上，工作区视图里照样列出来，并标出哪个会话就在这个目录里干活
    const sessions = board.listSessions(req.id)
    view.blocks.push(...sessionBlock(sessions, wt.path))
    view.blocks.push(linkBlock(req, true))
    // 待办跟着需求走：在工作区里开工，与在需求目录里开工看到的是同一批
    const todos = todoSection(board, req.id)
    view.blocks.push(...todos.blocks)
    return emit(
      {
        kind: 'worktree',
        worktree: wt,
        sessions,
        ...view.data,
        links: req.linkItems,
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
      throw new Error(tr("Requirement not found: {0}", [key]))
    }
    const wts = board.listWorktrees(req.id)
    const view = requirementView(req)
    view.blocks.push(
      wts.length
        ? `## worktree（${wts.length}）\n${wts.map(worktreeLine).join('\n')}`
        : tr("## Worktrees (0)\nNo workspace yet. Run easy-flow wt new before changing repository code."),
    )
    const sessions = board.listSessions(req.id)
    view.blocks.push(...sessionBlock(sessions))
    // 链接是别人与下一个 agent 找东西的入口：一条都没有时把命令写到眼前
    view.blocks.push(linkBlock(req, wts.length > 0))
    const todos = todoSection(board, req.id)
    view.blocks.push(...todos.blocks)
    return emit(
      {
        kind: 'requirement',
        sessions,
        ...view.data,
        links: req.linkItems,
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
  if (!action) throw new UsageError(tr("project needs a subcommand: new"), GROUP_USAGE.project)
  if (action !== 'new') throw new UsageError(tr("Unknown subcommand: project {0}", [action]), GROUP_USAGE.project)

  const { values, positionals } = parse(argv, { name: { type: 'string' } })
  if (bool(values.help)) return out(USAGE.project)

  const slug = required(positionals[0], tr('Missing project slug (lowercase letters, digits, hyphens)'), USAGE.project)
  const display = str(values.name)?.trim() || slug
  const dir = createProjectDir(config.dataDir, slug, display)
  db().syncProjects()
  emit({ ok: true, slug, name: display, dir }, tr("Created project “{0}” ({1})\nDirectory: {2}", [display, slug, dir]))
}

async function cmdReqNew(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    project: { type: 'string' },
    parent: { type: 'string' },
    slug: { type: 'string' },
    summary: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['req new'])

  const title = required(positionals[0], tr('Missing requirement title'), USAGE['req new'])
  const parentId = str(values.parent)?.trim()
  const project = str(values.project)?.trim()
  if (parentId && project) throw new UsageError(tr("Pass either --project or --parent, not both"), USAGE['req new'])
  if (!parentId && !project) throw new UsageError(tr("Pass one of --project / --parent"), USAGE['req new'])

  const slug = str(values.slug)?.trim() || deriveSlug(title)
  if (titleIsSlug(title, slug)) {
    throw new UsageError(
      tr("Title repeats the directory name, which tells nobody what the requirement does: {0}. Write it as a short phrase instead — what it does, and where or why.", [title]),
      USAGE['req new'],
    )
  }
  const summary = str(values.summary) ?? ''

  let created: { dir: string; id: string }
  let text: string
  if (parentId) {
    const parent = findById(parentId)
    created = createRequirementDir(parent.path, slug, title, summary)
    text = tr("Created child requirement “{1}” under “{0}”", [parent.title, title])
  } else {
    created = createRequirementDir(projectRoot(project!), slug, title, summary)
    text = tr("Created requirement “{1}” in project “{0}”", [project, title])
  }
  db().syncProjects()

  // Report the stored slug, not the --slug argument: a sub-requirement's slug is its path
  // from the project root (seatmap/gateway), and callers of --json should get the real one
  const stored = db().byId(created.id)
  emit(
    { ok: true, ...created, title, slug: stored?.slug ?? slug, project: stored?.project ?? project ?? null, parent: parentId ?? null },
    tr("{0}\nRequirement ID: {1}\nDirectory: {2}\nInitial status: clarification.", [text, created.id, created.dir]),
  )
}

async function cmdReqSet(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    status: { type: 'string' },
    priority: { type: 'string' },
    'session-analysis': { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['req set'])

  const id = required(positionals[0], tr('Missing requirement id (req-…)'), USAGE['req set'])
  const statusInput = str(values.status)?.trim()
  const status = statusInput === undefined ? undefined : normalizeRequirementStatus(statusInput)
  if (statusInput !== undefined && status === undefined) throw new Error(tr("Unknown status: {0}. Valid: {1}", [statusInput, STATUSES.join(', ')]))
  const priority = str(values.priority)?.trim()
  const analysis = str(values['session-analysis'])?.trim()
  if (status === undefined && priority === undefined && analysis === undefined) {
    throw new UsageError(tr("Pass at least one of --status / --priority / --session-analysis"), USAGE['req set'])
  }
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    throw new Error(tr("Unknown status: {0}. Valid: {1}", [status, STATUSES.join(', ')]))
  }
  if (priority !== undefined && priority !== '' && !(PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(tr("Unknown priority: {0}. Valid: {1}; an empty string clears it", [priority, PRIORITIES.join(', ')]))
  }
  if (analysis !== undefined && !(SESSION_ANALYSIS_STATUSES as readonly string[]).includes(analysis)) {
    throw new Error(tr("Unknown session analysis status: {0}. Valid: {1}", [analysis, SESSION_ANALYSIS_STATUSES.join(', ')]))
  }

  const board = db()
  board.syncProjects()
  const req = findById(id)
  if (status === RequirementStatus.Completed && (analysis ?? req.sessionAnalysisStatus) !== SessionAnalysisState.Completed) {
    throw new Error(
      tr("Requirement {0} has no completed session analysis. Ask the user to start a separate session to analyze all linked AI agent sessions,", [req.id]) +
      tr("including conversations, tool calls, and results, for reusable knowledge and skill improvements.\n") +
      tr("Session list: easy-flow req session ls {0}\n", [req.id]) +
      tr("After analysis, register it: easy-flow req set {0} --session-analysis completed\n", [req.id]) +
      tr("Save the conclusions in requirement documents, then run: easy-flow req set {0} --status completed", [req.id]),
    )
  }
  let next = req
  if (analysis !== undefined) next = board.setSessionAnalysisStatus(req.slug, analysis as SessionAnalysisStatus, req.project)
  if (status !== undefined) next = board.setStatus(req.slug, status as Status, req.project)
  if (priority !== undefined) next = board.setPriority(req.slug, priority as Priority, req.project)

  // 刚收掉最后一个子需求时提一句父需求，但不替它改状态——父需求自己可能还有整体验收
  const hint = status === RequirementStatus.Completed && req.status !== RequirementStatus.Completed ? parentHint(board, next) : ''
  // 收尾时待办也回头看一眼：只提示，不改状态。与父需求提示同一套道理
  const todoReminder =
    status === RequirementStatus.Completed || status === RequirementStatus.Review
      ? [todoHint(board.todosForRequirement(next.id), next.id), overdueOrphanHint(board.orphanTodos())]
          .filter(Boolean)
          .join('\n')
      : ''
  // 走到 Review 却一条链接都没登记：看板上就没有 MR 可点，先把命令顶到眼前
  const linkReminder = missingLinks(next, board.listWorktrees(next.id).length > 0)
    ? tr("No links are registered. Attach the MR, task, or document: {0}", [linkCommand(next.id)])
    : ''

  emit(
    {
      ok: true,
      id: next.id,
      title: next.title,
      status: next.status,
      sessionAnalysisStatus: next.sessionAnalysisStatus,
      priority: next.priority,
      parentHint: hint || undefined,
      todoHint: todoReminder || undefined,
      linkHint: linkReminder || undefined,
    },
    tr("Requirement: {0} ({1})\nStatus: {2}{3}\nSession analysis: {4}{5}{6}{7}", [next.title, next.id, requirementStatusLabel(next.status), next.priority ? tr(" · Priority: {0}", [next.priority]) : '', SESSION_ANALYSIS_LABELS[next.sessionAnalysisStatus], hint ? `\n${hint}` : '', todoReminder ? `\n${todoReminder}` : '', linkReminder ? `\n${linkReminder}` : '']),
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
  if (!parent || parent.status === RequirementStatus.Completed) return ''
  return tr("All {1} children of “{0}” are complete. If no other work remains, close the parent: easy-flow req set {2} --status completed", [parent.title, siblings.length, parent.id])
}

// 这批需求是不是都到了终态。「全完成」只有这一处定义，`req set` 与 `context` 共用
function allDone(reqs: Requirement[]): boolean {
  return reqs.every((r) => r.status === RequirementStatus.Completed)
}

/**
 * 一条链接收两种写法："<标题>=<url>"，或只给 URL（标题留空，展示层从 URL 推）。
 * 第一个 = 前面带 :// 就整条当 URL——URL 自带的 = 不会被拆成标题。
 * 等号后面没有地址直接报错，别让空链接悄悄丢掉。
 */
function parseLinkArg(item: string): LinkItem {
  const at = item.indexOf('=')
  const head = at < 0 ? item : item.slice(0, at)
  if (head.includes('://')) return { title: '', url: item }
  if (at < 1) throw new Error(tr("Link expects \"<label>=<url>\": {0}", [item]))
  const url = item.slice(at + 1).trim()
  if (!url) throw new Error(tr("Link is missing a url: {0}", [item]))
  return { title: item.slice(0, at).trim(), url }
}

// CLI 只增不删：同 URL 已在列表里就只更新标题（这次没给标题就留着旧的）
function mergeLinks(existing: LinkItem[], incoming: LinkItem[]): LinkItem[] {
  const out = existing.map((l) => ({ ...l }))
  for (const link of incoming) {
    const hit = out.find((x) => x.url === link.url)
    if (!hit) out.push(link)
    else if (link.title) hit.title = link.title
  }
  return out
}

async function cmdReqLink(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {})
  if (bool(values.help)) return out(USAGE['req link'])

  const id = required(positionals[0], tr('Missing requirement id (req-…)'), USAGE['req link'])
  const incoming = positionals.slice(1).map(parseLinkArg)
  if (!incoming.length) {
    throw new UsageError(tr("Pass at least one link: \"<label>=<url>\""), USAGE['req link'])
  }

  const board = db()
  board.syncProjects()
  const req = findById(id)

  const next = board.setLinks(req.slug, mergeLinks(req.linkItems, incoming), req.project)

  const lines = next.linkItems.map((l) => `- ${linkLabel(l)}  ${l.url}`)
  emit(
    {
      ok: true,
      id: next.id,
      title: next.title,
      links: next.linkItems,
    },
    [tr("Requirement: {0} ({1})", [next.title, next.id]), tr("Links ({0}):", [next.linkItems.length]), ...(lines.length ? lines : [tr("- (empty)")])].join(
      '\n',
    ),
  )
}

async function cmdReqTag(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(USAGE['req tag'])
  if (action !== 'add' && action !== 'rm' && action !== 'set' && action !== 'ls') {
    throw new UsageError(tr("req tag needs a subcommand: add / rm / set / ls"), USAGE['req tag'])
  }

  const { values, positionals } = parse(argv, {})
  if (bool(values.help)) return out(USAGE['req tag'])

  const reqId = required(positionals[0], tr('Missing requirement id (req-…)'), USAGE['req tag'])
  const incoming = normalizeTags(positionals.slice(1))
  if (action !== 'ls' && action !== 'set' && !incoming.length) {
    throw new UsageError(tr("Pass at least one tag: easy-flow req tag {0} {1} <tag>", [action, reqId]), USAGE['req tag'])
  }

  const board = db()
  board.syncProjects()
  const req = findById(reqId)

  let next = req
  if (action === 'add' || action === 'set') {
    const target = action === 'add' ? normalizeTags([...req.tags, ...incoming]) : incoming
    if (target.length > TAG_LIMIT) {
      const current = req.tags.length ? req.tags.join(' · ') : tr("(empty)")
      throw new UsageError(
        [
          tr("A requirement allows at most {0} tags; this would produce {1}. Current: {2}", [TAG_LIMIT, target.length, current]),
          tr("Remove one first: easy-flow req tag rm {0} <tag>", [req.id]),
          tr("Or replace the set: easy-flow req tag set {0} <tag> <tag> <tag>", [req.id]),
        ].join('\n'),
        USAGE['req tag'],
      )
    }
    next = board.setTags(req.slug, target, req.project)
  }
  if (action === 'rm') {
    const drop = new Set(incoming.map(tagKey))
    next = board.setTags(req.slug, req.tags.filter((t) => !drop.has(tagKey(t))), req.project)
  }

  emit(
    {
      ok: true,
      id: next.id,
      title: next.title,
      tags: next.tags,
    },
    [
      tr("Requirement: {0} ({1})", [next.title, next.id]),
      tr("Tags ({0}): {1}", [next.tags.length, next.tags.length ? next.tags.join(' · ') : tr("(empty)")]),
    ].join('\n'),
  )
}

async function cmdTagList(argv: string[]): Promise<void> {
  const { values } = parse(argv, { project: { type: 'string' } })
  if (bool(values.help)) return out(USAGE.taglist)

  const project = str(values.project)?.trim()
  if (project && !listProjectDirs(config.dataDir).some((p) => p.slug === project)) {
    throw new Error(tr("Project not found: {0}", [project]))
  }

  const board = db()
  board.syncProjects()
  const tags = board.tagCounts(project || undefined)
  const head = project ? tr("Tags for project {0} ({1})", [project, tags.length]) : tr("Tags ({0})", [tags.length])

  emit(
    { tags, total: tags.length, project: project ?? null },
    tags.length
      ? `${head}：\n${tags.map((t) => `- ${t.tag}  ${t.count}`).join('\n')}`
      : tr("No tags yet. Add one: easy-flow req tag add <req-…> <tag>"),
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
    tr('Missing --id, and none of {0} is set in this shell. Run this in a {1} session or supply --id <session-id>.', [names.join(' / '), agent]),
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

  const reqId = required(positionals[0], tr('Missing requirement id (req-…)'), USAGE['req session'])
  const agent = required(str(values.agent), tr('Missing --agent (claude / codex / cursor / chengxiaobang / antigravity)'), USAGE['req session']) as SessionAgent
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
      tr("Registered session under requirement “{0}” ({1})", [req.title, req.id]),
      sessionLine(saved),
      saved.link
        ? tr("Open it from the board's details panel. Registering again refreshes its fields.")
        : canOpenWorkspace(saved) ? tr("This agent has no session deep link. {0}", [workspaceOpenHint(saved)])
          : tr("This agent has no session deep link. The board can only display and copy the session ID."),
    ].join('\n'),
  )
}

async function cmdReqSessionRm(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, { agent: { type: 'string' }, id: { type: 'string' } })
  if (bool(values.help)) return out(USAGE['req session'])

  const reqId = required(positionals[0], tr('Missing requirement id (req-…)'), USAGE['req session'])
  const agent = required(str(values.agent), tr('Missing --agent (claude / codex / cursor / chengxiaobang / antigravity)'), USAGE['req session']) as SessionAgent
  oneOf(agent, SESSION_AGENTS, 'agent')
  const session = required(str(values.id), tr('Missing --id (the session id)'), USAGE['req session'])

  const board = db()
  board.syncProjects()
  const req = findById(reqId)
  const removed = board.removeSession(agent, session)
  if (!removed) throw new Error(tr("Session not found on {0}: {1} {2}", [req.id, agent, session]))

  emit(
    { ok: true, requirementId: req.id, agent, session },
    tr("Unregistered session {1} {2} from “{0}” (the session itself was not changed)", [req.title, agent, session]),
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
      const head = req ? `${req.slug}（${id}）` : tr("(requirement no longer exists in the database: {0})", [id])
      return `## ${head}\n${list.map((s) => sessionLine(s)).join('\n')}`
    })
    return emit(
      { sessions, total: sessions.length },
      blocks.length ? tr("Sessions ({0}):\n\n{1}", [sessions.length, blocks.join('\n\n')]) : tr("No registered sessions yet."),
    )
  }

  const req = findById(reqId)
  const sessions = board.listSessions(req.id)
  emit(
    { requirementId: req.id, sessions, total: sessions.length },
    sessions.length
      ? tr("Sessions for “{0}” ({1}):\n{2}", [req.title, sessions.length, sessions.map((s) => sessionLine(s)).join('\n')])
      : tr("No sessions registered under “{0}”. Run easy-flow req session add {1} --agent <claude|codex|cursor|chengxiaobang|antigravity> from the session.", [req.title, req.id]),
  )
}

async function cmdReqSession(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(USAGE['req session'])
  if (!action) throw new UsageError(tr("req session needs a subcommand: add / rm / ls"), USAGE['req session'])
  if (action === 'add') return cmdReqSessionAdd(argv)
  if (action === 'rm') return cmdReqSessionRm(argv)
  if (action === 'ls') return cmdReqSessionLs(argv)
  throw new UsageError(tr("Unknown subcommand: req session {0}", [action]), USAGE['req session'])
}

async function cmdWtNew(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    repo: { type: 'string' },
    branch: { type: 'string' },
    base: { type: 'string' },
    short: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['wt new'])

  const requirementId = required(positionals[0], tr('Missing requirement id (req-…)'), USAGE['wt new'])
  const repo = str(values.repo)?.trim()
  const branch = str(values.branch)?.trim()
  if (!repo) throw new UsageError(tr("Missing --repo (repo name or main checkout path)"), USAGE['wt new'])
  if (!branch) throw new UsageError(tr("Missing --branch (branch name)"), USAGE['wt new'])
  const base = str(values.base)
  const short = str(values.short)

  const board = db()
  board.syncProjects()
  const req = findById(requirementId)
  if (!existsSync(req.path)) throw new Error(tr("Requirement dir does not exist: {0}", [req.path]))

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
      tr('Failed to register: {0}\nThe worktree directory already exists ({1}); its ID is in AGENTS.md. Run easy-flow wt new again to finish registration.', [(err as Error).message, provision.path]),
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
        ? tr("Worktree created")
        : tr("Worktree already exists; restored only easy-flow artifacts (directory and branch unchanged)"),
      `worktree id：${id}`,
      tr("Requirement: {0} ({1})", [req.title, req.id]),
      tr("Repository: {0}{1}", [target.repo, short ? tr("(short name {0})", [short]) : '']),
      tr("Branch: {0} ({1})", [branch, provision.branchCreated ? tr("new, based on {0}", [base || tr("Main checkout HEAD")]) : tr("reused existing local branch")]),
      tr("Path: {0}", [provision.path]),
      tr("Main checkout: {0}", [target.main]),
      provision.excludeNote,
      provision.identityInFile
        ? tr("Read context here: easy-flow context {0}", [id])
        : tr("An AGENTS.md not created by easy-flow already exists. It was preserved, so {0} was not written into it.", [id]) +
          tr("Follow requirement.md to the requirement directory, read its requirement ID, then use easy-flow context to identify the worktree."),
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function cmdWtRm(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, { force: { type: 'boolean' } })
  if (bool(values.help)) return out(USAGE['wt rm'])

  const id = required(positionals[0], tr('Missing worktree id (wt-…)'), USAGE['wt rm'])
  const board = db()
  board.syncProjects()
  const wt = board.worktreeById(id)
  if (!wt) throw new Error(tr("Worktree not found: {0}", [id]))

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
      result.missing ? tr("Directory was already absent; removed records and Git registration") : tr("Worktree removed"),
      `worktree id：${wt.id}`,
      tr("Path: {0}", [wt.path]),
      result.discarded.length ? tr("Discarded {0} uncommitted changes", [result.discarded.length]) : '',
      tr("Branch {0} was retained. To delete it: git -C {1} branch -D {2}", [wt.branch, wt.main, wt.branch]),
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
  if (link && !/^https?:\/\//i.test(link)) throw new Error(tr("Link must start with http(s)://: {0}", [link]))
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
  if (!valid.includes(value)) throw new Error(tr("Unknown {0}: {1}. Valid: {2}", [what, value, valid.join(', ')]))
}

// --req 只收真实存在的需求 id：写错了需求详情页只会一直空着，不如当场报错
function checkTodoReq(board: BoardDatabase, req: string | undefined): void {
  if (req && !board.byId(req)) {
    throw new Error(tr("Requirement not found: {0}. --req selects an owner; use easy-flow todo promote to create a requirement.", [req]))
  }
}

function todoLine(t: Todo): string {
  const who = t.origin || t.chat
  const days = todoAgeDays(t.created)
  const age = days > 0 ? tr("  {0} days", [days]) : ''
  const overdue = days >= TODO_STALE_DAYS && isOpenTodo(t) ? tr("  overdue") : ''
  return `- ${t.id}  ${t.status.padEnd(11)} ${t.source || '—'}  ${t.title}${who ? `（${who}）` : ''}${age}${overdue}`
}

// 元数据一行一个，new 与 show 共用
function todoHead(t: Todo, file: string): string[] {
  const head = [
    tr("Todo ID: {0}", [t.id]),
    tr("Todo: {0}", [t.title]),
    tr("Status: {0}", [t.status]),
    tr("File: {0}", [file]),
    tr("Source: {0}{1}", [t.source || tr("(not recorded)"), t.channel ? ` · ${t.channel}` : '']),
  ]
  if (t.origin) head.push(tr("Sender: {0}", [t.origin]))
  if (t.chat) head.push(tr("Context: {0}", [t.chat]))
  if (t.session) head.push(tr("Session: {0}", [t.session]))
  if (t.ref) head.push(tr("Deduplication key: {0}", [t.ref]))
  if (t.requirementId) head.push(tr("Requirement: {0}", [t.requirementId]))
  if (t.link) head.push(tr("Link: {0}", [t.link]))
  if (t.happened) head.push(tr("Source event time: {0}", [t.happened]))
  head.push(tr("Created: {0} · Updated: {1}", [t.created, t.updated]))
  return head
}

async function cmdTodoNew(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv, {
    ...TODO_FIELDS,
    summary: { type: 'string' },
    status: { type: 'string' },
  })
  if (bool(values.help)) return out(USAGE['todo new'])

  const title = required(positionals[0], tr('Missing todo title'), USAGE['todo new'])
  const patch = todoPatch(values)
  const status = (str(values.status)?.trim() || TodoState.Todo) as TodoStatus
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
        tr("Ref already used by {0} ({1}); update it with easy-flow todo set {2}", [dup.id, dup.title, dup.id]),
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
    [tr("Todo recorded"), ...todoHead(todo, file), '', tr("Content lives in this file (summary is the handoff; append progress below).")].join('\n'),
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
  if (!ids.length) throw new UsageError(tr("Missing todo id (T-…)"), USAGE['todo set'])
  const patch = todoPatch(values)
  const status = str(values.status)?.trim()
  const title = str(values.title)?.trim()
  const summary = str(values.summary)
  if (status === undefined && title === undefined && summary === undefined && !Object.keys(patch).length) {
    throw new UsageError(tr("Pass at least one field to change"), USAGE['todo set'])
  }
  // 标题与摘要是 md 的正文，一条一份文件；批量只做字段与状态，避免改串
  if (ids.length > 1 && (title !== undefined || summary !== undefined)) {
    throw new UsageError(tr("--title / --summary can update only one todo at a time"), USAGE['todo set'])
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
      tr("Todo not found: {0}. The ID is the filename ({1}).", [unknown.join(', '), join(config.dataDir, '_todos', '<id>.md')]),
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
    return emit({ ok: true, ...todo }, [tr("Todo: {0} ({1})", [todo.title, todo.id]), tr("Status: {0}", [todo.status])].join('\n'))
  }
  emit(
    { ok: true, todos },
    [tr("Updated {0} todos:", [todos.length]), ...todos.map((t) => `- ${t.id}  ${t.title}  ${t.status}`)].join('\n'),
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
  if (req && bool(values.orphan)) throw new UsageError(tr("Pass either --req or --orphan"), USAGE['todo list'])
  if (session && (req || bool(values.orphan))) {
    throw new UsageError(tr("Pass --session on its own"), USAGE['todo list'])
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
    ? tr("For requirement {0}: ", [req])
    : session
      ? tr("For session {0}: ", [session])
      : bool(values.orphan)
        ? tr("Unassigned ")
        : ''
  const blocks = [
    `${status ? tr("Status {0}", [status]) : bool(values.all) ? tr("{0}all todos", [scope]) : tr("{0}unfinished todos", [scope])}（${todos.length}）：`,
    shown.map(todoLine).join('\n') || tr("(none)"),
  ]
  if (hidden > 0) blocks.push(tr("({0} more; increase --limit or filter with --status)", [hidden]))
  if (!status && !bool(values.all) && !req && !session && !bool(values.orphan)) {
    const rest = all.length - open.length
    if (rest > 0) blocks.push(tr("({0} completed/cancelled; use --all to show everything)", [rest]))
  }
  // 验收要的那一条：未归属 N、超期 M、最老 K 天
  if (bool(values.orphan)) {
    const stats = orphanStats(orphans)
    blocks.push(tr("({0} unassigned, {1} overdue, oldest {2} days)", [stats.open.length, stats.overdue.length, stats.oldestDays]))
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

  const id = required(positionals[0], tr("Missing todo id (T-…)"), USAGE['todo show'])
  const board = db()
  board.syncTodos()
  const todo = board.todoById(id)
  if (!todo) throw new Error(tr("Todo not found: {0}", [id]))
  const { path, content } = board.readTodoDoc(id)

  emit(
    { todo, path, content },
    [todoHead(todo, path).join('\n'), tr("## Content ({0})\n\n{1}", [path, content.trim()])].join('\n\n'),
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

  const id = required(positionals[0], tr("Missing todo id (T-…)"), USAGE['todo promote'])
  const project = required(str(values.project)?.trim(), tr('Missing --project'), USAGE['todo promote'])

  const board = db()
  board.syncTodos()
  const todo = board.todoById(id)
  if (!todo) throw new Error(tr("Todo not found: {0}", [id]))
  if (todo.requirementId) {
    throw new Error(
      tr("Todo {0} already belongs to {1}. Reassign with easy-flow todo set {2} --req <req-…>.", [id, todo.requirementId, id]),
    )
  }

  const title = str(values.title)?.trim() || todo.title
  const slug = str(values.slug)?.trim() || deriveSlug(title)
  if (titleIsSlug(title, slug)) {
    throw new UsageError(
      tr("The title repeats the directory name: {0}. Change --title or --slug to describe the deliverable.", [title]),
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
      tr("Promoted: {0} ({1})", [todo.title, id]),
      tr("Requirement ID: {0}", [requirementId]),
      tr("Directory: {0}", [created.dir]),
      tr("Initial status: clarification. The todo is now linked to this requirement."),
      '',
      tr("Next: easy-flow wt new {0} --repo <repository> --branch feature-{1}", [requirementId, stored?.slug ?? slug]),
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

  const dir = required(positionals[0], tr('Missing source dir (the old todo board, e.g. ~/todo)'), USAGE['todo import'])
  if (!existsSync(dir)) throw new Error(tr("Directory not found: {0}", [dir]))
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
  if (!files.length) throw new Error(tr("No yyyy-mm-dd.md under {0}", [dir]))

  const dryRun = bool(values['dry-run'])
  const board = db()
  board.syncTodos()

  const created: string[] = []
  const skipped: string[] = []
  let finished = 0
  for (const file of files) {
    for (const entry of parseLegacyTodoFile(readFileSync(join(dir, file), 'utf8'))) {
      // 只搬未完成的：已完成的留在原处当历史，进看板只会淹没真正要做的事
      if (entry.status !== TodoState.Todo && entry.status !== TodoState.InProgress) {
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
      dryRun ? tr("Would migrate {0} unfinished todos (--dry-run; no files written)", [created.length]) : tr("Migrated {0} unfinished todos", [created.length]),
      created.length ? `id：${created.join('、')}` : '',
      skipped.length ? tr("Skipped {0} existing entries: {1}", [skipped.length, skipped.join('、')]) : '',
      finished ? tr("Left {0} completed/cancelled entries in place", [finished]) : '',
      tr("Todo directory: {0}", [join(config.dataDir, '_todos')]),
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

async function cmdTodo(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.todo)
  if (!action) throw new UsageError(tr("todo needs a subcommand: new / set / list / show / promote / import"), GROUP_USAGE.todo)
  if (action === 'new') return cmdTodoNew(argv)
  if (action === 'set') return cmdTodoSet(argv)
  if (action === 'list') return cmdTodoList(argv)
  if (action === 'show') return cmdTodoShow(argv)
  if (action === 'promote') return cmdTodoPromote(argv)
  if (action === 'import') return cmdTodoImport(argv)
  throw new UsageError(tr("Unknown subcommand: todo {0}", [action]), GROUP_USAGE.todo)
}

async function cmdReq(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.req)
  if (!action) throw new UsageError(tr("req needs a subcommand: new / set / link / tag / session"), GROUP_USAGE.req)
  if (action === 'new') return cmdReqNew(argv)
  if (action === 'set') return cmdReqSet(argv)
  if (action === 'link') return cmdReqLink(argv)
  if (action === 'tag') return cmdReqTag(argv[0], argv.slice(1))
  if (action === 'session') return cmdReqSession(argv[0], argv.slice(1))
  throw new UsageError(tr("Unknown subcommand: req {0}", [action]), GROUP_USAGE.req)
}

async function cmdWt(action: string | undefined, argv: string[]): Promise<void> {
  if (action === '--help' || action === '-h') return out(GROUP_USAGE.wt)
  if (!action) throw new UsageError(tr("wt needs a subcommand: new / rm"), GROUP_USAGE.wt)
  if (action === 'new') return cmdWtNew(argv)
  if (action === 'rm') return cmdWtRm(argv)
  throw new UsageError(tr("Unknown subcommand: wt {0}", [action]), GROUP_USAGE.wt)
}

async function run(argv: string[]): Promise<void> {
  const [group, action, ...rest] = argv
  if (!group || group === '--help' || group === '-h') return out(ROOT_USAGE)
  if (group === '--version' || group === '-v') return out(VERSION)
  if (group === 'context') return cmdContext(argv.slice(1))
  if (group === 'dir') return cmdDir(argv.slice(1))
  if (group === 'review') return cmdReview(argv.slice(1))
  if (group === 'taglist') return cmdTagList(argv.slice(1))
  if (group === 'project') return cmdProject(action, rest)
  if (group === 'req') return cmdReq(action, rest)
  if (group === 'wt') return cmdWt(action, rest)
  if (group === 'todo') return cmdTodo(action, rest)
  throw new UsageError(tr("Unknown command: {0}", [group]), ROOT_USAGE)
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2)
  asJson = raw.includes('--json')
  let hasLanguageFlag = false
  let language = getLanguage()
  const argv: string[] = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--lang' || raw[i].startsWith('--lang=')) {
      const value = raw[i] === '--lang' ? raw[++i] : raw[i].slice(7)
      if (!isLanguage(value) || hasLanguageFlag) {
        const error = tr('Invalid --lang; use en or zh')
        if (asJson) out(JSON.stringify({ error }))
        else process.stderr.write(`${error}\n`)
        process.exitCode = 2
        return
      }
      hasLanguageFlag = true
      language = value
    } else argv.push(raw[i])
  }
  setLanguage(language)
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
