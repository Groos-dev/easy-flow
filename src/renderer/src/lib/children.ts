/**
 * 父需求在版面上的完成度。
 *
 * 父子在卡片上是散开的：`byStatus` 只按状态分列，子需求跟着自己的状态去别的列，
 * 父需求旁边看不出这串活还剩几块。父需求卡片上那行 `1/3` 就是补这个的。
 *
 * 只算「子需求全完成」，不算父需求该不该收尾——父需求自己可能还有整体验收，收不收由人看着办。
 */
import type { ChildStat, Requirement, Status } from './types'

/** 看板的终态。子需求完成度按它算 */
export const DONE_STATUS: Status = '已完成'

/** 父需求 id → 子需求完成度。没有子需求的需求不出现在表里 */
export function childStatsOf(reqs: Requirement[]): Map<string, ChildStat> {
  const map = new Map<string, ChildStat>()
  for (const r of reqs) {
    if (!r.parentId) continue
    const stat = map.get(r.parentId) ?? { total: 0, done: 0 }
    stat.total += 1
    if (r.status === DONE_STATUS) stat.done += 1
    map.set(r.parentId, stat)
  }
  return map
}
