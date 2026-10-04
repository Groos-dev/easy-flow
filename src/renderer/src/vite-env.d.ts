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
}

interface Window {
  easyFlow?: EasyFlowBridge
}
