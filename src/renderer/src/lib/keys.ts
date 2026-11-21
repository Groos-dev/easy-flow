import { t as tr } from "../../../shared/i18n.ts"
// 键位定义与匹配；设置页、按钮提示与键盘处理共用

import { formatAccelerator } from './shortcut'

export type KeyContext =
  | 'global'
  | 'board'
  | 'pet'
  | 'next'
  | 'detail'
  | 'info'
  | 'launch'
  | 'search'
  | 'mini'
  | 'map'
  | 'settings'

export interface ShortcutDef {
  id: string
  context: KeyContext
  // Electron accelerator 写法；一个动作有多个等价键就都列出来
  keys: string[]
  label: string
  // 设置页不列（由录制框单独展示的全局呼出键）
  hidden?: boolean
  // 显示文案覆盖，给 `+` 这种会被 accelerator 语法吃掉的键用
  display?: string
}

export const CONTEXT_LABEL: Record<KeyContext, string> = {
  get global() { return tr("Global") },
  get board() { return tr("Board") },
  get pet() { return tr("Agent avatars") },
  get next() { return tr("Next steps") },
  get detail() { return tr("Details") },
  get info() { return tr("Information panel") },
  get launch() { return tr("New session") },
  get search() { return tr("Search panel") },
  get mini() { return tr("Mini panel") },
  get map() { return tr("Mind map") },
  get settings() { return tr("Settings") },
}

export const CONTEXT_ORDER: KeyContext[] = [
  'global',
  'board',
  'pet',
  'next',
  'detail',
  'info',
  'launch',
  'search',
  'mini',
  'map',
  'settings',
]

const TABS = Array.from({ length: 9 }, (_, i) => `CommandOrControl+${i + 1}`)
const SECTIONS = Array.from({ length: 4 }, (_, i) => `CommandOrControl+${i + 1}`)
const PROJECTS = Array.from({ length: 9 }, (_, i) => `CommandOrControl+${i + 1}`)

