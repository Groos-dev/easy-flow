/**
 * 父需求与子需求在版面上的连接。
 *
 * 父子在卡片上是散开的：`byStatus` 只按状态分列，子需求跟着自己的状态去别的列，
 * 父需求旁边看不出这串活还剩几块。父需求卡片上那行 `1/3` 补的是「还剩几块」，
 * 铺开后的子需求清单补的是「它们在哪」。
 *
 * 只算「子需求全完成」，不算父需求该不该收尾——父需求自己可能还有整体验收，收不收由人看着办。
 */
import type { ChildStat, Requirement, Status } from './types'

// 看板的终态。子需求完成度按它算
export const DONE_STATUS: Status = '已完成'

// 父需求 id → 子需求完成度。没有子需求的需求不出现在表里
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

/**
 * 父需求 id → 直接子需求。父需求铺开后靠它把子需求列出来——只有条数的话，
 * 知道还剩几块也找不到它们在哪。
 *
 * 未完成的排在前面：清单是拿来接着干活的，已经收掉的沉底。
 */
export function childrenOf(reqs: Requirement[]): Map<string, Requirement[]> {
  const map = new Map<string, Requirement[]>()
  for (const r of reqs) {
    if (!r.parentId) continue
    const list = map.get(r.parentId)
    if (list) list.push(r)
    else map.set(r.parentId, [r])
  }
  for (const list of map.values()) list.sort(byPending)
  return map
}

// 稳定的两分：未完成在前，已完成在后
function byPending(a: Requirement, b: Requirement): number {
  return Number(a.status === DONE_STATUS) - Number(b.status === DONE_STATUS)
}
