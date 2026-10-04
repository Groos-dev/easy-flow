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

export interface AppConfig {
  dataDir: string
  /** 当前看板的项目（用户切换后记住） */
  activeProject: string
}

/** 配置文件路径。由 main 进程通过 EASY_FLOW_CONFIG 指定；独立运行 server 时回退到约定路径。 */
export function configPath(): string {
  if (process.env.EASY_FLOW_CONFIG) return process.env.EASY_FLOW_CONFIG
  const base =
    process.env.EASY_FLOW_USER_DATA ??
    join(homedir(), 'Library', 'Application Support', 'easy-flow')
  return join(base, 'config.json')
}

/** macOS 上的默认数据目录。*/
export function defaultDataDir(): string {
  const base =
    process.env.EASY_FLOW_USER_DATA ??
    join(homedir(), 'Library', 'Application Support', 'easy-flow')
  return join(base, 'data')
}

/** 开发便利：沿用旧的 ~/requirements，避免每次都要手动指路。 */
export function devFallbackDir(): string {
  const legacy = join(homedir(), 'requirements')
  return existsSync(legacy) ? legacy : defaultDataDir()
}

export function readConfig(): AppConfig {
  const path = configPath()
  const defaults: AppConfig = {
    dataDir: devFallbackDir(),
    activeProject: '',
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>
    return {
      dataDir: typeof raw?.dataDir === 'string' && raw.dataDir ? raw.dataDir : defaults.dataDir,
      activeProject:
        typeof raw?.activeProject === 'string' ? raw.activeProject : defaults.activeProject,
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
