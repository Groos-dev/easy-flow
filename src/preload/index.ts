import { contextBridge, ipcRenderer } from 'electron'

const CSP_NONCE_FLAG = '--easy-flow-csp-nonce='

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

  /** mini 面板点「详情」：主窗口前置并跳到该需求 */
  openRequirement: (payload: { project: string; slug: string }): Promise<void> =>
    ipcRenderer.invoke('easy-flow:open-requirement', payload),

  /** mini 面板订阅「已呼出」：聚焦过滤框、顺手重拉数据 */
  onPanelShown: (handler: () => void): (() => void) =>
    subscribe('easy-flow:panel-shown', handler),

  /** 主窗口订阅「打开需求详情」（来自 mini 面板） */
  onOpenRequirement: (
    handler: (payload: { project: string; slug: string }) => void,
  ): (() => void) => {
    const listener = (_e: unknown, payload: { project: string; slug: string }) => handler(payload)
    ipcRenderer.on('easy-flow:open-requirement', listener)
    return () => ipcRenderer.removeListener('easy-flow:open-requirement', listener)
  },

  /** mini 面板：藏起自己（Esc 到顶 / 点完跳转之后） */
  hidePanel: (): void => {
    ipcRenderer.send('easy-flow:panel-hide')
  },

  /** 取走待打开的需求（主窗口刚重建时事件会早于订阅，靠这一份兜底） */
  takePendingOpen: (): Promise<{ project: string; slug: string } | null> =>
    ipcRenderer.invoke('easy-flow:take-pending-open'),

  /** 平台标识（darwin / win32 / linux）。快捷键符号按平台显示 */
  platform: process.platform,

  /** prod 的 CSP 只放行带它的内联脚本 */
  cspNonce: process.argv.find((a) => a.startsWith(CSP_NONCE_FLAG))?.slice(CSP_NONCE_FLAG.length) ?? '',

  /** 读当前生效的呼出快捷键与默认值 */
  getShortcut: (): Promise<{ shortcut: string; fallback: string }> =>
    ipcRenderer.invoke('easy-flow:get-shortcut'),

  /** 改绑呼出快捷键。注册不上时 ok 为 false，error 里是原因 */
  setShortcut: (
    accel: string,
  ): Promise<{ ok: boolean; shortcut?: string; error?: string }> =>
    ipcRenderer.invoke('easy-flow:set-shortcut', accel),
})
