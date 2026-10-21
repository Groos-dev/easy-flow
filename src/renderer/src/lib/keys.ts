/** 键位定义与匹配；设置页、按钮提示与键盘处理共用 */

import { formatAccelerator } from './shortcut'

export type KeyContext =
  | 'global'
  | 'board'
  | 'pet'
  | 'next'
  | 'detail'
  | 'info'
  | 'search'
  | 'mini'
  | 'map'
  | 'settings'

export interface ShortcutDef {
  id: string
  context: KeyContext
  /** Electron accelerator 写法；一个动作有多个等价键就都列出来 */
  keys: string[]
  label: string
  /** 设置页不列（由录制框单独展示的全局呼出键） */
  hidden?: boolean
  /** 显示文案覆盖，给 `+` 这种会被 accelerator 语法吃掉的键用 */
  display?: string
}

export const CONTEXT_LABEL: Record<KeyContext, string> = {
  global: '全局',
  board: '看板',
  pet: 'agent 头像',
  next: '下一步',
  detail: '详情页',
  info: '信息浮窗',
  search: '搜索面板',
  mini: 'mini 面板',
  map: '导图',
  settings: '设置',
}

export const CONTEXT_ORDER: KeyContext[] = [
  'global',
  'board',
  'pet',
  'next',
  'detail',
  'info',
  'search',
  'mini',
  'map',
  'settings',
]

const TABS = Array.from({ length: 9 }, (_, i) => `CommandOrControl+${i + 1}`)
const SECTIONS = Array.from({ length: 4 }, (_, i) => `CommandOrControl+${i + 1}`)

