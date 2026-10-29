// 看板键盘焦点的位置计算

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

// 左右跳过空列，越界时夹到目标列最后一张
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

export interface PetRef {
  slug: string
  session: string
}

/**
 * 沿看板顺序走下一个 pet 落点。
 *
 * 当前停在某张卡的 pet 上时先走这张卡里剩下的 pet。
 * 走完再落到后面第一张有 pet 的卡。
 * 到末尾绕回开头。
 * 当前停在卡上、还没进 pet 时，先落这张卡的第一只。
 */
export function nextPetStop(
  columns: BoardColumn[],
  petsOf: (slug: string) => readonly string[],
  current: { pos: BoardPos | null; session: string },
): PetRef | null {
  const order = columns.flatMap((col) => col.slugs)
  if (!order.length) return null

  const at = current.pos ? order.indexOf(slugAt(columns, current.pos)) : -1
  if (at >= 0) {
    const pets = petsOf(order[at])
    const index = current.session ? pets.indexOf(current.session) : -1
    if (index + 1 < pets.length) return { slug: order[at], session: pets[index + 1] }
  }
  for (let step = 1; step <= order.length; step += 1) {
    const slug = order[(at + step) % order.length]
    const pets = petsOf(slug)
    if (pets.length) return { slug, session: pets[0] }
  }
  return null
}
