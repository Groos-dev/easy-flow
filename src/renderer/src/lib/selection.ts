/**
 * 列表选中的解析与移动。
 *
 * 选中记的是条目 key，不是下标：展开 / 收起需求会往列表里插删动作行，
 * 下标会跟着漂——展开别人之后，选中就落到了对方的子行上。
 * 纯函数，mini 面板与测试共用这一份。
 */

/**
 * 把选中的 key 落成当前列表里真实存在的那一条：
 * 还在就原样用；它随父需求收起被删了，退回父需求那一行；父需求也没了（被过滤掉）就取第一条。
 */
export function resolveKey(keys: string[], selected: string): string {
  if (keys.includes(selected)) return selected
  const parent = selected.split('|')[0]
  if (keys.includes(parent)) return parent
  return keys[0] ?? ''
}

// 上下移动一格；已经在头 / 尾就留在原地
export function moveKey(keys: string[], selected: string, step: 1 | -1): string {
  const cur = resolveKey(keys, selected)
  return keys[keys.indexOf(cur) + step] ?? cur
}
