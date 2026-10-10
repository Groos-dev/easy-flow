/**
 * SQLite 数据层：状态（看板列、优先级）的唯一权威 + 文档全文索引。
 *
 * 职责划分：
 *   md   → 需求内容，agent 读写
 *   sqlite → 机器状态与索引，agent 不关心，UI 消费
 *
 * 同步策略（关键）：md 是"需求是否存在"的事实源，DB 是状态的权威。
 *   目录在、DB 无 → 新增（status 默认澄清）
 *   目录在、DB 有 → 只更新标题/摘要/仓库/文档索引，绝不动 status/priority
 *   DB 有、目录没了 → 标记为孤儿，保留在列表中可见
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  listProjectDirs,
  listRequirementDirs,
  listTodoFiles,
  parseRequirement,
  projectDisplayName,
  readProjectConvention,
  type RepoRef,
  type DocFile,
} from './markdown.ts'
import { readTextOrNull } from './fsutil.ts'
import { applySchema } from './schema.ts'
import { ensureTemplates, projectIssues } from './convention.ts'

/**
 * 状态 = 看板的列。两者是同一个东西，所以只有这一套取值，顺序即列顺序。
 */
export const STATUSES = ['澄清', '执行中', 'Review', '已完成'] as const
export type Status = (typeof STATUSES)[number]

/**
 * 优先级四档 = 艾森豪威尔四象限：
 *   p0 重要且紧急（马上做） · p1 重要不紧急（计划做）
 *   p2 紧急不重要（授权做） · p3 都不（有空再做）
 */
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const
export type Priority = (typeof PRIORITIES)[number]

/**
 * 待办的状态 = 待办看板的列。字面量沿用全局 todo skill 的取值（英文原样，不译成中文）：
 * 它要能被 agent 直接贴进命令与文件，也免得历史条目的状态在迁移时改写。
 */
export const TODO_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

/** 待办来源。feishu 由 feishu-task 识别后委托入库，manual 是用户口头要求记一条 */
export const TODO_SOURCES = ['feishu', 'chat', 'agent', 'manual'] as const
export type TodoSource = (typeof TODO_SOURCES)[number]

/** 飞书来源的来路：@我 还是小窗私聊 */
export const TODO_CHANNELS = ['at_me', 'p2p'] as const

/**
 * 会话的 agent 清单。取值与 skill 安装的 agent 目录同一套（claude / cursor / codex），
 * 免得同一个东西在两处叫两个名字。
 */
export const SESSION_AGENTS = ['claude', 'codex', 'cursor'] as const
export type SessionAgent = (typeof SESSION_AGENTS)[number]

/** 会话角色：开工登记的 dev；review 会话由 req session review 建，用来复用与展示 */
export const SESSION_ROLES = ['dev', 'review'] as const
export type SessionRole = (typeof SESSION_ROLES)[number]

export const DEFAULT_PROJECT_SLUG = 'default'

export interface Project {
  slug: string
  name: string
  root: string
  /** 项目根目录下是否有 AGENTS.md（项目总规范） */
  hasConvention: boolean
  /** 规范文件原文，没有则为 null */
  convention: string | null
  /** 目录不合规范之处（只读提示，空数组即合规）。不落库——它是文件系统的纯函数 */
  issues: string[]
  requirementCount: number
  mtime: number
  updated: string
}

export interface Requirement {
  slug: string
  /** 所属项目 */
  project: string
  /** 不透明需求 id（AGENTS.md 的 frontmatter）。老需求可能还没有，为空串 */
  id: string
  /** 父需求的 id；顶层需求为空串。slug 里也带着层级（parent/child），两者互为印证 */
  parentId: string
  title: string
  status: Status
  priority: Priority | ''
  summary: string
  repos: RepoRef[]
  links: string
  /** Feishu task (Meego story) links. Written by the CLI; the UI is read-only */
  feishuTaskLinks: string[]
  /** Code links: GitLab MR / GitHub PR etc. Written by the CLI; the UI is read-only */
  codeLinks: CodeLink[]
  /** 扩展链接：{ detail 描述, url 链接 } */
  extLinks: ExtLink[]
  docs: Array<{ name: string; size: number }>
  path: string
  mtime: number
  updated: string
}

/** 扩展链接：detail 是描述，url 是链接 */
export interface ExtLink {
  detail: string
  url: string
}

/** 代码链接：label 是显示别名，空串表示没给——展示层从 url 推导一个 */
export interface CodeLink {
  label: string
  url: string
}

/**
 * 需求的一个工作区（git worktree）。
 * id 写在 worktree 自己的 AGENTS.md frontmatter 里，是它自证身份的唯一凭据。
 */
export interface Worktree {
  id: string
  /** 所属需求的 id */
  requirementId: string
  /** 需求里的短名（涉及仓库表的短名列）。可空：调用方直接给路径时没有短名 */
  short: string
  /** 仓库名，即主 checkout 的目录名 */
  repo: string
  branch: string
  path: string
  /** 主 checkout 路径。worktree 没了也留着，否则无法定位到仓库去收拾残局 */
  main: string
  created: string
  updated: string
  orphan: boolean
}

interface WtRow {
  id: string
  req_id: string
  short: string
  repo: string
  branch: string
  path: string
  main: string
  created: string | null
  updated: string | null
  orphan: number
}

/**
 * 一条 agent 会话的登记。会话 id 是 agent 自己的（claude 的 session uuid、codex 的 thread id、
 * cursor 的 conversation id），这里只做「哪条需求上有哪些会话」的映射。
 */
export interface Session {
  /** 所属需求的 id */
  requirementId: string
  agent: SessionAgent
  /** agent 原生的会话 id */
  session: string
  /** dev（开工登记）还是 review（评审会话） */
  role: SessionRole
  /** 会话在做什么，agent 自己给的一句话；应用里的标题读不到，只能靠它记 */
  title: string
  /** 登记时所在目录，通常就是工作区 */
  cwd: string
  /** 在 desktop 应用里打开这个会话的 deeplink；没有则为空串 */
  link: string
  created: string
  updated: string
}

