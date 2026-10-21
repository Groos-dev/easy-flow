/** 看板键盘焦点的位置计算 */

export interface BoardColumn {
  status: string
  slugs: string[]
}

export interface BoardPos {
  status: string
  index: number
}

export type BoardDir = 'up' | 'down' | 'left' | 'right'

export function posOf(columns: BoardColumn[], slug: string): BoardPos | null {
  if (!slug) return null
  for (const col of columns) {
    const index = col.slugs.indexOf(slug)
    if (index >= 0) return { status: col.status, index }
  }
  return null
}

function firstPos(columns: BoardColumn[]): BoardPos | null {
  const col = columns.find((c) => c.slugs.length > 0)
  return col ? { status: col.status, index: 0 } : null
}

/** 左右跳过空列，越界时夹到目标列最后一张 */
export function movePos(
  columns: BoardColumn[],
  current: BoardPos | null,
  dir: BoardDir,
): BoardPos | null {
  if (!current) return firstPos(columns)

  const idx = columns.findIndex((c) => c.status === current.status)
  if (idx < 0) return firstPos(columns)
  const col = columns[idx]
  if (!col.slugs.length) return firstPos(columns)

  if (dir === 'up' || dir === 'down') {
    const delta = dir === 'down' ? 1 : -1
    const next = current.index + delta
    if (next < 0 || next >= col.slugs.length) return current
    return { status: col.status, index: next }
  }

  const step = dir === 'right' ? 1 : -1
  for (let i = idx + step; i >= 0 && i < columns.length; i += step) {
    const target = columns[i]
    if (!target.slugs.length) continue
    return { status: target.status, index: Math.min(current.index, target.slugs.length - 1) }
  }
  return current
}

export function slugAt(columns: BoardColumn[], pos: BoardPos | null): string {
  if (!pos) return ''
  return columns.find((c) => c.status === pos.status)?.slugs[pos.index] ?? ''
}

/**
 * 一组停靠点里按 step 挪一格，走到头绕回另一头。
 * 卡片上的 Tab 循环用它：0 号是卡片本身，后面是卡片里的 agent 头像。
 */
export function cycleIndex(count: number, at: number, step: 1 | -1): number {
  return (at + step + count) % count
}
