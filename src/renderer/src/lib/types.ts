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
  /** 飞书任务链接。由 MCP 写入，UI 只读 */
  feishuTaskLinks: string[]
  /** 代码链接（GitLab MR / GitHub PR）。由 MCP 写入，UI 只读 */
  codeLinks: string[]
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
  terminalFontFamily: string
  terminalFontSize: number
  counts: { requirements: number; projects: number }
}

export interface AppearancePayload {
  terminalFontFamily: string
  terminalFontSize: number
}

export interface AgentMcp {
  id: 'claude' | 'codex'
  label: string
  configFile: string
  installed: boolean
}

export interface McpPayload {
  /** MCP server 入口文件，环境不允许时为 null */
  entry: string | null
  problem: string | null
  agents: AgentMcp[]
}
