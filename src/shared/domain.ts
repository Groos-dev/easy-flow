// Enum objects also work with the CLI's native TypeScript stripping; runtime TypeScript enums do not.
/* Stable wire values. Labels belong to the language catalogs, never to persistence. */
export const RequirementStatus = {
  Clarification: 'clarification',
  InProgress: 'in_progress',
  Review: 'review',
  Completed: 'completed',
} as const
export type RequirementStatus = (typeof RequirementStatus)[keyof typeof RequirementStatus]

export const TodoState = {
  Todo: 'todo',
  InProgress: 'in_progress',
  Done: 'done',
  Cancelled: 'cancelled',
} as const
export type TodoState = (typeof TodoState)[keyof typeof TodoState]

export const PriorityLevel = {
  Critical: 'p0',
  High: 'p1',
  Medium: 'p2',
  Low: 'p3',
} as const
export type PriorityLevel = (typeof PriorityLevel)[keyof typeof PriorityLevel]

export const SessionState = {
  Idle: 'idle',
  Thinking: 'thinking',
  Working: 'working',
  Compacting: 'sweeping',
  Done: 'done',
  Blocked: 'blocked',
  Failed: 'failed',
  Unknown: 'unknown',
} as const
export type SessionState = (typeof SessionState)[keyof typeof SessionState]

export const REQUIREMENT_STATUSES = Object.values(RequirementStatus)
export const TODO_STATES = Object.values(TodoState)
export const PRIORITY_LEVELS = Object.values(PriorityLevel)
export const SESSION_STATES = Object.values(SessionState)

/* Input compatibility only. Never use translated labels as persisted state again. */
const legacyRequirementStatuses: Record<string, RequirementStatus> = {
  澄清: RequirementStatus.Clarification,
  执行中: RequirementStatus.InProgress,
  Review: RequirementStatus.Review,
  已完成: RequirementStatus.Completed,
}

export function normalizeRequirementStatus(value: unknown): RequirementStatus | undefined {
  if (typeof value !== 'string') return undefined
  return REQUIREMENT_STATUSES.includes(value as RequirementStatus)
    ? value as RequirementStatus
    : Object.hasOwn(legacyRequirementStatuses, value) ? legacyRequirementStatuses[value] : undefined
}

export const AgentId = {
  Claude: 'claude',
  Codex: 'codex',
  Cursor: 'cursor',
  Chengxiaobang: 'chengxiaobang',
  Antigravity: 'antigravity',
} as const
export type AgentId = (typeof AgentId)[keyof typeof AgentId]

export const TodoOrigin = {
  Feishu: 'feishu',
  Chat: 'chat',
  Agent: 'agent',
  Manual: 'manual',
} as const
export type TodoOrigin = (typeof TodoOrigin)[keyof typeof TodoOrigin]

export const ThemeMode = {
  System: 'system',
  Light: 'light',
  Dark: 'dark',
} as const
export type ThemeMode = (typeof ThemeMode)[keyof typeof ThemeMode]

export const NotificationPreference = {
  Never: 'never',
  Unfocused: 'unfocused',
  Always: 'always',
} as const
export type NotificationPreference = (typeof NotificationPreference)[keyof typeof NotificationPreference]

export const SessionAnalysisState = {
  Pending: 'pending',
  Completed: 'completed',
  Skipped: 'skipped',
} as const
export type SessionAnalysisState = (typeof SessionAnalysisState)[keyof typeof SessionAnalysisState]

export const LogSeverity = {
  Debug: 'debug',
  Info: 'info',
  Warning: 'warn',
  Error: 'error',
  Silent: 'silent',
} as const
export type LogSeverity = (typeof LogSeverity)[keyof typeof LogSeverity]

export const NextUpLevel = {
  Now: 'now',
  Soon: 'soon',
} as const
export type NextUpLevel = (typeof NextUpLevel)[keyof typeof NextUpLevel]

export const CodeLinkState = {
  Open: 'open',
  Merged: 'merged',
  Closed: 'closed',
} as const
export type CodeLinkState = (typeof CodeLinkState)[keyof typeof CodeLinkState]

export const PipelineState = {
  Success: 'success',
  Failed: 'failed',
  Running: 'running',
  Skipped: 'skipped',
} as const
export type PipelineState = (typeof PipelineState)[keyof typeof PipelineState]