export const SHORTCUTS: ShortcutDef[] = [
  // ------------------------------------------------------------ 全局
  { id: 'global.panel', context: 'global', keys: ['CommandOrControl+Shift+E'], get label() { return tr("Show / hide mini panel") }, hidden: true },
  { id: 'global.settings', context: 'global', keys: ['CommandOrControl+,'], get label() { return tr("Open settings (press again to return)") } },
  { id: 'global.view-board', context: 'global', keys: ['CommandOrControl+Alt+1'], get label() { return tr("Switch to board") } },
  { id: 'global.view-next', context: 'global', keys: ['CommandOrControl+Alt+2'], get label() { return tr("Switch to next steps") } },
  { id: 'global.view-map', context: 'global', keys: ['CommandOrControl+Alt+3'], get label() { return tr("Switch to mind map") } },
  { id: 'global.project', context: 'global', keys: ['CommandOrControl+P'], get label() { return tr("Switch project") } },
  { id: 'global.project-n', context: 'global', keys: PROJECTS, get label() { return tr("Switch to pinned project N") }, display: '⌘1..9' },
  { id: 'global.search', context: 'global', keys: ['CommandOrControl+K'], get label() { return tr("Toggle search panel") } },
  { id: 'global.clear-filter', context: 'global', keys: ['CommandOrControl+Shift+K'], get label() { return tr("Clear search filter") } },

  // ------------------------------------------------------------ 看板
  { id: 'board.next', context: 'board', keys: ['J', 'ArrowDown'], get label() { return tr("Next card") } },
  { id: 'board.prev', context: 'board', keys: ['K', 'ArrowUp'], get label() { return tr("Previous card") } },
  { id: 'board.left', context: 'board', keys: ['H', 'ArrowLeft'], get label() { return tr("Card to the left") } },
  { id: 'board.right', context: 'board', keys: ['L', 'ArrowRight'], get label() { return tr("Card to the right") } },
  {
    id: 'board.attention',
    context: 'board',
    keys: ['CommandOrControl+Shift+N'],
    get label() { return tr("Next pet needing attention (Enter to return to session)") },
  },
  { id: 'board.open', context: 'board', keys: ['Return'], get label() { return tr("Open selected requirement") } },
  { id: 'board.kids', context: 'board', keys: ['Space'], get label() { return tr("Expand / collapse child requirements") } },
  { id: 'board.copy-slug', context: 'board', keys: ['Y'], get label() { return tr("Copy selected requirement slug") } },
  { id: 'board.pin', context: 'board', keys: ['P'], get label() { return tr("Pin / unpin selected requirement") } },
  {
    id: 'board.kid-n',
    context: 'board',
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    get label() { return tr("Go to child requirement N in the expanded list") },
    display: '1..9',
  },
  { id: 'board.clear', context: 'board', keys: ['Escape'], get label() { return tr("Clear selection") } },

  // ------------------------------------------------------------ agent 头像（卡片里的一格）
  { id: 'pet.focus', context: 'pet', keys: ['Tab'], get label() { return tr("Move focus between card and avatars") } },
  { id: 'pet.prev', context: 'pet', keys: ['H', 'ArrowLeft', 'K', 'ArrowUp'], get label() { return tr("Previous avatar") } },
  { id: 'pet.next', context: 'pet', keys: ['L', 'ArrowRight', 'J', 'ArrowDown'], get label() { return tr("Next avatar") } },
  { id: 'pet.open', context: 'pet', keys: ['Return'], get label() { return tr("Return to this agent's session") } },
  { id: 'pet.back', context: 'pet', keys: ['Escape'], get label() { return tr("Focus the card") } },

  // ------------------------------------------------------------ 下一步
  { id: 'next.next', context: 'next', keys: ['J', 'ArrowDown'], get label() { return tr("Next item") } },
  { id: 'next.prev', context: 'next', keys: ['K', 'ArrowUp'], get label() { return tr("Previous item") } },
  { id: 'next.primary', context: 'next', keys: ['Return'], get label() { return tr("Return to session / open requirement") } },
  { id: 'next.open', context: 'next', keys: ['O'], get label() { return tr("Open requirement") } },
  { id: 'next.clear', context: 'next', keys: ['Escape'], get label() { return tr("Clear selection") } },

  // ------------------------------------------------------------ 详情页
  { id: 'detail.close', context: 'detail', keys: ['Escape'], get label() { return tr("Collapse session form / close panel / return to board") } },
  { id: 'detail.back', context: 'detail', keys: ['CommandOrControl+['], get label() { return tr("Return to board") } },
  { id: 'detail.save', context: 'detail', keys: ['CommandOrControl+S'], get label() { return tr("Save now") } },
  { id: 'detail.tab-n', context: 'detail', keys: TABS, get label() { return tr("Switch to document tab N") }, display: '⌘1..9' },
  { id: 'detail.tab-prev', context: 'detail', keys: ['CommandOrControl+Shift+['], get label() { return tr("Previous tab") } },
  { id: 'detail.tab-next', context: 'detail', keys: ['CommandOrControl+Shift+]'], get label() { return tr("Next tab") } },
  { id: 'detail.info', context: 'detail', keys: ['I'], get label() { return tr("Toggle information panel") } },
  { id: 'detail.open-dir', context: 'detail', keys: ['CommandOrControl+Shift+O'], get label() { return tr("Open current directory") } },
  { id: 'detail.copy-path', context: 'detail', keys: ['CommandOrControl+Alt+C'], get label() { return tr("Copy current directory path") } },
  { id: 'detail.new-session', context: 'detail', keys: ['CommandOrControl+Shift+N'], get label() { return tr("New session") } },

  // ------------------------------------------------------------ 信息浮窗
  { id: 'info.next', context: 'info', keys: ['J', 'ArrowDown'], get label() { return tr("Next option") } },
  { id: 'info.prev', context: 'info', keys: ['K', 'ArrowUp'], get label() { return tr("Previous option") } },

  // ------------------------------------------------------------ 新建会话（浮窗里的表单）
  { id: 'launch.agent-prev', context: 'launch', keys: ['H', 'ArrowLeft'], get label() { return tr("Previous agent") } },
  { id: 'launch.agent-next', context: 'launch', keys: ['L', 'ArrowRight'], get label() { return tr("Next agent") } },
  { id: 'launch.row-prev', context: 'launch', keys: ['K', 'ArrowUp'], get label() { return tr("Previous row (workspace / agent)") } },
  { id: 'launch.row-next', context: 'launch', keys: ['J', 'ArrowDown'], get label() { return tr("Next row (agent / workspace / launch)") } },

  // ------------------------------------------------------------ 搜索面板
  { id: 'search.next', context: 'search', keys: ['ArrowDown'], get label() { return tr("Next item") } },
  { id: 'search.prev', context: 'search', keys: ['ArrowUp'], get label() { return tr("Previous item") } },
  { id: 'search.open', context: 'search', keys: ['Return'], get label() { return tr("Open requirement, keep filter") } },
  { id: 'search.open-clear', context: 'search', keys: ['CommandOrControl+Return'], get label() { return tr("Open requirement and clear filter") } },
  { id: 'search.close', context: 'search', keys: ['Escape'], get label() { return tr("Close panel, keep filter") } },

  // ------------------------------------------------------------ mini 面板
  { id: 'mini.next', context: 'mini', keys: ['ArrowDown'], get label() { return tr("Next item") } },
  { id: 'mini.prev', context: 'mini', keys: ['ArrowUp'], get label() { return tr("Previous item") } },
  { id: 'mini.expand', context: 'mini', keys: ['ArrowRight'], get label() { return tr("Expand") } },
  { id: 'mini.collapse', context: 'mini', keys: ['ArrowLeft'], get label() { return tr("Collapse") } },
  { id: 'mini.activate', context: 'mini', keys: ['Return'], get label() { return tr("Open selected item") } },
  { id: 'mini.open-detail', context: 'mini', keys: ['CommandOrControl+Return'], get label() { return tr("Open requirement details") } },
  { id: 'mini.nth', context: 'mini', keys: TABS, get label() { return tr("Open requirement details for card N") }, display: '⌘1..9' },
  { id: 'mini.close', context: 'mini', keys: ['Escape'], get label() { return tr("Clear filter / collapse / close panel") } },

  // ------------------------------------------------------------ 导图
  { id: 'map.fit', context: 'map', keys: ['0'], get label() { return tr("Fit to window") } },
  { id: 'map.zoom-in', context: 'map', keys: ['+', '='], get label() { return tr("Zoom in") }, display: '+' },
  { id: 'map.zoom-out', context: 'map', keys: ['-'], get label() { return tr("Zoom out") } },
  { id: 'map.pan', context: 'map', keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], get label() { return tr("Pan canvas") } },
  { id: 'map.back', context: 'map', keys: ['Escape'], get label() { return tr("Back to board") } },

  // ------------------------------------------------------------ 设置
  { id: 'settings.back', context: 'settings', keys: ['Escape', 'CommandOrControl+,'], get label() { return tr("Return to board") } },
  { id: 'settings.section', context: 'settings', keys: SECTIONS, get label() { return tr("Switch to section N") }, display: '⌘1..5' },
]

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

