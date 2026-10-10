/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** preload 通过 contextBridge 暴露的能力；浏览器开发时不存在 */
interface EasyFlowBridge {
  pickDirectory?: () => Promise<string | null>
  /** 订阅菜单里的「偏好设置 ⌘,」，返回取消订阅函数 */
  onOpenSettings?: (handler: () => void) => () => void
  /** mini 面板点「详情」：主窗口前置并跳到该需求 */
  openRequirement?: (payload: { project: string; slug: string }) => Promise<void>
  /** mini 面板订阅「已呼出」，返回取消订阅函数 */
  onPanelShown?: (handler: () => void) => () => void
  /** 主窗口订阅「打开需求详情」（来自 mini 面板），返回取消订阅函数 */
  onOpenRequirement?: (handler: (payload: { project: string; slug: string }) => void) => () => void
  /** mini 面板：藏起自己 */
  hidePanel?: () => void
  /** 取走待打开的需求（主窗口刚重建时用） */
  takePendingOpen?: () => Promise<{ project: string; slug: string } | null>
  /** 平台标识（darwin / win32 / linux） */
  platform?: string
  /** 读当前生效的呼出快捷键与默认值 */
  getShortcut?: () => Promise<{ shortcut: string; fallback: string }>
  /** 改绑呼出快捷键 */
  setShortcut?: (accel: string) => Promise<{ ok: boolean; shortcut?: string; error?: string }>
}

interface Window {
  easyFlow?: EasyFlowBridge
}
