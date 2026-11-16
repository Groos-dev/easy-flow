import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'
import { LOG_LEVELS, type LogLevel } from '../src/shared/log-level.ts'
export { LOG_LEVELS } from '../src/shared/log-level.ts'
export type { LogLevel } from '../src/shared/log-level.ts'

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 }

export function levelFromEnv(raw: string | undefined): LogLevel {
  const v = (raw ?? '').trim().toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : 'info'
}

export let logLevel = levelFromEnv(process.env.EASY_FLOW_LOG)
let logFile = ''

export function setLogLevel(level: LogLevel): void {
  logLevel = level
}

export function startFileLogging(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true })
  logFile = file
  const prune = () => {
    if (!existsSync(file)) return
    const cutoff = Date.now() - 24 * 60 * 60_000
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => {
      if (!line) return false
      const at = Date.parse(line.slice(0, 23).replace(' ', 'T'))
      return !Number.isNaN(at) && at >= cutoff
    })
    writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '')
  }
  prune()
  const timer = setInterval(prune, 60_000)
  timer.unref()
  return () => {
    clearInterval(timer)
    logFile = ''
  }
}

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
      if (RANK[level] < RANK[logLevel]) return
      const line = formatLine(level, scope, format(msg, ...rest).replace(/\r?\n/g, ' '))
      if (logFile) {
        appendFileSync(logFile, `${line}\n`)
        return
      }
      if (level === 'warn' || level === 'error') console.error(line)
      else console.log(line)
    }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