interface SessionRow {
  req_id: string
  agent: string
  session: string
  role: string | null
  title: string | null
  cwd: string | null
  link: string | null
  created: string | null
  updated: string | null
}

/**
 * 一条待办。内容（标题、摘要）与需求一样从 md 同步进来，状态与来源类元数据只归库。
 */
export interface Todo {
  /** 首次入库日编号：T-YYYYMMDD-NNN */
  id: string
  title: string
  status: TodoStatus
  source: TodoSource | ''
  /** 来源 agent 会话（如 codex://threads/<id>）。source 为 agent / chat 时必有 */
  session: string
  /** 仅 feishu 来源：at_me（@我） / p2p（私聊） */
  channel: string
  /** 来源人 / 触发者 */
  origin: string
  /** 会话、群或上下文名 */
  chat: string
  /** 去重键：feishu 用 message_id，其余用来源稳定 id */
  ref: string
  /** 可跳转链接（飞书 thread、MR、页面） */
  link: string
  /** 源事件时间（yyyy-mm-dd HH:mm），可空 */
  happened: string
  /** 卡片摘要，从 md「摘要」段同步 */
  summary: string
  /** md 文件绝对路径 */
  path: string
  mtime: number
  created: string
  updated: string
  /** md 没了（被手工删过、或盘不在） */
  orphan: boolean
}

interface TodoRow {
  id: string
  title: string
  status: string
  source: string | null
  session: string | null
  channel: string | null
  origin: string | null
  chat: string | null
  ref: string | null
  link: string | null
  happened: string | null
  summary: string | null
  path: string
  mtime: number
  created: string | null
  updated: string | null
  orphan: number
}

interface Row {
  slug: string
  project: string
  id: string | null
  parent_id: string | null
  title: string
  path: string
  status: string
  priority: string | null
  summary: string | null
  repos: string | null
  links: string | null
  feishu_task_links: string | null
  code_links: string | null
  ext_links: string | null
  mtime: number
  updated: string | null
  orphan: number
}

function asStatus(value: string | null | undefined): Status | null {
  return value && (STATUSES as readonly string[]).includes(value) ? (value as Status) : null
}

function asPriority(value: string | null | undefined): Priority | null {
  return value && (PRIORITIES as readonly string[]).includes(value) ? (value as Priority) : null
}

function asTodoStatus(value: string | null | undefined): TodoStatus | null {
  return value && (TODO_STATUSES as readonly string[]).includes(value) ? (value as TodoStatus) : null
}

function asTodoSource(value: string | null | undefined): TodoSource | null {
  return value && (TODO_SOURCES as readonly string[]).includes(value) ? (value as TodoSource) : null
}

// ------------------------------------------------------------------ 链接

