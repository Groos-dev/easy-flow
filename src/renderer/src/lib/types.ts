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

// 与 server/db.ts 的 CodeLink 对应。label 是显示别名，空串表示没给，由展示层从 url 推导
export interface CodeLink {
  label: string
  url: string
}

// 取不到时接口不返回该条，界面也就不挂状态
export type CodeLinkState = 'open' | 'merged' | 'closed'

// 流水线只取汇总；没跑过或 PR 为 null
export type PipelineState = 'success' | 'failed' | 'running' | 'skipped'

export interface CodeLinkStatus {
  state: CodeLinkState
  pipeline: PipelineState | null
}

// 与 server/db.ts 的 Worktree 对应。归属只存在库里，UI 只读
export interface Worktree {
  id: string
  // 所属需求的 id
  requirementId: string
  // 需求里的短名（涉及仓库表的短名列），可能为空
  short: string
  repo: string
  branch: string
  path: string
  // 主 checkout 路径
  main: string
  created: string
  updated: string
  // 目录已失联（被手工删过、或盘不在）
  missing: boolean
}

// 状态即看板列，两者是同一个东西
export type Status = '澄清' | '执行中' | 'Review' | '已完成'

export interface Requirement {
  slug: string
  // 所属项目
  project: string
  // 不透明需求 id（AGENTS.md frontmatter 里那个 req-xxxxxxxxxx）
  id: string
  // 父需求的 id；顶层需求为空串。slug 里也带着层级（parent/child）
  parentId: string
  title: string
  status: string
  priority: string
  summary: string
  repos: RepoRef[]
  links: string
  // Feishu task links. Written by the CLI; the UI is read-only
  feishuTaskLinks: string[]
  // Code links (GitLab MR / GitHub PR). Written by the CLI; the UI is read-only
  codeLinks: CodeLink[]
  // 扩展链接：detail 是描述，url 是链接
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

// 父需求卡片上的子需求完成度
export interface ChildStat {
  total: number
  done: number
}

export interface SyncResult {
  added: string[]
  updated: string[]
  missing: string[]
  restored: string[]
  // 工作区的存量校对（只 stat 路径，不跑 git）
  worktrees: { missing: string[]; restored: string[] }
}

export interface BoardData {
  requirements: Requirement[]
  // 内容版本：没变时看板跳过提交，见 App 的 applyIfChanged
  rev: string
  // 当前项目
  project: string
  // 当前项目的显示名（取自项目根 AGENTS.md 的 frontmatter，缺省是目录名）
  projectName: string
  // 看板列顺序，也就是状态取值顺序
  statuses: Status[]
  priorities: string[]
  // 本次读取时做的增量同步，用于提示"新增了几个需求"
  sync: SyncResult
}

// ------------------------------------------------------------------ 待办

// 待办的状态即待办看板的列。字面量沿用 todo skill 的取值，不译成中文
export type TodoStatus = 'todo' | 'in_progress' | 'done' | 'cancelled'

// 状态字面量是给 agent 用的，界面上给人看中文。看板列与详情页共用这一份
export const TODO_STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消',
}

// 与 server/db.ts 的 Todo 对应。内容（标题、摘要）从 md 同步，其余只归库
export interface Todo {
  id: string
  title: string
  status: TodoStatus
  // 空串表示没记来源
  source: string
  session: string
  // 仅 feishu 来源：at_me / p2p
  channel: string
  // 来源人 / 触发者
  origin: string
  // 会话、群或上下文名
  chat: string
  ref: string
  // 立项后的所属需求 id（req-…）。空串表示还没挂
  requirementId: string
  link: string
  happened: string
  summary: string
  // md 文件绝对路径
  path: string
  mtime: number
  created: string
  updated: string
  missing: boolean
}

export interface TodosPayload {
  todos: Todo[]
  rev: string
  // 看板列顺序，也就是状态取值顺序
  statuses: TodoStatus[]
  sources: string[]
  sync: { added: string[]; updated: string[]; missing: string[]; restored: string[] }
}

// ------------------------------------------------------------------ 项目

export interface Project {
  slug: string
  name: string
  root: string
  hasConvention: boolean
  convention: string | null
  // 目录不合规范之处，只读提示（空数组即合规）
  issues: string[]
  requirementCount: number
  mtime: number
  updated: string
}

// ------------------------------------------------------------------ 载荷

export type LaunchAgent = 'claude' | 'codex' | 'chengxiaobang' | 'cursor'

export interface LaunchProviderInfo {
  id: LaunchAgent
  label: string
  requiresWorktree?: boolean
}

export interface LaunchResult {
  agent: LaunchAgent
  url: string
  prompt: string
  opened: boolean
  error?: string
  promptCopied?: boolean
}