// 按 id 判断是否命中
export function shortcut(e: KeyEventLike, id: string, platform = currentPlatform()): boolean {
  const def = BY_ID.get(id)
  return !!def && def.keys.some((k) => matches(e, k, platform))
}

export interface KeyEventLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
  target?: EventTarget | null
}

export function currentPlatform(): string {
  // Electron 桥给 darwin / win32。
  // navigator.platform 是 MacIntel / Win32，符号按前者出。
  const bridge = typeof window === 'undefined' ? undefined : window.easyFlow?.platform
  if (bridge) return bridge
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

function isMac(platform: string): boolean {
  return /mac|darwin|iphone|ipad/i.test(platform)
}

type Mods = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; cmdOrCtrl: boolean }

function parseAccelerator(accel: string): { key: string; mods: Mods } {
  // `+` 本身就是键时不能按分隔符切
  const raw = accel === '+' ? ['+'] : accel.split('+')
  const parts = raw.map((p) => p.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods: Mods = { meta: false, ctrl: false, alt: false, shift: false, cmdOrCtrl: false }
  for (const p of parts) {
    if (p === 'CommandOrControl' || p === 'CmdOrCtrl') mods.cmdOrCtrl = true
    else if (p === 'Command' || p === 'Cmd' || p === 'Super' || p === 'Meta') mods.meta = true
    else if (p === 'Control' || p === 'Ctrl') mods.ctrl = true
    else if (p === 'Alt' || p === 'Option') mods.alt = true
    else if (p === 'Shift') mods.shift = true
  }
  return { key, mods }
}

function sameKey(e: KeyEventLike, token: string): boolean {
  switch (token) {
    case 'Left':
      return e.key === 'ArrowLeft'
    case 'Right':
      return e.key === 'ArrowRight'
    case 'Up':
      return e.key === 'ArrowUp'
    case 'Down':
      return e.key === 'ArrowDown'
    case 'Return':
      return e.key === 'Enter'
    case 'Escape':
      return e.key === 'Escape'
    case 'Space':
      return e.key === ' ' || e.key === 'Spacebar'
    case 'Tab':
      return e.key === 'Tab'
    case 'Backspace':
      return e.key === 'Backspace'
    case 'Delete':
      return e.key === 'Delete'
    case '[':
      // ⌘⇧[ 在多数键盘布局上出的是 {
      return e.key === '[' || e.key === '{'
    case ']':
      return e.key === ']' || e.key === '}'
    case '+':
      return e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd'
    case '-':
      return e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract'
    default:
      break
  }

  if (/^[a-zA-Z]$/.test(token)) {
    // ⌥ 组合会改 e.key（⌥⌘C 可能出 ç），code 才是稳定的物理键
    return e.key.toLowerCase() === token.toLowerCase() || e.code === `Key${token.toUpperCase()}`
  }
  if (/^[0-9]$/.test(token)) {
    return e.key === token || e.code === `Digit${token}`
  }
  return e.key === token
}

// 一个键盘事件是否命中某条 accelerator。修饰键按「完全相等」比，⌘K 不会误中 ⌘⇧K
export function matches(e: KeyEventLike, accel: string, platform = currentPlatform()): boolean {
  const { key, mods } = parseAccelerator(accel)
  if (!key) return false
  if (!sameKey(e, key)) return false

  const mac = isMac(platform)
  const needMeta = mods.meta || (mods.cmdOrCtrl && mac)
  const needCtrl = mods.ctrl || (mods.cmdOrCtrl && !mac)
  if (e.metaKey !== needMeta || e.ctrlKey !== needCtrl) return false
  if (e.altKey !== mods.alt) return false

  // ? 与 + 天生要 Shift（或小键盘），不按「没写 Shift 就必须没按」来卡
  if (key === '?' || key === '+') return true
  return e.shiftKey === mods.shift
}

// 是否落在输入控件里：单键快捷键一律让位
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  return typeof el.closest === 'function' && !!el.closest('.cm-editor, [contenteditable="true"]')
}

