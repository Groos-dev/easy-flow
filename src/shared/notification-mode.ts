import { NotificationPreference } from './domain.ts'
import { t as tr } from "./i18n.ts"
/**
 * 系统通知的显示时机。dock 红点不受这个配置影响——关掉通知，角标仍然是主路径。
 *
 * 存在应用配置里（server/config.ts），主进程与设置页共用这一份取值与文案。
 */
export const NOTIFICATION_MODES = Object.values(NotificationPreference)

export type NotificationMode = NotificationPreference

export const NOTIFICATION_MODE_LABELS: Record<NotificationMode, string> = {
  get never() { return tr("Never") },
  get unfocused() { return tr("Only when unfocused") },
  get always() { return tr("Always") },
}

export function isNotificationMode(value: unknown): value is NotificationMode {
  return typeof value === 'string' && (NOTIFICATION_MODES as readonly string[]).includes(value)
}

// 这个模式下、当前前台状态要不要发系统通知
export function shouldNotify(mode: NotificationMode, foreground: boolean): boolean {
  if (mode === NotificationPreference.Never) return false
  if (mode === NotificationPreference.Always) return true
  return !foreground
}
