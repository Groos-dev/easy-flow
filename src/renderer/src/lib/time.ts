// 相对时间。看板卡片与 mini 面板共用一份，免得两处口径漂移
export function relTime(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

/**
 * 解析库里的 "yyyy-mm-dd HH:mm" 本机时间戳（会话的 updated 是这种）。
 * 换成 T 再交给 Date 解析：带空格的写法各引擎口径不一，别赌。
 * 空串或解析不出返回 0，好在 Math.max 里被忽略。
 */
export function parseStamp(s: string): number {
  const t = Date.parse(s.trim().replace(' ', 'T'))
  return Number.isNaN(t) ? 0 : t
}
