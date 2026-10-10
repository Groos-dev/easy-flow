/**
 * 与服务端契约对应的类型。
 *
 * 渲染层只经 HTTP 拿到 JSON，没有编译期保证，所以这份声明是那层契约的档案：
 * 服务端改了字段名不会在这里报错，只能靠测试与代码审查对齐。
 */

// ------------------------------------------------------------------ 需求

export interface RepoRef {
  short: string
  repo?: string
}

export interface DocRef {
  name: string
  size: number
}

/** 与 server/db.ts 的 CodeLink 对应。label 是显示别名，空串表示没给，由展示层从 url 推导 */
export interface CodeLink {
  label: string
  url: string
}

/** 与 server/db.ts 的 Worktree 对应。归属只存在库里，UI 只读 */
export interface Worktree {
  id: string
  /** 所属需求的 id */
  requirementId: string
  /** 需求里的短名（涉及仓库表的短名列），可能为空 */
  short: string
  repo: string
  branch: string
  path: string
  /** 主 checkout 路径 */
  main: string
  created: string
  updated: string
  /** 目录已失联（被手工删过、或盘不在） */
  orphan: boolean
}

/** 状态即看板列，两者是同一个东西 */
export type Status = '澄清' | '执行中' | 'Review' | '已完成'

export interface Requirement {
  slug: string
  /** 所属项目 */
  project: string
  /** 不透明需求 id（AGENTS.md frontmatter 里那个 req-xxxxxxxxxx）*/
  id: string
  /** 父需求的 id；顶层需求为空串。slug 里也带着层级（parent/child） */
  parentId: string
  title: string
  status: string
  priority: string
  summary: string
  repos: RepoRef[]
  links: string
  /** Feishu task links. Written by the CLI; the UI is read-only */
  feishuTaskLinks: string[]
  /** Code links (GitLab MR / GitHub PR). Written by the CLI; the UI is read-only */
  codeLinks: CodeLink[]
  /** 扩展链接：detail 是描述，url 是链接 */
  extLinks: Array<{ detail: string; url: string }>
  docs: DocRef[]
  path: string
  mtime: number
  updated: string
  /**
   * 本次同步的增量，随列表与单条更新一起下发。
   * 渲染层目前只有设置页在读它（切数据目录 / 重新扫描那份），别处不看。
   */
  sync?: SyncResult
}

export interface SyncResult {
  added: string[]
  updated: string[]
  orphaned: string[]
  restored: string[]
  /** 工作区的存量校对（只 stat 路径，不跑 git） */
  worktrees: { orphaned: string[]; restored: string[] }
}

export interface BoardData {
  requirements: Requirement[]
  /** 当前项目 */
  project: string
  /** 当前项目的显示名（取自项目根 AGENTS.md 的 frontmatter，缺省是目录名） */
  projectName: string
  /** 看板列顺序，也就是状态取值顺序 */
  statuses: Status[]
  priorities: string[]
  /** 本次读取时做的增量同步，用于提示"新增了几个需求" */
  sync: SyncResult
}

// ------------------------------------------------------------------ 待办

/** 待办的状态即待办看板的列。字面量沿用 todo skill 的取值，不译成中文 */
export type TodoStatus = 'todo' | 'in_progress' | 'done' | 'cancelled'

/** 状态字面量是给 agent 用的，界面上给人看中文。看板列与详情页共用这一份 */
export const TODO_STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消',
}

/** 与 server/db.ts 的 Todo 对应。内容（标题、摘要）从 md 同步，其余只归库 */
export interface Todo {
  id: string
  title: string
  status: TodoStatus
  /** 空串表示没记来源 */
  source: string
  session: string
  /** 仅 feishu 来源：at_me / p2p */
  channel: string
  /** 来源人 / 触发者 */
  origin: string
  /** 会话、群或上下文名 */
  chat: string
  ref: string
  link: string
  happened: string
  summary: string
  /** md 文件绝对路径 */
  path: string
  mtime: number
  created: string
  updated: string
  orphan: boolean
}

export interface TodosPayload {
  todos: Todo[]
  /** 看板列顺序，也就是状态取值顺序 */
  statuses: TodoStatus[]
  sources: string[]
  sync: { added: string[]; updated: string[]; orphaned: string[]; restored: string[] }
}

// ------------------------------------------------------------------ 项目

export interface Project {
  slug: string
  name: string
  root: string
  hasConvention: boolean
  convention: string | null
  /** 目录不合规范之处，只读提示（空数组即合规） */
  issues: string[]
  requirementCount: number
  mtime: number
  updated: string
}

// ------------------------------------------------------------------ 载荷

export interface ContextPayload {
  requirement: Requirement
  docs: Array<{ name: string; content: string }>
  requirementMd: string | null
  /** 这个需求名下的工作区 */
  worktrees: Worktree[]
  /** 这个需求上登记的 agent 会话。只归库，详情页的「会话」块靠它 */
  sessions: Session[]
}

/** 一条 agent 会话的登记（claude code / codex / cursor） */
export interface Session {
  requirementId: string
  agent: string
  /** agent 原生的会话 id */
  session: string
  /** 会话在做什么；应用里的标题读不到，是 agent 登记时自己给的 */
  title: string
  /** 登记时所在目录，通常就是工作区 */
  cwd: string
  /** 在 desktop 应用里打开这个会话的 deeplink；没有则为空串 */
  link: string
  created: string
  updated: string
}

export interface SwitchResult {
  dataDir: string
  dbFile: string
  previous?: string
  unchanged?: boolean
  sync: SyncResult | null
}

export interface SettingsPayload {
  dataDir: string
  dbFile: string
  defaultDataDir: string
  counts: { requirements: number; projects: number }
}

export interface AgentSkill {
  id: 'claude' | 'cursor' | 'codex'
  label: string
  /** That agent's skills dir; it may not exist when the agent is not installed */
  dir: string
  available: boolean
  linked: boolean
}

export interface SkillPayload {
  /** The skill entity and CLI entry inside the repo; null when the environment does not allow it */
  source: string | null
  /** 仓库 skill 根目录下的 skill 清单 */
  skills: string[]
  cli: string | null
  problem: string | null
  shim: { path: string; installed: boolean }
  /** node resolved from a login shell; running .ts directly needs >= 22.18 */
  node: { path: string; version: string } | null
  agents: AgentSkill[]
  /** Legacy MCP registrations still present; installing removes them */
  legacyMcp: Array<{ id: 'claude' | 'codex'; label: string; registered: boolean }>
}