// 输入法组合中按的键不算快捷键
export function isComposing(e: Pick<KeyEventLike, 'isComposing' | 'keyCode'>): boolean {
  return !!e.isComposing || e.keyCode === 229
}

// 焦点在按钮 / 链接上时，单键与 Enter 应该留给它自己
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('button, a, input, textarea, select, [contenteditable="true"]')
}

// 焦点停在卡片里的 agent 头像上：这时看板的单键让位，Enter / Esc 归头像自己
export function isPetTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('.slot')
}

// 非组合键场景的统一入口：输入法里、输入控件里都不接
export function shouldIgnore(e: KeyEventLike): boolean {
  return isComposing(e) || isEditableTarget(e.target ?? null)
}

// 某条键位给人看的写法；按钮 title 用，免得与设置页各写一套
export function shortcutLabel(id: string, platform = currentPlatform()): string {
  const def = BY_ID.get(id)
  if (!def) return ''
  return def.display ?? def.keys.map((k) => formatAccelerator(k, platform)).join(' / ')
}

// ⌘1..9 命中的是第几号置顶项目。
// 没命中返回 0。
export function projectSlot(e: KeyEventLike, platform = currentPlatform()): number {
  const keys = BY_ID.get('global.project-n')?.keys ?? []
  return keys.findIndex((k) => matches(e, k, platform)) + 1
}

// 第 n 个置顶项目自己的键位写法，左栏徽标用
export function projectShortcutLabel(n: number, platform = currentPlatform()): string {
  const accel = BY_ID.get('global.project-n')?.keys[n - 1]
  return accel ? formatAccelerator(accel, platform) : ''
}
