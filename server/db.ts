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
import { join, dirname, basename } from 'node:path'
import {
  listProjectDirs,
  listRequirementDirs,
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
  title: string
  status: Status
  priority: Priority | ''
  summary: string
  repos: RepoRef[]
  links: string
  /** 飞书任务（Meego story）链接。写入入口留给 MCP，UI 只读 */
  feishuTaskLinks: string[]
  /** 代码链接：GitLab MR / GitHub PR 等。写入入口留给 MCP，UI 只读 */
  codeLinks: string[]
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

interface Row {
  slug: string
  project: string
  id: string | null
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

// ------------------------------------------------------------------ 链接

/** 链接字段的规范化：写入方是 MCP / AI，这里做一次清洗 */
export function normalizeLinkList(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('链接列表必须是数组')
  const out: string[] = []
  for (const item of input) {
    const url = String(item ?? '').trim()
    if (!url) continue
    if (!/^https?:\/\//i.test(url)) throw new Error(`链接必须以 http(s):// 开头：${url}`)
    if (!out.includes(url)) out.push(url)
  }
  return out
}

export function normalizeExtLinks(input: unknown): ExtLink[] {
  if (!Array.isArray(input)) throw new Error('扩展链接必须是数组')
  const out: ExtLink[] = []
  for (const item of input) {
    const obj = item as Partial<ExtLink> | null
    const detail = String(obj?.detail ?? '').trim()
    const url = String(obj?.url ?? '').trim()
    if (!detail && !url) continue
    if (!url) throw new Error(`扩展链接缺少 url（描述：${detail}）`)
    if (!/^https?:\/\//i.test(url)) throw new Error(`链接必须以 http(s):// 开头：${url}`)
    if (!detail) throw new Error(`扩展链接缺少描述：${url}`)
    if (!out.some((l) => l.detail === detail && l.url === url)) out.push({ detail, url })
  }
  return out
}

/** 今天（YYYY-MM-DD）。多处写状态时间戳，集中一处避免格式漂移。 */
function today(): string {
  return new Date().toISOString().slice(0, 10)
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
    if (!this.hasProject(slug)) throw new Error(`项目不存在: ${slug}`)
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
    if (!row) throw new Error(`项目不存在: ${slug}`)
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
    if (!exists) throw new Error(`项目不存在: ${slug}`)
    this.db
      .prepare(
        `DELETE FROM worktree WHERE req_id IN (
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
         (slug, project, id, title, path, status, priority, summary, repos, links,
          feishu_task_links, code_links, ext_links, mtime, updated, orphan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, 0)`,
    )
    const updateReq = this.db.prepare(
      `UPDATE requirement SET id = ?, title = ?, path = ?, summary = ?, repos = ?, links = ?, mtime = ?, orphan = 0
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

      for (const dir of listRequirementDirs(proj.root)) {
        const parsed = parseRequirement(dir, basename(dir))
        const key = `${proj.slug}/${parsed.slug}`
        seenReqs.add(key)

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
            claimId(parsed.id, parsed.slug, proj.slug),
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
            claimId(parsed.id, parsed.slug, proj.slug),
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
      title: row.title,
      status,
      priority: asPriority(row.priority) ?? '',
      summary: row.summary ?? '',
      repos: row.repos ? (JSON.parse(row.repos) as RepoRef[]) : [],
      links: row.links ?? '',
      feishuTaskLinks: parseLinks<string[]>(row.feishu_task_links, []) ?? [],
      codeLinks: parseLinks<string[]>(row.code_links, []) ?? [],
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

  /** 还没拿到 id 的需求（frontmatter 里缺 id 的老需求） */
  missingIds(): Array<{ slug: string; project: string; path: string }> {
    return this.db
      .prepare('SELECT slug, project, path FROM requirement WHERE id IS NULL OR id = ?')
      .all('') as unknown as Array<{ slug: string; project: string; path: string }>
  }

  // ------------------------------------------------------------- 写入

  setStatus(slug: string, status: Status, project = this.activeProject): Requirement {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`未知状态 ${status}。合法取值：${STATUSES.join(' / ')}`)
    }
    const info = this.db
      .prepare('UPDATE requirement SET status = ?, updated = ? WHERE slug = ? AND project = ?')
      .run(status, today(), slug, project)
    if (info.changes === 0) throw new Error(`需求不存在: ${project}/${slug}`)
    return this.get(slug, project)!
  }

  setPriority(slug: string, priority: Priority | '', project = this.activeProject): Requirement {
    if (priority && !(PRIORITIES as readonly string[]).includes(priority)) {
      throw new Error(`未知优先级 ${priority}。合法取值：${PRIORITIES.join(' / ')}`)
    }
    const info = this.db
      .prepare('UPDATE requirement SET priority = ?, updated = ? WHERE slug = ? AND project = ?')
      .run(priority || null, today(), slug, project)
    if (info.changes === 0) throw new Error(`需求不存在: ${project}/${slug}`)
    return this.get(slug, project)!
  }

  rename(slug: string, title: string, project = this.activeProject): Requirement {
    const info = this.db
      .prepare('UPDATE requirement SET title = ? WHERE slug = ? AND project = ?')
      .run(title, slug, project)
    if (info.changes === 0) throw new Error(`需求不存在: ${project}/${slug}`)
    return this.get(slug, project)!
  }

  /**
   * 更新需求的外部链接。写入入口留给 MCP（UI 不提供手动编辑）；
   * 传 undefined 表示该字段不变，传数组表示整体替换。
   */
  setLinks(
    slug: string,
    links: { feishuTaskLinks?: unknown; codeLinks?: unknown; extLinks?: unknown },
    project = this.activeProject,
  ): Requirement {
    if (!this.get(slug, project)) throw new Error(`需求不存在: ${project}/${slug}`)

    const sets: string[] = []
    const params: string[] = []
    if (links.feishuTaskLinks !== undefined) {
      sets.push('feishu_task_links = ?')
      params.push(JSON.stringify(normalizeLinkList(links.feishuTaskLinks)))
    }
    if (links.codeLinks !== undefined) {
      sets.push('code_links = ?')
      params.push(JSON.stringify(normalizeLinkList(links.codeLinks)))
    }
    if (links.extLinks !== undefined) {
      sets.push('ext_links = ?')
      params.push(JSON.stringify(normalizeExtLinks(links.extLinks)))
    }
    if (!sets.length) throw new Error('没有需要更新的链接字段')

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
}
