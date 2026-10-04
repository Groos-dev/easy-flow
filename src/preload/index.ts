import { contextBridge, ipcRenderer } from 'electron'

/** 订阅形如 easy-flow:open-settings 的频道，返回取消订阅函数 */
function subscribe(channel: string, handler: (payload: never) => void): () => void {
  const listener = (_e: unknown, payload: never) => handler(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

contextBridge.exposeInMainWorld('easyFlow', {
  /** 拉起原生目录选择器，返回选中路径（取消则返回 null） */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('easy-flow:pick-directory'),

  /** 订阅「打开设置」（来自菜单的 ⌘,），返回取消订阅函数 */
  onOpenSettings: (handler: () => void): (() => void) =>
    subscribe('easy-flow:open-settings', handler),
})
