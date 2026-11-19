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

export function slugAt(columns: BoardColumn[], pos: BoardPos | null): string {
  if (!pos) return ''
  return columns.find((c) => c.status === pos.status)?.slugs[pos.index] ?? ''
}

export interface FocusRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface FocusCardCandidate {
  kind: 'card'
  slug: string
  rect: FocusRect
}

export interface FocusDoneCandidate {
  kind: 'done-bar'
  rect: FocusRect
}

export type FocusCandidate = FocusCardCandidate | FocusDoneCandidate

/**
 * 按屏幕几何找方向上的下一个落点。
 *
 * 主轴取沿方向的中心距离，侧向偏移乘 2 计入代价：
 * 同一排的相邻卡优先于斜下方的更近卡，置顶横向排列也能按左右走。
 * 方向上没有候选时返回 null。
 */
export function nextCandidateInDirection(
  current: FocusRect,
  candidates: readonly FocusCandidate[],
  dir: BoardDir,
): FocusCandidate | null {
  const cx = (current.left + current.right) / 2
  const cy = (current.top + current.bottom) / 2
  let best: { candidate: FocusCandidate; score: number } | null = null

  for (const c of candidates) {
    const dx = (c.rect.left + c.rect.right) / 2 - cx
    const dy = (c.rect.top + c.rect.bottom) / 2 - cy
    let along: number
    let across: number
    if (dir === 'right') {
      if (c.rect.left <= current.right) continue
      along = dx
      across = Math.abs(dy)
    } else if (dir === 'left') {
      if (c.rect.right >= current.left) continue
      along = -dx
      across = Math.abs(dy)
    } else if (dir === 'down') {
      if (c.rect.top <= current.bottom) continue
      along = dy
      across = Math.abs(dx)
    } else {
      if (c.rect.bottom >= current.top) continue
      along = -dy
      across = Math.abs(dx)
    }
    const score = along + across * 2
    if (!best || score < best.score) best = { candidate: c, score }
  }
  return best?.candidate ?? null
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