export interface ContextPayload {
  requirement: Requirement
  docs: Array<{ name: string; content: string }>
  requirementMd: string | null
  // 这个需求名下的工作区
  worktrees: Worktree[]
  // 这个需求上登记的 agent 会话。只归库，详情页的「会话」块靠它
  sessions: Session[]
  // 挂在这条需求上的待办（todo 侧存指针）。只归库，详情页的「关联待办」块靠它
  todos: Todo[]
  // 由来源会话推出、但指针没回填的待办。只是提示，没有进库
  candidateTodos: Todo[]
}

// 会话的实时状态。字面量与 server/session-state.ts 的 THREAD_STATES 一致
export type ThreadState = 'idle' | 'thinking' | 'working' | 'sweeping' | 'done' | 'blocked' | 'failed' | 'unknown'

// 与 server/session-state.ts 的 SessionStatus 对应。hook 驱动优先，落盘兜底
export interface SessionStatus {
  state: ThreadState
  // 需要人介入时，要人回答的那句话原文；其余为空串
  needsAction: string
  // 这条状态的时刻（epoch ms）；说不出时刻为 0。展示时才格式化成 yyyy-mm-dd HH:mm
  observedAt: number
  // 判据出处
  detail: string
}

// 与 server/action.ts 的 SessionAction 对应
export interface SessionAction {
  // 展示文案，形如「改 hook.ts」
  text: string
  // 这次工具调用发生的时刻（epoch ms）
  calledAt: number
}

// 一条 agent 会话的登记（claude code / codex / cursor / chengxiaobang）
export interface Session {
  requirementId: string
  agent: string
  // agent 原生的会话 id
  session: string
  // 会话在做什么；应用里的标题读不到，是 agent 登记时自己给的
  title: string
  // 登记时所在目录，通常就是工作区
  cwd: string
  // 在 desktop 应用里打开这个会话的 deeplink；没有则为空串
  link: string
  created: string
  updated: string
  status: SessionStatus
  // 最近一次工具调用（气泡里那句「在干什么」）；没有就是 null
  action: SessionAction | null
}

/**
 * 「下一步该动哪个」的一条推荐。名次与理由都由服务端算好（见 server/next-up.ts），
 * 渲染层只负责展示与跳转——理由要「说人话」，那套措辞留在服务端一处。
 */
export interface NextUpItem {
  slug: string
  project: string
  title: string
  // 需求状态，界面上并排摆一枚小药丸
  status: string
  // 两级：现在就得动 / 有空再看
  level: 'now' | 'soon'
  // 命中的档位，1 最硬、4 最软
  tier: number
  // 一句话理由，中文
  reason: string
  // 第二行的补充；没有则空串
  detail: string
  // 命中的会话；没有会话信号时是 null，据此决定回会话还是开需求
  session: { agent: string; link: string } | null
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

// 详情页默认打开方式。default 是配置里记的 id，空串 = 访达；missing 表示该 app 已不在本机
export interface OpenWithOption {
  id: string
  label: string
  kind: 'finder' | 'editor' | 'terminal'
  icon: string
}

export interface OpenWithPayload {
  default: string
  missing: boolean
  options: OpenWithOption[]
}

export interface AgentSkill {
  id: 'claude' | 'cursor' | 'codex' | 'chengxiaobang'
  label: string
  // That agent's skills dir; it may not exist when the agent is not installed
  dir: string
  available: boolean
  linked: boolean
}

export type HookAgentId = 'claude' | 'codex' | 'chengxiaobang' | 'cursor'

// 与 server/hook-install.ts 的 HookAgentStatus 对应。status 一律读真文件得出
export interface HookAgentStatus {
  id: HookAgentId
  label: string
  // 用户级配置文件
  file: string
  installed: boolean
  // 装了几个事件
  events: number
  // 指向的地址与端口
  url: string
  // 读文件出的问题；正常为空串
  problem: string
}

export interface HookPlan {
  port: number
  agents: HookAgentStatus[]
}

export interface SkillPayload {
  // The skill entity and CLI entry inside the repo; null when the environment does not allow it
  source: string | null
  // 仓库 skill 根目录下的 skill 清单
  skills: string[]
  cli: string | null
  problem: string | null
  shim: { path: string; installed: boolean }
  // node resolved from a login shell; running .ts directly needs >= 22.18
  node: { path: string; version: string } | null
  agents: AgentSkill[]
  // Legacy MCP registrations still present; installing removes them
  legacyMcp: Array<{ id: 'claude' | 'codex'; label: string; registered: boolean }>
}

// 装 / 卸的结果：成功只给一句结论，没做成的步骤带原因（含路径）
export interface InstallOutcome {
  summary: string
  failed: string[]
}
