/**
 * 主进程的通知层：把纯逻辑（server/attention.ts、attention-runtime.ts）的结论
 * 落到 dock 红点与系统通知上。
 *
 * 检测放主进程而不是渲染层：看板的轮询在 `document.hidden` 时直接跳过，
 * 窗口一收起来就再也发现不了事件，而「跑完了叫我」恰恰发生在那时。
 */
import type { BrowserWindow} from 'electron';
import { app, Notification, nativeImage } from 'electron'
import { type AttentionNotification, type AttentionSession } from '../../server/attention.ts'
import { AttentionRuntime } from '../../server/attention-runtime.ts'
import { createAttentionStore } from '../../server/attention-store.ts'
import { createLogger } from '../../server/log.ts'
import { shouldNotify as shouldNotifyFor, type NotificationMode } from '../../src/shared/notification-mode.ts'

const log = createLogger('attention')

// 保留最近几条通知对象。丢了引用，macOS 上的通知可能跟着被回收
const RETAIN_LIMIT = 50
// 等系统回执的上限：超时没收到 show / failed，就如实说「没等到回执」
const TEST_TIMEOUT_MS = 1_500
// hook 在 agent 的关键路径上：refresh 合到一帧后再读快照，别让 HTTP 响应等通知
const REFRESH_DEBOUNCE_MS = 50

export interface AttentionTarget {
  project: string
  slug: string
}

export interface AttentionInfo {
  supported: boolean
  // 最近一次投递失败的原因；没有则为空串
  lastFailure: string
}

export interface AttentionTestResult extends AttentionInfo {
  // 系统回了 show：通知确实投递出去了
  delivered: boolean
  // 超时前既没 show 也没 failed：多半是权限 / 勿扰，读不到确切原因
  timedOut: boolean
}

export interface AttentionServiceOptions {
  // 持久化事件的文件
  file: string
  platform?: NodeJS.Platform
  getWindow: () => BrowserWindow | null
  // mini 面板可见时也算「人正在看」
  isPanelVisible: () => boolean
  // 系统通知的显示时机；设置页改完即时生效
  mode: NotificationMode
  // 非 macOS 的通知图标；macOS 由应用包图标决定
  icon?: string
  openRequirement: (target: AttentionTarget) => void
  openExternal: (url: string) => void
  // 投递失败时推给渲染层，设置页不用等下一次进页面才知道
  onFailure?: (message: string) => void
}

export interface AttentionService {
  // 接上快照读取并先对齐一次；之后由服务端的 pull / hook 回调 refresh
  start: (read: () => AttentionSession[]) => () => void
  // 会话状态变了：重新读一次快照。服务端在 pull、hook、点 pet 后调用
  refresh: () => void
  // 当前 outstanding 数（测试与设置页用）
  count: () => number
  // 当前通知时机
  mode: () => NotificationMode
  // 改通知时机：只影响之后的事件，不补发历史
  setMode: (mode: NotificationMode) => void
  // 窗口重建后补挂 badge：Windows 的 overlay 挂在窗口上，不能只靠数量变化触发
  refreshBadge: () => void
  info: () => AttentionInfo
  // 发一条测试通知，等系统回执后给结论（show / failed / 超时）
  test: () => Promise<AttentionTestResult>
  // 窗口获得焦点：停掉 Windows 的任务栏闪烁
  handleWindowFocus: () => void
}

