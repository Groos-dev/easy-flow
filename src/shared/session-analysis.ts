import { SessionAnalysisState } from './domain.ts'
import { t as tr } from "./i18n.ts"
export const SESSION_ANALYSIS_STATUSES = Object.values(SessionAnalysisState)

export type SessionAnalysisStatus = SessionAnalysisState

export const SESSION_ANALYSIS_LABELS: Record<SessionAnalysisStatus, string> = {
  get pending() { return tr("Pending analysis") },
  get completed() { return tr("Analyzed") },
  get skipped() { return tr("Analysis skipped") },
}
