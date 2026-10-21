/**
 * 快捷键的翻译层：键盘事件 → Electron accelerator，accelerator → 人看的符号。
 * 纯函数，设置页的录制框与测试共用这一份。
 */

/** 事件里能当快捷键用的具名键 → accelerator 里的写法。认不出的键一律拒绝 */
const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}

/** 单个键的 accelerator 写法；认不出返回空串 */
function keyName(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()
  return NAMED_KEYS[key] ?? ''
}

export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * 键盘事件 → accelerator。返回空串表示这个组合不能用：
 * 键认不出，或者没带 ⌘ / ⌃ / ⌥——只有 Shift 的组合会把日常打字全吃掉。
 */
export function acceleratorFromEvent(e: KeyEventLike, platform: string): string {
  const key = keyName(e.key)
  if (!key) return ''
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return ''

  const mods: string[] = []
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, key].join('+')
}

/** 修饰键的显示符号：mac 用符号，其它平台用名字 */
const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Super: '⌘',
  Meta: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
}

const PC_NAMES: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  Command: 'Super',
  Cmd: 'Super',
  Control: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
}

/** 方向键这类键的符号，只有 mac 用。两种写法都收：录制给的是 Up，手改配置的人可能写 ArrowUp */
const MAC_KEY_SYMBOLS: Record<string, string> = {
  Up: '↑',
  ArrowUp: '↑',
  Down: '↓',
  ArrowDown: '↓',
  Left: '←',
  ArrowLeft: '←',
  Right: '→',
  ArrowRight: '→',
  Return: '↩',
  Enter: '↩',
  Escape: 'Esc',
}

/** 键盘上印不出符号的键，两端用同一套短写法 */
const PC_KEY_NAMES: Record<string, string> = {
  Return: 'Enter',
  Escape: 'Esc',
  Space: 'Space',
}

export function acceleratorKeys(accel: string, platform: string): string[] {
  const mac = platform === 'darwin'
  return accel
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (mac ? MAC_SYMBOLS[p] ?? MAC_KEY_SYMBOLS[p] ?? p : PC_NAMES[p] ?? PC_KEY_NAMES[p] ?? p))
}

export function formatAccelerator(accel: string, platform: string): string {
  return acceleratorKeys(accel, platform).join(platform === 'darwin' ? '' : '+')
}