export function createAttentionService({
  file,
  platform = process.platform,
  getWindow,
  isPanelVisible,
  mode: initialMode,
  icon,
  openRequirement,
  openExternal,
  onFailure,
}: AttentionServiceOptions): AttentionService {
  let lastFailure = ''
  let mode = initialMode
  let readSessions: (() => AttentionSession[]) | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  const retained = new Map<string, Notification>()
  // macOS 只保留左侧系统默认的应用图标；
  // 传 icon 会在右侧多出一个内容图标
  const notificationIcon = platform === 'darwin' ? undefined : icon

  const runtime = new AttentionRuntime({
    store: createAttentionStore(file),
    setBadge: applyBadge,
    notify: present,
    shouldNotify: () => shouldNotifyFor(mode, isForeground()),
    dismiss: (requirementId) => {
      const notification = retained.get(requirementId)
      if (!notification) return
      notification.close()
      retained.delete(requirementId)
    },
    signal: () => {
      // 「始终」也会在前台发通知，但任务栏闪烁只在后台有意义
      if (platform === 'win32' && !isForeground()) usableWindow()?.flashFrame(true)
    },
  })

  function usableWindow(): BrowserWindow | null {
    const win = getWindow()
    return win && !win.isDestroyed() ? win : null
  }

  function isForeground(): boolean {
    const win = usableWindow()
    const focused = Boolean(win && win.isVisible() && win.isFocused())
    return focused || isPanelVisible()
  }

  function applyBadge(count: number): void {
    const win = usableWindow()
    if (platform === 'win32') {
      win?.setOverlayIcon(count ? redDotIcon() : null, count ? `${count} 个会话需要处理` : '')
      return
    }

    try {
      app.setBadgeCount(count)
    } catch (err) {
      log.warn(`setBadgeCount failed: ${(err as Error).message}`)
    }
  }

  function fail(message: string, context: string): void {
    lastFailure = message
    log.warn(`${context}: ${message}`)
    onFailure?.(message)
  }

  // 同一需求的通知替换旧的：Electron 35 的 Notification 没有 id，自己记一份 LRU
  function retain(key: string, notification: Notification): void {
    const previous = retained.get(key)
    if (previous && previous !== notification) previous.close()
    // 先删再插，Map 的插入顺序才是真正的「最近使用」
    retained.delete(key)
    retained.set(key, notification)
    while (retained.size > RETAIN_LIMIT) {
      const oldestKey = retained.keys().next().value
      if (oldestKey === undefined) break
      const oldest = retained.get(oldestKey)
      retained.delete(oldestKey)
      oldest?.close()
    }
  }

  function present(notification: AttentionNotification): void {
    if (!Notification.isSupported()) {
      fail('当前系统不支持通知', 'notification skipped')
      return
    }

    const single = notification.events.length === 1 ? notification.events[0] : null
    // 这条是新的一次投递；失败事件异步到达时再写回
    lastFailure = ''
    try {
      const native = new Notification({
        title: notification.title,
        subtitle: notification.subtitle,
        body: notification.body,
        silent: notification.silent,
        ...(notificationIcon ? { icon: notificationIcon } : {}),
        ...(single?.link ? { actions: [{ type: 'button' as const, text: '打开会话' }] } : {}),
      })
      native.on('click', () => openRequirement(notification.requirement))
      native.on('action', () => {
        if (single?.link) openExternal(single.link)
      })
      native.on('failed', (_event, error) => {
        fail(error, `notification failed requirement=${notification.requirement.id}`)
      })
      retain(notification.requirement.id, native)
      native.show()
      log.debug(`notification shown requirement=${notification.requirement.id} events=${notification.events.length}`)
    } catch (err) {
      fail((err as Error).message, `notification skipped requirement=${notification.requirement.id}`)
    }
  }

  function test(): Promise<AttentionTestResult> {
    const supported = Notification.isSupported()
    if (!supported) {
      lastFailure = '当前系统不支持通知'
      return Promise.resolve({ supported, lastFailure, delivered: false, timedOut: false })
    }

    lastFailure = ''
    return new Promise((resolve) => {
      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const finish = (delivered: boolean, timedOut: boolean): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        resolve({ supported: true, lastFailure, delivered, timedOut })
      }

      try {
        const native = new Notification({
          title: '测试通知',
          ...(notificationIcon ? { icon: notificationIcon } : {}),
        })
        native.on('show', () => finish(true, false))
        native.on('failed', (_event, error) => {
          fail(error, 'test notification failed')
          finish(false, false)
        })
        timeout = setTimeout(() => finish(false, true), TEST_TIMEOUT_MS)
        retain('__test__', native)
        native.show()
      } catch (err) {
        fail((err as Error).message, 'test notification skipped')
        finish(false, false)
      }
    })
  }

  function tick(): void {
    if (!readSessions) return
    try {
      runtime.observe(readSessions())
    } catch (err) {
      // 快照读失败不能把服务端 pull / hook 的调用链一起带崩
      log.warn(`refresh failed: ${(err as Error).message}`)
    }
  }

  return {
    start(read) {
      if (refreshTimer) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
      readSessions = read
      tick()
      return () => {
        if (refreshTimer) {
          clearTimeout(refreshTimer)
          refreshTimer = null
        }
        readSessions = null
      }
    },
    refresh() {
      // 服务端可能在 start 之前就回调（比如首次 pull），这时还没有读口
      if (!readSessions || refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        tick()
      }, REFRESH_DEBOUNCE_MS)
    },
    count() {
      return runtime.count()
    },
    mode() {
      return mode
    },
    setMode(next) {
      mode = next
    },
    refreshBadge() {
      applyBadge(runtime.count())
    },
    info() {
      return { supported: Notification.isSupported(), lastFailure }
    },
    test,
    handleWindowFocus() {
      if (platform === 'win32') usableWindow()?.flashFrame(false)
    },
  }
}

let redDot: Electron.NativeImage | null = null

// Windows 没有 dock badge，用任务栏 overlay 红点。一次画好复用
function redDotIcon(): Electron.NativeImage {
  redDot ??= nativeImage.createFromDataURL(`data:image/png;base64,${RED_DOT_PNG}`)
  return redDot
}

// 32×32 的红色圆点，带一像素抗锯齿
const RED_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA0klEQVR4nM2Xyw3EIBBDUwEVuQlaoBZaoIXUQi9TA9q9gDSJiDYsH3PwJQrygzEwHAIcTLUOsAIEAaIAIkDKkvwt5H+GAhgBfDb5vJTkMaYXwDUa10DcvwChw/iu0ApwDjQvOt8CjJz5z5Wo1XyWeZF7AjCdgWsJpqkB+AXmRb4GsGL2ehUuAHaheZHVADOT/6SgASIBIGqAlfW/5KAAJAJA2gqAXgJ6COnbkH4Q0Y/iLS4j+nVMb0i2aMm2aEq3aMt1JmgPE707aE+zuyiP06n6AtmVTDFPfidaAAAAAElFTkSuQmCC'
