import { contextBridge, ipcRenderer } from 'electron'
import type { TerminalTarget } from '../main/terminal.ts'

/** 订阅形如 terminal:data:<id> 的动态频道，返回取消订阅函数 */
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

  /** 终端：在指定挂载点（需求或项目）的目录下开一个登录 shell */
  terminal: {
    create: (target: TerminalTarget, opts?: { cols?: number; rows?: number }): Promise<string> =>
      ipcRenderer.invoke('terminal:create', target, opts ?? {}),

    input: (id: string, data: string): void => ipcRenderer.send('terminal:input', id, data),

    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),

    destroy: (id: string): void => ipcRenderer.send('terminal:destroy', id),

    onData: (id: string, handler: (data: string) => void): (() => void) =>
      subscribe(`terminal:data:${id}`, handler),

    onExit: (id: string, handler: (code: number) => void): (() => void) =>
      subscribe(`terminal:exit:${id}`, handler),
  },
})
