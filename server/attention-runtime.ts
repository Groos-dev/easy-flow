/**
 * 通知层的编排：把 tracker 的结论落到 badge、通知与持久化上。
 *
 * 这里不碰 Electron——窗口焦点、Dock 调用、Notification 都由调用方注入，
 * 这样「前台只更新 badge、不 notify」「重启后 badge 数一致」这些最需要回归的判断
 * 可以直接用 node --test 跑，不用起一个 Electron 进程。
 */
import {
  AttentionTracker,
  groupAttentionNotifications,
  UNKNOWN_TTL_MS,
  type AttentionDiff,
  type AttentionEvent,
  type AttentionNotification,
  type AttentionSession,
} from './attention.ts'
import type { AttentionStore } from './attention-store.ts'
import { createLogger } from './log.ts'

const log = createLogger('attention')

export interface AttentionRuntimeOptions {
  store: AttentionStore
  /** badge 只在数量变化时调用 */
  setBadge: (count: number) => void
  notify: (notification: AttentionNotification) => void
  /** 这次事件要不要发系统通知（通知时机 + 主窗口/mini 面板焦点由调用方算好） */
  shouldNotify: () => boolean
  /** 需求下已经没有待处理事件了：把该需求的通知从通知中心关掉 */
  dismiss?: (requirementId: string) => void
  /** failed 要在事件态里活过这个窗口才通知，挡掉一次工具报错 */
  notifyGraceMs?: number
  /** 后台来了新事件时的轻提示（Windows 任务栏闪烁）；没有就不做 */
  signal?: () => void
}

/** 与 pull 周期一致：一次工具报错通常在下一个事件到达前就翻过去了 */
const DEFAULT_NOTIFY_GRACE_MS = 2_000

interface PendingNotification {
  event: AttentionEvent
  dueAt: number
}

export class AttentionRuntime {
  private readonly tracker: AttentionTracker
  private outstanding: AttentionEvent[]
  private lastBadge = -1
  private readonly pending = new Map<string, PendingNotification>()

  constructor(private readonly options: AttentionRuntimeOptions) {
    this.tracker = new AttentionTracker(options.store.read())
    this.outstanding = this.tracker.snapshot()
    this.syncBadge()
  }

  observe(sessions: readonly AttentionSession[], now = Date.now()): AttentionDiff {
    const diff = this.tracker.observe(sessions, now)
    this.outstanding = diff.outstanding
    this.syncStore()
    this.syncBadge()

    if (diff.expired.length) {
      const hours = Math.round(UNKNOWN_TTL_MS / 3_600_000)
      for (const event of diff.expired) {
        log.info(`expired ${event.id} after ${hours}h unknown; badge cleared`)
      }
    }

    this.dismissCleared(diff)

    // 已经有通知在等确认：状态变了或事件消账就取消
    const outstandingById = new Map(diff.outstanding.map((event) => [event.id, event]))
    for (const [id, pending] of this.pending) {
      const current = outstandingById.get(id)
      if (!current || current.pushKey !== pending.event.pushKey) this.pending.delete(id)
    }

    const ready: AttentionEvent[] = []
    const grace = this.options.notifyGraceMs ?? DEFAULT_NOTIFY_GRACE_MS
    for (const event of diff.added) {
      // 用户自己按 Esc / 打断，不需要再通知一次；按 hook 事件名判断
      if (event.state === 'blocked' && event.hookEvent === 'Interrupt') continue
      if (event.state === 'failed') {
        // 先挂起，等下一个周期确认它还在；
        // 一次工具报错通常活不过这个窗口
        this.pending.set(event.id, { event, dueAt: now + grace })
        continue
      }
      ready.push(event)
    }

    for (const [id, pending] of this.pending) {
      if (pending.dueAt > now) continue
      const current = outstandingById.get(id)
      this.pending.delete(id)
      if (current && current.pushKey === pending.event.pushKey) ready.push(current)
    }

    if (!ready.length) return diff
    // 通知时机不满足时不打扰：badge 已经更新，卡片角标也在
    if (!this.options.shouldNotify()) return diff

    this.options.signal?.()
    for (const notification of groupAttentionNotifications(ready)) {
      this.options.notify(notification)
    }
    return diff
  }

  count(): number {
    return this.outstanding.length
  }

  private syncBadge(): void {
    const count = this.outstanding.length
    if (count === this.lastBadge) return
    this.lastBadge = count
    this.options.setBadge(count)
  }

  private dismissCleared(diff: AttentionDiff): void {
    if (!this.options.dismiss || (!diff.cleared.length && !diff.expired.length)) return
    const still = new Set(diff.outstanding.map((event) => event.requirement.id))
    for (const event of [...diff.cleared, ...diff.expired]) {
      if (!still.has(event.requirement.id)) this.options.dismiss(event.requirement.id)
    }
  }

  private syncStore(): void {
    // 落盘边界在 store：由它比较内容，决定要不要真的写文件
    this.options.store.write(this.outstanding)
  }
}
