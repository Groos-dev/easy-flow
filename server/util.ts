/**
 * 值的小工具：形状不对就当没有。
 *
 * 与 fsutil 一个路子——读不到、解不开、类型不对，在这里收敛成 null / 空串，
 * 让调用点少写一层错误分支。
 */

/** 不是字符串就当空串 */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** JSON 解不开就当没有：空串、半截、根本不是 JSON 都走这条路 */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
