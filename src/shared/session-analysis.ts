export const SESSION_ANALYSIS_STATUSES = ['pending', 'completed', 'skipped'] as const

export type SessionAnalysisStatus = (typeof SESSION_ANALYSIS_STATUSES)[number]

export const SESSION_ANALYSIS_LABELS: Record<SessionAnalysisStatus, string> = {
  pending: '待分析',
  completed: '已分析',
  skipped: '已跳过分析',
}
