import { LogSeverity } from './domain.ts'
export const LOG_LEVELS = Object.values(LogSeverity)
export type LogLevel = LogSeverity

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}
