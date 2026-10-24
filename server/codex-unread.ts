import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceTable } from './source-file.ts'

const FILE = '.codex-global-state.json'

interface CodexGlobalState {
  'electron-thread-read-state-v1'?: {
    unreadByIdentity?: Record<string, Record<string, unknown>>
  }
}

// 官方未读集合。读不到（文件不在、坏了、被锁）返回 null——调用方据此不降档
export function codexUnread(codexHome: string, sources: SourceTable): Set<string> | null {
  const path = join(codexHome, FILE)
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }
  const known = sources.source(path)
  if (known && known.mtimeMs === mtimeMs) return new Set(known.state as string[])

  let parsed: CodexGlobalState
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as CodexGlobalState
  } catch {
    return null
  }

  const ids = new Set<string>()
  const byIdentity = parsed['electron-thread-read-state-v1']?.unreadByIdentity
  for (const hosts of Object.values(byIdentity ?? {})) {
    for (const list of Object.values(hosts ?? {})) {
      if (!Array.isArray(list)) continue
      for (const id of list) if (typeof id === 'string') ids.add(id)
    }
  }
  sources.touchSource(path, { mtimeMs, state: [...ids] })
  return ids
}
