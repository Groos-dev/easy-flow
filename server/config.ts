/**
 * 应用配置：记录"当前数据目录"。
 *
 * 配置(dataDir) 与状态(sqlite) 分离：
 *   配置 → 固定位置（Electron userData / EASY_FLOW_CONFIG）
 *   状态 → 数据目录内的 easy-flow.db，跟着需求目录走，换机器搬一个目录即可
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isNotificationMode, type NotificationMode } from '../src/shared/notification-mode.ts'

export interface AppConfig {
  dataDir: string
  // 当前看板的项目（用户切换后记住）
  activeProject: string
  // 呼出 mini 面板的全局快捷键（Electron accelerator）；空串表示用默认值
  panelShortcut: string
  // 详情页默认用谁开目录：OpenTarget.id；空串 = 访达
  openWith: string
  // 系统通知的显示时机；dock 红点不受影响
  notificationMode: NotificationMode
}

// 配置文件路径。由 main 进程通过 EASY_FLOW_CONFIG 指定；独立运行 server 时回退到约定路径。
export function configPath(): string {
  if (process.env.EASY_FLOW_CONFIG) return process.env.EASY_FLOW_CONFIG
  const base =
    process.env.EASY_FLOW_USER_DATA ??
    join(homedir(), 'Library', 'Application Support', 'easy-flow')
  return join(base, 'config.json')
}

// macOS 上的默认数据目录。
export function defaultDataDir(): string {
  const base =
    process.env.EASY_FLOW_USER_DATA ??
    join(homedir(), 'Library', 'Application Support', 'easy-flow')
  return join(base, 'data')
}

// 开发便利：沿用旧的 ~/requirements，避免每次都要手动指路。
export function devFallbackDir(): string {
  const legacy = join(homedir(), 'requirements')
  return existsSync(legacy) ? legacy : defaultDataDir()
}

export function readConfig(): AppConfig {
  const path = configPath()
  const defaults: AppConfig = {
    dataDir: devFallbackDir(),
    activeProject: '',
    panelShortcut: '',
    openWith: '',
    notificationMode: 'unfocused',
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>
    return {
      dataDir: typeof raw?.dataDir === 'string' && raw.dataDir ? raw.dataDir : defaults.dataDir,
      activeProject:
        typeof raw?.activeProject === 'string' ? raw.activeProject : defaults.activeProject,
      panelShortcut:
        typeof raw?.panelShortcut === 'string' ? raw.panelShortcut : defaults.panelShortcut,
      openWith: typeof raw?.openWith === 'string' ? raw.openWith : defaults.openWith,
      notificationMode: isNotificationMode(raw?.notificationMode)
        ? raw.notificationMode
        : defaults.notificationMode,
    }
  } catch {
    /* 首次运行或文件损坏，走默认值 */
    return defaults
  }
}

export function writeConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...readConfig(), ...patch }
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
  return next
}
