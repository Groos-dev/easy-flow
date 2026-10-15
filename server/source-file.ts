import { statSync } from 'node:fs'

export interface SourceRow {
  mtimeMs: number
  offset: number
  /** 那份文件 fold 出来的东西：rollout 是 SessionStatus，codex 的未读集合是 id 数组 */
  state: unknown
}

export interface SourceTable {
  source(path: string): SourceRow | undefined
  listSources(): Array<{ path: string } & SourceRow>
  touchSource(path: string, patch: Partial<SourceRow>): void
}

/** 这份文件自上次读过之后变没变。没记过 / stat 不到都算变——宁可重读一遍 */
export function changed(sources: SourceTable, path: string): boolean {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return true
  }
  return sources.source(path)?.mtimeMs !== mtimeMs
}
