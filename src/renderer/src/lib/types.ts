/** 与 server/db.ts 的 Requirement 对应 */

export interface RepoRef {
  short: string
  repo?: string
}

export interface DocRef {
  name: string
  size: number
}

/** 状态即看板列，两者是同一个东西 */
export type Status = '澄清' | '执行中' | 'Review' | '已完成'

export interface Requirement {
  slug: string
  /** 所属项目 */
  project: string
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
  /** 本次同步做的增量（仅详情页刷新用） */
  sync?: SyncResult
}

export interface SyncResult {
  added: string[]
  updated: string[]
  orphaned: string[]
  restored: string[]
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

export interface Settings {
  dataDir: string
  dbFile: string
  defaultDataDir: string
  counts: { requirements: number }
}

