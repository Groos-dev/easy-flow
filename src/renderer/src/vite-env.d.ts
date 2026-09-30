/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** 终端能力：只有 Electron 里有；浏览器开发时不存在 */
interface EasyFlowTerminal {
  create: (
    target: { project: string; slug?: string },
    opts?: { cols?: number; rows?: number },
  ) => Promise<string>
  input: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  destroy: (id: string) => void
  onData: (id: string, handler: (data: string) => void) => () => void
  onExit: (id: string, handler: (code: number) => void) => () => void
  count: () => Promise<number>
}

/** preload 通过 contextBridge 暴露的能力；浏览器开发时不存在 */
interface EasyFlowBridge {
  platform: string
  pickDirectory?: () => Promise<string | null>
  /** 订阅菜单里的「偏好设置 ⌘,」，返回取消订阅函数 */
  onOpenSettings?: (handler: () => void) => () => void
  terminal?: EasyFlowTerminal
}

interface Window {
  easyFlow?: EasyFlowBridge
}