/** Normalize link fields: writers are the CLI / AI; sanitize once here */
export function normalizeLinkList(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('Link list must be an array')
  const out: string[] = []
  for (const item of input) {
    const url = String(item ?? '').trim()
    if (!url) continue
    if (!/^https?:\/\//i.test(url)) throw new Error(`Link must start with http(s)://: ${url}`)
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/**
 * 代码链接的写侧校验。老数据是纯 URL 字符串，新数据是 { label, url }，两种都收——
 * 合并旧列表时不会把老条目丢掉。
 */
export function normalizeCodeLinks(input: unknown): CodeLink[] {
  if (!Array.isArray(input)) throw new Error('Link list must be an array')
  const out: CodeLink[] = []
  for (const item of input) {
    const link = toCodeLink(item)
    if (!link.url) continue
    if (!/^https?:\/\//i.test(link.url)) throw new Error(`Link must start with http(s)://: ${link.url}`)
    if (!out.some((l) => l.url === link.url)) out.push(link)
  }
  return out
}

/** 一条代码链接的形状归一：字符串当纯 URL。读侧不校验——写进来时已经校验过 */
function toCodeLink(item: unknown): CodeLink {
  const raw = (typeof item === 'string' ? { url: item } : item) as Partial<CodeLink> | null
  return { label: String(raw?.label ?? '').trim(), url: String(raw?.url ?? '').trim() }
}

/** 读库里的 code_links 列：老格式（字符串数组）与新格式（对象数组）都认 */
function readCodeLinks(raw: string | null): CodeLink[] {
  const list = parseLinks<unknown[]>(raw, [])
  if (!Array.isArray(list)) return []
  return list.map(toCodeLink).filter((l) => l.url)
}

export function normalizeExtLinks(input: unknown): ExtLink[] {
  if (!Array.isArray(input)) throw new Error('Ext links must be an array')
  const out: ExtLink[] = []
  for (const item of input) {
    const obj = item as Partial<ExtLink> | null
    const detail = String(obj?.detail ?? '').trim()
    const url = String(obj?.url ?? '').trim()
    if (!detail && !url) continue
    if (!url) throw new Error(`Ext link is missing a url (detail: ${detail})`)
    if (!/^https?:\/\//i.test(url)) throw new Error(`Link must start with http(s)://: ${url}`)
    if (!detail) throw new Error(`Ext link is missing a detail: ${url}`)
    if (!out.some((l) => l.detail === detail && l.url === url)) out.push({ detail, url })
  }
  return out
}

/** 今天（YYYY-MM-DD）。多处写状态时间戳，集中一处避免格式漂移。 */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 待办的时间戳（本机时间，分钟粒度）：同一天里改过哪条，一眼能分出来。
 * 需求那边是日期粒度，这里多一档是有意的——待办一天里会翻好几次状态。
 */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 本机日期（yyyy-mm-dd）。待办 id 里的日期按本机时区算——人在哪儿，"今天"就是哪天 */
function localDay(): string {
  return stamp().slice(0, 10)
}

/** JSON 列解析。列可能存着 'null'，所以结果要允许 undefined，调用方用 ?? 兜底。 */
function parseLinks<T>(raw: string | null, fallback: T): T | undefined {
  if (!raw) return fallback
  try {
    return (JSON.parse(raw) as T | null) ?? undefined
  } catch {
    return fallback
  }
}

function toWorktree(row: WtRow): Worktree {
  return {
    id: row.id,
    requirementId: row.req_id,
    short: row.short,
    repo: row.repo,
    branch: row.branch,
    path: row.path,
    main: row.main,
    created: row.created ?? '',
    updated: row.updated ?? '',
    orphan: !!row.orphan,
  }
}

function toSession(row: SessionRow): Session {
  return {
    requirementId: row.req_id,
    agent: row.agent as SessionAgent,
    session: row.session,
    role: (row.role as SessionRole) ?? 'dev',
    title: row.title ?? '',
    cwd: row.cwd ?? '',
    link: row.link ?? '',
    created: row.created ?? '',
    updated: row.updated ?? '',
  }
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    // 非法值回落 todo：宁可让它回到未开始，也不要因为一个脏值让看板少一列
    status: asTodoStatus(row.status) ?? 'todo',
    source: asTodoSource(row.source) ?? '',
    session: row.session ?? '',
    channel: row.channel ?? '',
    origin: row.origin ?? '',
    chat: row.chat ?? '',
    ref: row.ref ?? '',
    link: row.link ?? '',
    happened: row.happened ?? '',
    summary: row.summary ?? '',
    path: row.path,
    mtime: row.mtime,
    created: row.created ?? '',
    updated: row.updated ?? '',
    orphan: !!row.orphan,
  }
}


export class BoardDatabase {
  readonly dataDir: string
  readonly file: string
  private db: DatabaseSync
  /** 当前看板展示的项目 */
  private activeProject = DEFAULT_PROJECT_SLUG

  /** 配置里记住的项目，pickProject() 用它做首选 */
  private preferredProject: string | undefined

  constructor(dataDir: string, preferredProject?: string) {
    this.dataDir = dataDir
    this.preferredProject = preferredProject
    this.file = join(dataDir, 'easy-flow.db')
    mkdirSync(dirname(this.file), { recursive: true })
    this.db = new DatabaseSync(this.file)
    // 应用与每个 agent 会话各持一个连接，写撞车时先等一会儿，别直接抛 SQLITE_BUSY
    this.db.exec('PRAGMA busy_timeout = 5000')
    applySchema(this.db)
  }

  /**
   * 选定当前项目。必须在 syncProjects() 之后调用——
   * 构造函数执行时 project 表还是空的，读不到任何项目。
   * 优先用上次记住的项目；它没了就退回第一个真实项目。
   */
  pickProject(): void {
    const projects = this.listProjects()
    const wanted = this.preferredProject ?? DEFAULT_PROJECT_SLUG
    if (projects.some((p) => p.slug === wanted)) {
      this.activeProject = wanted
    } else {
      this.activeProject = projects[0]?.slug ?? ''
    }
  }

  /**
   * 同步后校正当前项目。只有两种情况会改选：
   *   - 还没定过项目（首次启动）
   *   - 当前项目已不存在（被删或被改名）
   * 用户显式切换过的项目不会被这里覆盖。
   */
  private reconcileProject(): void {
    if (this.activeProject && this.listProjects().some((p) => p.slug === this.activeProject)) return
    this.pickProject()
  }

  close(): void {
    this.db.close()
  }

  get project(): string {
    return this.activeProject
  }

  /** 切到另一个项目；不存在则报错，避免静默落到空看板 */
  setProject(slug: string): void {
    if (!this.hasProject(slug)) throw new Error(`Project not found: ${slug}`)
    this.activeProject = slug
  }

  /**
   * 项目是否存在。判存在只查这一行——listProjects 为了列表展示要读规范文件、
   * 遍历子目录、逐项目 COUNT，接口的每个请求都拿它做参数校验的话太重。
   */
  hasProject(slug: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM project WHERE slug = ?').get(slug)
  }

  // ------------------------------------------------------------- 项目

  listProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM project ORDER BY mtime DESC')
      .all() as unknown as Array<{
      slug: string
      name: string
      root: string
      has_convention: number
      mtime: number
      updated: string | null
    }>

    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      root: r.root,
      hasConvention: !!r.has_convention,
      convention: r.has_convention ? readProjectConvention(r.root) : null,
      issues: projectIssues(r.slug, r.root),
      requirementCount: (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM requirement WHERE project = ?')
          .get(r.slug) as { n: number }
      ).n,
      mtime: r.mtime,
      updated: r.updated ?? '',
    }))
  }

  /** 侧边栏树：每个项目带上自己的需求列表（不切换当前项目） */
  tree(): Array<Project & { requirements: Requirement[] }> {
    const projects = this.listProjects()
    const stmt = this.db.prepare('SELECT * FROM requirement WHERE project = ? ORDER BY mtime DESC')
    return projects.map((p) => {
      const rows = stmt.all(p.slug) as unknown as Row[]
      return { ...p, requirements: rows.map((r) => this.toRequirement(r)) }
    })
  }

  /** 写项目总规范（项目根目录的 AGENTS.md）。内容格式不限，由用户决定。 */
  writeProjectConvention(slug: string, content: string): { path: string; bytes: number } {
    const row = this.db.prepare('SELECT root FROM project WHERE slug = ?').get(slug) as
      | { root: string }
      | undefined
    if (!row) throw new Error(`Project not found: ${slug}`)
    const file = join(row.root, 'AGENTS.md')
    writeFileSync(file, content, 'utf8')
    const bytes = Buffer.byteLength(content, 'utf8')
    this.db
      .prepare('UPDATE project SET has_convention = 1, mtime = ?, updated = ? WHERE slug = ?')
      .run(bytes, today(), slug)
    return { path: file, bytes }
  }

  /** 删除项目记录。落盘文件由调用方决定是否一并删除。 */
  deleteProject(slug: string): void {
    const exists = this.db.prepare('SELECT slug FROM project WHERE slug = ?').get(slug)
    if (!exists) throw new Error(`Project not found: ${slug}`)
    this.db
      .prepare(
        `DELETE FROM worktree WHERE req_id IN (
           SELECT id FROM requirement WHERE project = ? AND id IS NOT NULL AND id <> ''
         )`,
      )
      .run(slug)
    this.db
      .prepare(
        `DELETE FROM session WHERE req_id IN (
           SELECT id FROM requirement WHERE project = ? AND id IS NOT NULL AND id <> ''
         )`,
      )
      .run(slug)
    this.db.prepare('DELETE FROM doc WHERE project = ?').run(slug)
    this.db.prepare('DELETE FROM requirement WHERE project = ?').run(slug)
    this.db.prepare('DELETE FROM project WHERE slug = ?').run(slug)
  }

  // ------------------------------------------------------------- 同步

  /**
   * 把文件系统同步进数据库。目录结构：<dataDir>/<project>/<requirement>/
   *
   *   项目目录在、DB 无   → 新增项目
   *   需求目录在、DB 无   → 新增需求（status 默认澄清）
   *   需求目录在、DB 有   → 只更新标题/摘要/仓库/文档索引，绝不动 status/priority
   *   目录消失            → 标记孤儿，保留可见（状态不丢）
   *
   * worktree 一并校对，但只 stat 路径：它的归属是库里的关系，文件系统证明不了。
   */
  syncProjects(): {
    added: string[]
    updated: string[]
    orphaned: string[]
    restored: string[]
    worktrees: { orphaned: string[]; restored: string[] }
  } {
    // 模板随扫描补齐。这里是唯一扫 dataDir 的入口，看板/树/设置页/切换数据目录都会经过
    ensureTemplates(this.dataDir)
    const dirs = listProjectDirs(this.dataDir)
    const seenProjects = new Set<string>()
    const seenReqs = new Set<string>()
    const added: string[] = []
    const updated: string[] = []
    const restored: string[] = []

    const selectProject = this.db.prepare('SELECT slug FROM project WHERE slug = ?')
    const insertProject = this.db.prepare(
      'INSERT INTO project (slug, name, root, has_convention, mtime, updated) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const touchProject = this.db.prepare(
      'UPDATE project SET root = ?, name = ?, has_convention = ?, mtime = ? WHERE slug = ?',
    )

    const selectReq = this.db.prepare(
      'SELECT slug, mtime, orphan FROM requirement WHERE slug = ? AND project = ?',
    )
    const insertReq = this.db.prepare(
      `INSERT INTO requirement
         (slug, project, id, parent_id, title, path, status, priority, summary, repos, links,
          feishu_task_links, code_links, ext_links, mtime, updated, orphan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, 0)`,
    )
    const updateReq = this.db.prepare(
      `UPDATE requirement SET id = ?, parent_id = ?, title = ?, path = ?, summary = ?, repos = ?, links = ?, mtime = ?, orphan = 0
       WHERE slug = ? AND project = ?`,
    )
    const clearDocs = this.db.prepare('DELETE FROM doc WHERE slug = ? AND project = ?')
    const insertDoc = this.db.prepare(
      'INSERT INTO doc (slug, project, name, content) VALUES (?, ?, ?, ?)',
    )
    const idOwner = this.db.prepare('SELECT slug, project FROM requirement WHERE id = ?')

    /**
     * 一个 id 只能归一个需求。复制需求目录会带出两个同 id 的目录，
     * 那时唯一索引会让整个同步炸掉——宁可先不认，让它落进 missingIds()，
     * 由 assign_ids 重新发一个，也不要因为一个目录坏了整个看板打不开。
     */
    const claimId = (id: string, slug: string, project: string): string | null => {
      if (!id) return null
      const owner = idOwner.get(id) as { slug: string; project: string } | undefined
      return !owner || (owner.slug === slug && owner.project === project) ? id : null
    }

    for (const proj of dirs) {
      seenProjects.add(proj.slug)
      const convention = readProjectConvention(proj.root)
      const name = projectDisplayName(convention, proj.slug)
      let projectMtime = Date.now()

      if (!selectProject.get(proj.slug)) {
        insertProject.run(proj.slug, name, proj.root, convention ? 1 : 0, projectMtime, today())
      } else {
        touchProject.run(proj.root, name, convention ? 1 : 0, projectMtime, proj.slug)
      }

      // 本次扫描里 slug → 需求在库里的 id。子需求的 parent_id 直接从这里取——
      // 父需求先于子需求入列（listRequirementDirs 先收录再下探）
      const idBySlug = new Map<string, string>()

      for (const { dir, slug: relSlug } of listRequirementDirs(proj.root)) {
        const parsed = parseRequirement(dir, relSlug)
        const key = `${proj.slug}/${parsed.slug}`
        seenReqs.add(key)

        const id = claimId(parsed.id, parsed.slug, proj.slug)
        if (id) idBySlug.set(parsed.slug, id)
        // 父需求 = slug 去掉最后一段。父需求自己还没 id 时留空，
        // 层级仍能从 slug 推出来，不因为它缺 id 就把整棵树拆散
        const cut = parsed.slug.lastIndexOf('/')
        const parentId = cut === -1 ? '' : (idBySlug.get(parsed.slug.slice(0, cut)) ?? '')

        clearDocs.run(parsed.slug, proj.slug)
        for (const d of parsed.docs) insertDoc.run(parsed.slug, proj.slug, d.name, d.content)

        // 取所有文档中最新的修改时间。
        // 之前这里写的是 content.length 之和，于是「最近更新优先」实际变成「文档越长越靠前」。
        const mtime = parsed.docs.reduce((latest, d) => Math.max(latest, d.mtime), 0)
        const existing = selectReq.get(parsed.slug, proj.slug) as
          | { slug: string; mtime: number; orphan: number }
          | undefined

        if (!existing) {
          // 新记录一律从「澄清」起步。曾经从 md 的 frontmatter 读初始状态，
          // 但那套约定已废弃——状态（status/priority）只归 sqlite；
          // title/name 这类「内容」仍从文件读，两者不要混。
          insertReq.run(
            parsed.slug,
            proj.slug,
            id,
            parentId,
            parsed.title,
            dir,
            '澄清',
            null,
            parsed.summary,
            JSON.stringify(parsed.repos),
            parsed.links,
            mtime,
            today(),
          )
          added.push(key)
        } else {
          updateReq.run(
            id,
            parentId,
            parsed.title,
            dir,
            parsed.summary,
            JSON.stringify(parsed.repos),
            parsed.links,
            mtime,
            parsed.slug,
            proj.slug,
          )
          if (existing.orphan) restored.push(key)
          else updated.push(key)
        }
      }
    }

    const orphaned: string[] = []
    const all = this.db
      .prepare('SELECT slug, project, orphan FROM requirement')
      .all() as Array<{ slug: string; project: string; orphan: number }>
    const markOrphan = this.db.prepare(
      'UPDATE requirement SET orphan = 1 WHERE slug = ? AND project = ?',
    )
    for (const r of all) {
      if (!seenReqs.has(`${r.project}/${r.slug}`) && !r.orphan) {
        markOrphan.run(r.slug, r.project)
        orphaned.push(`${r.project}/${r.slug}`)
      }
    }

    this.reconcileProject()
    return { added, updated, orphaned, restored, worktrees: this.syncWorktrees() }
  }

  /** worktree 的存活校对：只 stat，不跑 git——这条路每次刷看板都会走 */
  private syncWorktrees(): { orphaned: string[]; restored: string[] } {
    const orphaned: string[] = []
    const restored: string[] = []
    const rows = this.db
      .prepare('SELECT id, path, orphan FROM worktree')
      .all() as unknown as Array<{ id: string; path: string; orphan: number }>
    const setOrphan = this.db.prepare('UPDATE worktree SET orphan = ? WHERE id = ?')
    for (const w of rows) {
      const alive = existsSync(w.path)
      if (!alive && !w.orphan) {
        setOrphan.run(1, w.id)
        orphaned.push(w.id)
      } else if (alive && w.orphan) {
        setOrphan.run(0, w.id)
        restored.push(w.id)
      }
    }
    return { orphaned, restored }
  }

  // ------------------------------------------------------------- 读取

  private toRequirement(row: Row): Requirement {
    const status = asStatus(row.status) ?? '澄清'
    const docs = this.db
      .prepare(
        'SELECT name, length(content) AS size FROM doc WHERE slug = ? AND project = ? ORDER BY name',
      )
      .all(row.slug, row.project) as Array<{ name: string; size: number }>

    return {
      slug: row.slug,
      project: row.project,
      id: row.id ?? '',
      parentId: row.parent_id ?? '',
      title: row.title,
      status,
      priority: asPriority(row.priority) ?? '',
      summary: row.summary ?? '',
      repos: row.repos ? (JSON.parse(row.repos) as RepoRef[]) : [],
      links: row.links ?? '',
      feishuTaskLinks: parseLinks<string[]>(row.feishu_task_links, []) ?? [],
      codeLinks: readCodeLinks(row.code_links),
      extLinks: parseLinks<ExtLink[]>(row.ext_links, []) ?? [],
      docs,
      path: row.path,
      mtime: row.mtime,
      updated: row.updated ?? '',
    }
  }

  /** 指定项目下的需求 */
  listIn(project: string): Requirement[] {
    const rows = this.db
      .prepare('SELECT * FROM requirement WHERE project = ? ORDER BY mtime DESC')
      .all(project) as unknown as Row[]
    return rows.map((r) => this.toRequirement(r))
  }

  /** 当前项目下的需求 */
  list(): Requirement[] {
    return this.listIn(this.activeProject)
  }

  /** 在指定项目内按 slug 找需求 */
  get(slug: string, project = this.activeProject): Requirement | undefined {
    const row = this.db
      .prepare('SELECT * FROM requirement WHERE slug = ? AND project = ?')
      .get(slug, project) as unknown as Row | undefined
    return row ? this.toRequirement(row) : undefined
  }

  /** 全文检索：限定在当前项目内 */
  search(query: string): Set<string> {
    const q = query.trim().toLowerCase()
    if (!q) return new Set()
    const terms = q.split(/\s+/).filter(Boolean)
    const p = this.activeProject
    const haystack = new Map<string, string>()

    for (const row of this.db
      .prepare('SELECT * FROM requirement WHERE project = ?')
      .all(p) as unknown as Row[]) {
      haystack.set(
        row.slug,
        `${row.title}\n${row.slug}\n${row.summary ?? ''}\n${row.repos ?? ''}`.toLowerCase(),
      )
    }
    for (const d of this.db
      .prepare('SELECT slug, name, content FROM doc WHERE project = ?')
      .all(p) as Array<{ slug: string; name: string; content: string }>) {
      haystack.set(d.slug, `${haystack.get(d.slug) ?? ''}\n${d.name}\n${d.content}`.toLowerCase())
    }

    const hits = new Set<string>()
    for (const [slug, text] of haystack) {
      if (terms.every((t) => text.includes(t))) hits.add(slug)
    }
    return hits
  }

  /** 某个需求的完整上下文（含文档全文） */
  context(slug: string, project = this.activeProject): { requirement: Requirement; docs: DocFile[] } | null {
    const requirement = this.get(slug, project)
    if (!requirement) return null
    const docs = this.db
      .prepare('SELECT name, content FROM doc WHERE slug = ? AND project = ? ORDER BY name')
      .all(slug, project) as unknown as DocFile[]
    return { requirement, docs }
  }

  /** 读需求目录下的原始 requirement.md（需求描述的原文） */
  readRequirementMd(slug: string, project = this.activeProject): string | null {
    const req = this.get(slug, project)
    if (!req) return null
    return readTextOrNull(join(req.path, 'requirement.md'))
  }

  /**
   * 按需求 id 反查。id 是写在 AGENTS.md 里的身份，改名、换项目、换 worktree 都不影响它，
   * 所以"我属于哪个需求"只认这一条——不拿路径去猜。
   */
  byId(id: string): Requirement | undefined {
    const row = this.db.prepare('SELECT * FROM requirement WHERE id = ?').get(id) as unknown as
      | Row
      | undefined
    return row ? this.toRequirement(row) : undefined
  }

  /**
   * 需求的祖先链，从近到远（父、祖父……）。
   * slug 里带着层级（parent/child），逐段去掉最后一段查即可，不用递归查库。
   */
  ancestors(req: Requirement): Requirement[] {
    const out: Requirement[] = []
    let slug = req.slug
    for (let cut = slug.lastIndexOf('/'); cut !== -1; cut = slug.lastIndexOf('/')) {
      slug = slug.slice(0, cut)
      const parent = this.get(slug, req.project)
      if (!parent) break
      out.push(parent)
    }
    return out
  }

  /** 直接子需求。父需求没有 id 时返回空——关系靠 id 承载 */
  children(parentId: string): Requirement[] {
    if (!parentId) return []
    const rows = this.db
      .prepare('SELECT * FROM requirement WHERE parent_id = ? ORDER BY slug')
      .all(parentId) as unknown as Row[]
    return rows.map((r) => this.toRequirement(r))
  }

  /** 还没拿到 id 的需求（frontmatter 里缺 id 的老需求） */
  missingIds(): Array<{ slug: string; project: string; path: string }> {
    return this.db
      .prepare('SELECT slug, project, path FROM requirement WHERE id IS NULL OR id = ?')
      .all('') as unknown as Array<{ slug: string; project: string; path: string }>
  }

  // ------------------------------------------------------------- 写入

  setStatus(slug: string, status: Status, project = this.activeProject): Requirement {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Unknown status ${status}. Valid: ${STATUSES.join(' / ')}`)
    }
    const info = this.db
      .prepare('UPDATE requirement SET status = ?, updated = ? WHERE slug = ? AND project = ?')
      .run(status, today(), slug, project)
    if (info.changes === 0) throw new Error(`Requirement not found: ${project}/${slug}`)
    return this.get(slug, project)!
  }

  setPriority(slug: string, priority: Priority | '', project = this.activeProject): Requirement {
    if (priority && !(PRIORITIES as readonly string[]).includes(priority)) {
      throw new Error(`Unknown priority ${priority}. Valid: ${PRIORITIES.join(' / ')}`)
    }
    const info = this.db
      .prepare('UPDATE requirement SET priority = ?, updated = ? WHERE slug = ? AND project = ?')
      .run(priority || null, today(), slug, project)
    if (info.changes === 0) throw new Error(`Requirement not found: ${project}/${slug}`)
    return this.get(slug, project)!
  }

  rename(slug: string, title: string, project = this.activeProject): Requirement {
    const info = this.db
      .prepare('UPDATE requirement SET title = ? WHERE slug = ? AND project = ?')
      .run(title, slug, project)
    if (info.changes === 0) throw new Error(`Requirement not found: ${project}/${slug}`)
    return this.get(slug, project)!
  }

  /**
   * Update a requirement's external links. Written by the CLI (the UI has no manual edit);
   * 传 undefined 表示该字段不变，传数组表示整体替换。
   */
  setLinks(
    slug: string,
    links: { feishuTaskLinks?: unknown; codeLinks?: unknown; extLinks?: unknown },
    project = this.activeProject,
  ): Requirement {
    if (!this.get(slug, project)) throw new Error(`Requirement not found: ${project}/${slug}`)

    const sets: string[] = []
    const params: string[] = []
    if (links.feishuTaskLinks !== undefined) {
      sets.push('feishu_task_links = ?')
      params.push(JSON.stringify(normalizeLinkList(links.feishuTaskLinks)))
    }
    if (links.codeLinks !== undefined) {
      sets.push('code_links = ?')
      params.push(JSON.stringify(normalizeCodeLinks(links.codeLinks)))
    }
    if (links.extLinks !== undefined) {
      sets.push('ext_links = ?')
      params.push(JSON.stringify(normalizeExtLinks(links.extLinks)))
    }
    if (!sets.length) throw new Error('No link fields to update')

    sets.push('updated = ?')
    params.push(today())

    this.db
      .prepare(`UPDATE requirement SET ${sets.join(', ')} WHERE slug = ? AND project = ?`)
      .run(...params, slug, project)

    return this.get(slug, project)!
  }

  // ------------------------------------------------------------- worktree

  /** 某个需求名下的 worktree；不传则全部。按仓库排，列表稳定好读 */
  listWorktrees(requirementId?: string): Worktree[] {
    // 判 undefined 而不是真假：需求没 id 时传进来的是空串，
    // 那表示"它名下不可能有工作区"，不是"列出全部"
    const rows = (
      requirementId === undefined
        ? this.db.prepare('SELECT * FROM worktree ORDER BY created, repo').all()
        : this.db
            .prepare('SELECT * FROM worktree WHERE req_id = ? ORDER BY created, repo')
            .all(requirementId)
    ) as unknown as WtRow[]
    return rows.map(toWorktree)
  }

  worktreeById(id: string): Worktree | undefined {
    const row = this.db.prepare('SELECT * FROM worktree WHERE id = ?').get(id) as unknown as
      | WtRow
      | undefined
    return row ? toWorktree(row) : undefined
  }

  worktreeByPath(path: string): Worktree | undefined {
    const row = this.db.prepare('SELECT * FROM worktree WHERE path = ?').get(path) as unknown as
      | WtRow
      | undefined
    return row ? toWorktree(row) : undefined
  }

  /**
   * 登记一个 worktree。path 是幂等键：一条语句 upsert，同路径重复登记只刷新字段，
   * id 与 created 保持第一次的值——那个 id 已经写进 worktree 自己的 AGENTS.md 了。
   */
  addWorktree(input: {
    id: string
    requirementId: string
    short?: string
    repo: string
    branch: string
    path: string
    main: string
  }): Worktree {
    this.db
      .prepare(
        `INSERT INTO worktree (id, req_id, short, repo, branch, path, main, created, updated, orphan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(path) DO UPDATE SET
           req_id = excluded.req_id, short = excluded.short, repo = excluded.repo,
           branch = excluded.branch, main = excluded.main, updated = excluded.updated, orphan = 0`,
      )
      .run(
        input.id,
        input.requirementId,
        input.short ?? '',
        input.repo,
        input.branch,
        input.path,
        input.main,
        today(),
        today(),
      )
    return this.worktreeByPath(input.path)!
  }

  /** 只删记录。目录与 git 登记归 worktree 层处理 */
  removeWorktree(id: string): boolean {
    return this.db.prepare('DELETE FROM worktree WHERE id = ?').run(id).changes > 0
  }

  // ------------------------------------------------------------- 会话

  /**
   * 需求名下的会话；不传则全部。最近登记的在前——同时开着几个 agent 时，
   * 正在做的那条应该在最上面。需求没 id 时传进来的是空串，表示"它名下不可能有会话"。
   */
  listSessions(requirementId?: string): Session[] {
    const rows = (
      requirementId === undefined
        ? this.db.prepare('SELECT * FROM session ORDER BY updated DESC, agent').all()
        : this.db
            .prepare('SELECT * FROM session WHERE req_id = ? ORDER BY updated DESC, agent')
            .all(requirementId)
    ) as unknown as SessionRow[]
    return rows.map(toSession)
  }

  /**
   * 登记一个会话。agent + 会话 id 是幂等键：同一个会话重新登记只刷新字段，
   * created 保持第一次的值——它记的是"这个会话什么时候开始做这条需求"。
   */
  addSession(input: {
    requirementId: string
    agent: SessionAgent
    session: string
    role?: SessionRole
    title?: string
    cwd?: string
    link?: string
  }): Session {
    if (!(SESSION_AGENTS as readonly string[]).includes(input.agent)) {
      throw new Error(`Unknown agent: ${input.agent}. Valid: ${SESSION_AGENTS.join(', ')}`)
    }
    const role = input.role ?? 'dev'
    if (!(SESSION_ROLES as readonly string[]).includes(role)) {
      throw new Error(`Unknown session role: ${role}. Valid: ${SESSION_ROLES.join(', ')}`)
    }
    if (!input.session.trim()) throw new Error('Session id cannot be empty')
    const now = stamp()
    this.db
      .prepare(
        `INSERT INTO session (req_id, agent, session, role, title, cwd, link, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent, session) DO UPDATE SET
           req_id = excluded.req_id, role = excluded.role, title = excluded.title,
           cwd = excluded.cwd, link = excluded.link, updated = excluded.updated`,
      )
      .run(
        input.requirementId,
        input.agent,
        input.session,
        role,
        input.title ?? '',
        input.cwd ?? '',
        input.link ?? '',
        now,
        now,
      )
    return this.sessionBy(input.agent, input.session)!
  }

  sessionBy(agent: SessionAgent, session: string): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM session WHERE agent = ? AND session = ?')
      .get(agent, session) as unknown as SessionRow | undefined
    return row ? toSession(row) : undefined
  }

  /** 只删记录：会话本身在 agent 应用里，这里动不了它 */
  removeSession(agent: SessionAgent, session: string): boolean {
    return this.db
      .prepare('DELETE FROM session WHERE agent = ? AND session = ?')
      .run(agent, session).changes > 0
  }

  // ------------------------------------------------------------- 待办

  /**
   * 把 <dataDir>/_todos/ 同步进库。与需求同一套规矩：
   *   md 在、库无 → 新增（status 默认 todo，来源等元数据留空，由调用方补）
   *   md 在、库有 → 只更新标题/摘要/路径/时间，绝不动 status 与来源
   *   md 没了    → 标记孤儿，保留可见
   * 待办是全局的，不分项目，所以这里不看 project 表。
   */
  syncTodos(): { added: string[]; updated: string[]; orphaned: string[]; restored: string[] } {
    const seen = new Set<string>()
    const added: string[] = []
    const updated: string[] = []
    const restored: string[] = []

    const select = this.db.prepare('SELECT id, orphan FROM todo WHERE id = ?')
    const insert = this.db.prepare(
      `INSERT INTO todo (id, title, status, source, summary, path, mtime, created, updated, orphan)
       VALUES (?, ?, 'todo', '', ?, ?, ?, ?, ?, 0)`,
    )
    const update = this.db.prepare(
      'UPDATE todo SET title = ?, summary = ?, path = ?, mtime = ?, orphan = 0 WHERE id = ?',
    )

    for (const f of listTodoFiles(this.dataDir)) {
      seen.add(f.id)
      const existing = select.get(f.id) as { id: string; orphan: number } | undefined
      if (!existing) {
        const at = stamp()
        insert.run(f.id, f.title || f.id, f.summary, f.file, f.mtime, at, at)
        added.push(f.id)
      } else {
        update.run(f.title || f.id, f.summary, f.file, f.mtime, f.id)
        if (existing.orphan) restored.push(f.id)
        else updated.push(f.id)
      }
    }

    const orphaned: string[] = []
    const mark = this.db.prepare('UPDATE todo SET orphan = 1 WHERE id = ?')
    const rows = this.db.prepare('SELECT id, orphan FROM todo').all() as unknown as Array<{
      id: string
      orphan: number
    }>
    for (const r of rows) {
      if (!seen.has(r.id) && !r.orphan) {
        mark.run(r.id)
        orphaned.push(r.id)
      }
    }
    return { added, updated, orphaned, restored }
  }

  /** 全部待办，最近动过的在前 */
  listTodos(): Todo[] {
    const rows = this.db
      .prepare('SELECT * FROM todo ORDER BY updated DESC, id DESC')
      .all() as unknown as TodoRow[]
    return rows.map(toTodo)
  }

  todoById(id: string): Todo | undefined {
    const row = this.db.prepare('SELECT * FROM todo WHERE id = ?').get(id) as unknown as
      | TodoRow
      | undefined
    return row ? toTodo(row) : undefined
  }

  /** 按去重键反查。feishu 来源的 ref 是 message_id，用它挡住同一消息重复入库 */
  todoByRef(ref: string): Todo | undefined {
    const row = this.db.prepare('SELECT * FROM todo WHERE ref = ?').get(ref) as unknown as
      | TodoRow
      | undefined
    return row ? toTodo(row) : undefined
  }

  /**
   * 下一个待办 id：按首次入库日编号（T-YYYYMMDD-NNN），当天从 001 递增。
   * 沿用旧 todo 板的编号法，历史条目搬进来不用换 id。
   */
  nextTodoId(): string {
    const prefix = `T-${localDay().replace(/-/g, '')}-`
    const row = this.db
      .prepare('SELECT id FROM todo WHERE id LIKE ? ORDER BY id DESC LIMIT 1')
      .get(`${prefix}%`) as { id: string } | undefined
    const last = row ? Number(row.id.slice(prefix.length)) || 0 : 0
    return `${prefix}${String(last + 1).padStart(3, '0')}`
  }

  /** 登记一条待办。md 由调用方先落盘（createTodoDoc），这里只管库 */
  addTodo(input: {
    id: string
    title: string
    status?: TodoStatus
    source?: string
    session?: string
    channel?: string
    origin?: string
    chat?: string
    ref?: string
    link?: string
    happened?: string
    summary?: string
    path: string
    mtime?: number
    /** 迁移历史条目时用它保住原来的时间线；不传就用当前时间 */
    created?: string
    updated?: string
  }): Todo {
    const status = input.status ?? 'todo'
    if (!(TODO_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Unknown status ${status}. Valid: ${TODO_STATUSES.join(' / ')}`)
    }
    if (input.source && !asTodoSource(input.source)) {
      throw new Error(`Unknown source ${input.source}. Valid: ${TODO_SOURCES.join(' / ')}`)
    }
    const at = stamp()
    this.db
      .prepare(
        `INSERT INTO todo
           (id, title, status, source, session, channel, origin, chat, ref, link, happened,
            summary, path, mtime, created, updated, orphan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.id,
        input.title,
        status,
        input.source ?? '',
        input.session ?? '',
        input.channel ?? '',
        input.origin ?? '',
        input.chat ?? '',
        input.ref ?? '',
        input.link ?? '',
        input.happened ?? '',
        input.summary ?? '',
        input.path,
        input.mtime ?? 0,
        input.created || at,
        input.updated || at,
      )
    return this.todoById(input.id)!
  }

  setTodoStatus(id: string, status: TodoStatus): Todo {
    if (!(TODO_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Unknown status ${status}. Valid: ${TODO_STATUSES.join(' / ')}`)
    }
    const info = this.db
      .prepare('UPDATE todo SET status = ?, updated = ? WHERE id = ?')
      .run(status, stamp(), id)
    if (info.changes === 0) throw new Error(`Todo not found: ${id}`)
    return this.todoById(id)!
  }

  /**
   * 改只归库的那几个字段（来源、会话、去重键、链接……）。
   * undefined 表示不动，空串表示清空。标题与摘要是 md 的内容，不从这里改。
   */
  setTodoFields(
    id: string,
    patch: {
      source?: string
      session?: string
      channel?: string
      origin?: string
      chat?: string
      ref?: string
      link?: string
      happened?: string
    },
  ): Todo {
    if (patch.source && !asTodoSource(patch.source)) {
      throw new Error(`Unknown source ${patch.source}. Valid: ${TODO_SOURCES.join(' / ')}`)
    }
    const columns: Record<string, string | undefined> = {
      source: patch.source,
      session: patch.session,
      channel: patch.channel,
      origin: patch.origin,
      chat: patch.chat,
      ref: patch.ref,
      link: patch.link,
      happened: patch.happened,
    }
    const sets: string[] = []
    const params: Array<string | null> = []
    for (const [col, value] of Object.entries(columns)) {
      if (value === undefined) continue
      sets.push(`${col} = ?`)
      params.push(value || null)
    }
    if (!sets.length) throw new Error('No fields to update')
    sets.push('updated = ?')
    params.push(stamp())

    const info = this.db.prepare(`UPDATE todo SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    if (info.changes === 0) throw new Error(`Todo not found: ${id}`)
    return this.todoById(id)!
  }

  /** 读待办 md 原文。路径从库里取，不接受调用方给的路径 */
  readTodoDoc(id: string): { path: string; content: string } {
    const todo = this.todoById(id)
    if (!todo) throw new Error(`Todo not found: ${id}`)
    const content = readTextOrNull(todo.path)
    if (content === null) throw new Error(`Cannot read todo file: ${todo.path}`)
    return { path: todo.path, content }
  }

  /** 写回 md，不留备份（版本历史交给 git）。写完顺手同步一次，标题与摘要跟着更新 */
  writeTodoDoc(id: string, content: string): { path: string; bytes: number } {
    const todo = this.todoById(id)
    if (!todo) throw new Error(`Todo not found: ${id}`)
    writeFileSync(todo.path, content, 'utf8')
    this.syncTodos()
    return { path: todo.path, bytes: Buffer.byteLength(content, 'utf8') }
  }
}
