import type { BoardData, Requirement } from './types'

// 渲染层走 HTTP 访问本地服务，开发与打包共用同一套代码：
//   dev（浏览器）  → 相对路径，由 Vite proxy 转发到 127.0.0.1:3210
//   dev/build（Electron）→ 主进程内嵌同一服务，直连回环地址
const BASE: string =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '' : 'http://127.0.0.1:3210')

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const text = await res.text()

  // 非 JSON 响应通常是代理/路由配错（落到 SPA fallback 返回了 index.html）。
  // 必须显式报错，否则 HTML 被当成数据，页面会以难排查的方式崩掉。
  if (!text.trimStart().startsWith('{')) {
    const head = text.trimStart().slice(0, 40).replace(/\s+/g, ' ')
    throw new Error(`接口 ${path} 返回的不是 JSON（拿到 ${text.length} 字节：「${head}…」）`)
  }

  const data = JSON.parse(text) as T & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export interface SettingsPayload {
  dataDir: string
  dbFile: string
  defaultDataDir: string
  terminalFontFamily: string
  terminalFontSize: number
  counts: { requirements: number }
}

export interface AppearancePayload {
  terminalFontFamily: string
  terminalFontSize: number
}

export interface Project {
  slug: string
  name: string
  root: string
  hasConvention: boolean
  convention: string | null
  requirementCount: number
  mtime: number
  updated: string
}

export interface SwitchResult {
  dataDir: string
  dbFile: string
  previous?: string
  unchanged?: boolean
  sync: { added: string[]; updated: string[]; orphaned: string[]; restored: string[] } | null
}

export interface ContextPayload {
  requirement: Requirement
  docs: Array<{ name: string; content: string }>
  agentsMd: string | null
}

export const api = {
  list: (): Promise<BoardData> => request('/api/requirements'),

  /** 服务端全文检索：md 与索引都在服务端，前端不做遍历 */
  search: (q: string): Promise<{ requirements: Requirement[] }> =>
    request(`/api/search?q=${encodeURIComponent(q)}`),

  move: (slug: string, column: string): Promise<Requirement> =>
    request('/api/move', { method: 'POST', body: JSON.stringify({ slug, column }) }),

  update: (
    slug: string,
    patch: { stage?: string; priority?: string; title?: string },
    project?: string,
  ): Promise<Requirement> =>
    request('/api/update', {
      method: 'POST',
      body: JSON.stringify({ slug, ...patch, project }),
    }),

  context: (slug: string, project?: string): Promise<ContextPayload> =>
    request(
      `/api/context?slug=${encodeURIComponent(slug)}` +
        (project ? `&project=${encodeURIComponent(project)}` : ''),
    ),

  /** 读需求目录下的文档（默认 AGENTS.md） */
  doc: (
    slug: string,
    name: string,
    project?: string,
  ): Promise<{ slug: string; name: string; content: string }> =>
    request(
      `/api/doc?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}` +
        (project ? `&project=${encodeURIComponent(project)}` : ''),
    ),

  /** 保存文档 */
  saveDoc: (
    slug: string,
    name: string,
    content: string,
    project?: string,
  ): Promise<{ slug: string; name: string; bytes: number }> =>
    request('/api/doc', {
      method: 'POST',
      body: JSON.stringify({ slug, name, content, project }),
    }),

  saveAppearance: (patch: Partial<AppearancePayload>): Promise<AppearancePayload> =>
    request('/api/settings/appearance', { method: 'POST', body: JSON.stringify(patch) }),

  // ------------------------------------------------------------- 项目

  projects: (): Promise<{ projects: Project[]; active: string }> => request('/api/projects'),

  /** 侧边栏树：所有项目 + 各自需求，一次拉全 */
  tree: (): Promise<{ tree: Array<Project & { requirements: Requirement[] }>; active: string }> =>
    request('/api/tree'),

  createProject: (slug: string, name: string): Promise<Project> =>
    request('/api/projects', { method: 'POST', body: JSON.stringify({ slug, name }) }),

  openProject: (slug: string): Promise<{ ok: boolean; root: string }> =>
    request('/api/projects/open', { method: 'POST', body: JSON.stringify({ slug }) }),

  setActiveProject: (slug: string): Promise<{ active: string }> =>
    request('/api/projects/active', { method: 'POST', body: JSON.stringify({ slug }) }),

  projectConvention: (
    project: string,
  ): Promise<{ project: string; content: string | null; path: string | null }> =>
    request(`/api/projects/convention?project=${encodeURIComponent(project)}`),

  saveProjectConvention: (
    project: string,
    content: string,
  ): Promise<{ project: string; path: string; bytes: number }> =>
    request('/api/projects/convention', {
      method: 'POST',
      body: JSON.stringify({ project, content }),
    }),

  deleteProject: (
    slug: string,
    removeFiles: boolean,
  ): Promise<{ ok: boolean; projects: Project[] }> =>
    request('/api/projects/delete', {
      method: 'POST',
      body: JSON.stringify({ slug, removeFiles }),
    }),

  open: (slug: string, project?: string): Promise<{ ok: boolean }> =>
    request('/api/open', { method: 'POST', body: JSON.stringify({ slug, project }) }),

  settings: (): Promise<SettingsPayload> => request('/api/settings'),

  switchDataDir: (dataDir: string): Promise<SwitchResult> =>
    request('/api/settings', { method: 'POST', body: JSON.stringify({ dataDir }) }),

  resync: (): Promise<{ sync: SwitchResult['sync']; dataDir: string }> =>
    request('/api/settings/resync', { method: 'POST' }),
}
