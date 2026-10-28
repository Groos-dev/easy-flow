/**
 * 看板每一列内的顺序：按需求名下 agent 会话的最后活跃时刻倒序，最近动过的在最上面。
 */
import { sessionActive } from './threads'
import type { Requirement, Session } from './types'

// 活跃时刻并列时的次序：p0 在前，没设优先级的排最后
const PRIORITY_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

/**
 * 需求 id → 名下会话的最后活跃时刻，口径见 threads 的 sessionActive。
 * 都没有活跃记录的需求不在表里，排序时按 0 算。
 */
export function lastActiveByReq(
  sessionsByReq: ReadonlyMap<string, readonly Session[]>,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const [reqId, sessions] of sessionsByReq) {
    let at = 0
    for (const s of sessions) at = Math.max(at, sessionActive(s))
    if (at > 0) map.set(reqId, at)
  }
  return map
}

/**
 * 列内重排：活跃时刻倒序，并列时按优先级。
 * 「其余保持原有相对顺序」依赖 sort 的稳定性。
 */
export function orderColumn(
  items: readonly Requirement[],
  lastActive: ReadonlyMap<string, number>,
): Requirement[] {
  return [...items].sort(
    (a, b) =>
      (lastActive.get(b.id) ?? 0) - (lastActive.get(a.id) ?? 0) ||
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9),
  )
}
