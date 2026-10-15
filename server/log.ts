export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 }

export function levelFromEnv(raw: string | undefined): LogLevel {
  const v = (raw ?? '').trim().toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : 'info'
}

export const logLevel = levelFromEnv(process.env.EASY_FLOW_LOG)
const threshold = RANK[logLevel]

export function formatLine(level: Exclude<LogLevel, 'silent'>, scope: string, msg: string, at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  return `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`
}

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void
  info(msg: string, ...rest: unknown[]): void
  warn(msg: string, ...rest: unknown[]): void
  error(msg: string, ...rest: unknown[]): void
}

export function createLogger(scope: string): Logger {
  const emit =
    (level: Exclude<LogLevel, 'silent'>) =>
    (msg: string, ...rest: unknown[]): void => {
      if (RANK[level] < threshold) return
      const line = formatLine(level, scope, msg)
      if (level === 'warn' || level === 'error') console.error(line, ...rest)
      else console.log(line, ...rest)
    }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