export const SHORTCUTS: ShortcutDef[] = [
  // ------------------------------------------------------------ 全局
  { id: 'global.panel', context: 'global', keys: ['CommandOrControl+Shift+E'], label: '呼出 / 收起 mini 面板', hidden: true },
  { id: 'global.settings', context: 'global', keys: ['CommandOrControl+,'], label: '打开设置（再按返回）' },
  { id: 'global.view-board', context: 'global', keys: ['CommandOrControl+1'], label: '切到看板' },
  { id: 'global.view-next', context: 'global', keys: ['CommandOrControl+2'], label: '切到下一步' },
  { id: 'global.view-map', context: 'global', keys: ['CommandOrControl+3'], label: '切到导图' },
  { id: 'global.project', context: 'global', keys: ['CommandOrControl+P'], label: '切换项目' },
  { id: 'global.search', context: 'global', keys: ['CommandOrControl+K'], label: '开合搜索面板' },
  { id: 'global.clear-filter', context: 'global', keys: ['CommandOrControl+Shift+K'], label: '清掉搜索筛选' },

  // ------------------------------------------------------------ 看板
  { id: 'board.next', context: 'board', keys: ['J', 'ArrowDown'], label: '下一张卡' },
  { id: 'board.prev', context: 'board', keys: ['K', 'ArrowUp'], label: '上一张卡' },
  { id: 'board.left', context: 'board', keys: ['H', 'ArrowLeft'], label: '左一列' },
  { id: 'board.right', context: 'board', keys: ['L', 'ArrowRight'], label: '右一列' },
  { id: 'board.open', context: 'board', keys: ['Return'], label: '打开选中需求' },
  { id: 'board.kids', context: 'board', keys: ['Space'], label: '展开 / 收起子需求' },
  { id: 'board.copy-slug', context: 'board', keys: ['Y'], label: '复制选中需求的 slug' },
  {
    id: 'board.kid-n',
    context: 'board',
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    label: '跳到展开清单里的第 N 条子需求',
    display: '1..9',
  },
  { id: 'board.clear', context: 'board', keys: ['Escape'], label: '取消选中' },

  // ------------------------------------------------------------ agent 头像（卡片里的一格）
  { id: 'pet.focus', context: 'pet', keys: ['Tab'], label: '在卡片与头像之间循环焦点（Shift+Tab 反向）' },
  { id: 'pet.open', context: 'pet', keys: ['Return'], label: '回到这个 agent 的会话' },
  { id: 'pet.back', context: 'pet', keys: ['Escape'], label: '焦点回卡片' },

  // ------------------------------------------------------------ 下一步
  { id: 'next.next', context: 'next', keys: ['J', 'ArrowDown'], label: '下一条' },
  { id: 'next.prev', context: 'next', keys: ['K', 'ArrowUp'], label: '上一条' },
  { id: 'next.primary', context: 'next', keys: ['Return'], label: '回到会话 / 打开需求' },
  { id: 'next.open', context: 'next', keys: ['O'], label: '打开需求' },
  { id: 'next.clear', context: 'next', keys: ['Escape'], label: '取消选中' },

  // ------------------------------------------------------------ 详情页
  { id: 'detail.close', context: 'detail', keys: ['Escape'], label: '收新建会话表单 / 关浮窗 / 返回看板' },
  { id: 'detail.back', context: 'detail', keys: ['CommandOrControl+['], label: '返回看板' },
  { id: 'detail.save', context: 'detail', keys: ['CommandOrControl+S'], label: '立即保存' },
  { id: 'detail.tab-n', context: 'detail', keys: TABS, label: '切到第 N 个文档标签', display: '⌘1..9' },
  { id: 'detail.tab-prev', context: 'detail', keys: ['CommandOrControl+Shift+['], label: '上一个标签' },
  { id: 'detail.tab-next', context: 'detail', keys: ['CommandOrControl+Shift+]'], label: '下一个标签' },
  { id: 'detail.info', context: 'detail', keys: ['I'], label: '开关信息浮窗' },
  { id: 'detail.open-dir', context: 'detail', keys: ['CommandOrControl+Shift+O'], label: '打开当前目录' },
  { id: 'detail.copy-path', context: 'detail', keys: ['CommandOrControl+Alt+C'], label: '复制当前目录路径' },
  { id: 'detail.new-session', context: 'detail', keys: ['CommandOrControl+Shift+N'], label: '新建会话' },

  // ------------------------------------------------------------ 信息浮窗
  { id: 'info.next', context: 'info', keys: ['J', 'ArrowDown'], label: '下一项' },
  { id: 'info.prev', context: 'info', keys: ['K', 'ArrowUp'], label: '上一项' },

  // ------------------------------------------------------------ 搜索面板
  { id: 'search.next', context: 'search', keys: ['ArrowDown'], label: '下一条' },
  { id: 'search.prev', context: 'search', keys: ['ArrowUp'], label: '上一条' },
  { id: 'search.open', context: 'search', keys: ['Return'], label: '打开需求，筛选保留' },
  { id: 'search.open-clear', context: 'search', keys: ['CommandOrControl+Return'], label: '打开需求并清筛选' },
  { id: 'search.close', context: 'search', keys: ['Escape'], label: '关面板，筛选保留' },

  // ------------------------------------------------------------ mini 面板
  { id: 'mini.next', context: 'mini', keys: ['ArrowDown'], label: '下一条' },
  { id: 'mini.prev', context: 'mini', keys: ['ArrowUp'], label: '上一条' },
  { id: 'mini.expand', context: 'mini', keys: ['ArrowRight'], label: '展开' },
  { id: 'mini.collapse', context: 'mini', keys: ['ArrowLeft'], label: '收起' },
  { id: 'mini.activate', context: 'mini', keys: ['Return'], label: '打开选中项' },
  { id: 'mini.open-detail', context: 'mini', keys: ['CommandOrControl+Return'], label: '打开需求详情' },
  { id: 'mini.nth', context: 'mini', keys: TABS, label: '打开第 N 张卡的需求详情', display: '⌘1..9' },
  { id: 'mini.close', context: 'mini', keys: ['Escape'], label: '清筛选 / 收起 / 关闭面板' },

  // ------------------------------------------------------------ 导图
  { id: 'map.fit', context: 'map', keys: ['0'], label: '适应窗口' },
  { id: 'map.zoom-in', context: 'map', keys: ['+', '='], label: '放大', display: '+' },
  { id: 'map.zoom-out', context: 'map', keys: ['-'], label: '缩小' },
  { id: 'map.pan', context: 'map', keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], label: '平移画布' },
  { id: 'map.back', context: 'map', keys: ['Escape'], label: '回看板' },

  // ------------------------------------------------------------ 设置
  { id: 'settings.back', context: 'settings', keys: ['Escape', 'CommandOrControl+,'], label: '返回看板' },
  { id: 'settings.section', context: 'settings', keys: SECTIONS, label: '切到第 N 个分区', display: '⌘1..4' },
]

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

/** 按 id 判断是否命中 */
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
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

function isMac(platform: string): boolean {
  // navigator.platform 给 MacIntel；window.easyFlow.platform 给 darwin
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

/** 一个键盘事件是否命中某条 accelerator。修饰键按「完全相等」比，⌘K 不会误中 ⌘⇧K */
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

/** 是否落在输入控件里：单键快捷键一律让位 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  return typeof el.closest === 'function' && !!el.closest('.cm-editor, [contenteditable="true"]')
}

/** 输入法组合中按的键不算快捷键 */
export function isComposing(e: Pick<KeyEventLike, 'isComposing' | 'keyCode'>): boolean {
  return !!e.isComposing || e.keyCode === 229
}

/** 焦点在按钮 / 链接上时，单键与 Enter 应该留给它自己 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('button, a, input, textarea, select, [contenteditable="true"]')
}

/** 焦点停在卡片里的 agent 头像上：这时看板的单键让位，Enter / Esc 归头像自己 */
export function isPetTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('.slot')
}

/** 非组合键场景的统一入口：输入法里、输入控件里都不接 */
export function shouldIgnore(e: KeyEventLike): boolean {
  return isComposing(e) || isEditableTarget(e.target ?? null)
}

/** 某条键位给人看的写法；按钮 title 用，免得与设置页各写一套 */
export function shortcutLabel(id: string, platform = currentPlatform()): string {
  const def = BY_ID.get(id)
  if (!def) return ''
  return def.display ?? def.keys.map((k) => formatAccelerator(k, platform)).join(' / ')
}
