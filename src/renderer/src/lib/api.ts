import type {
  BoardData,
  ContextPayload,
  Project,
  Requirement,
  SettingsPayload,
  SkillPayload,
  SwitchResult,
  Todo,
  TodosPayload,
} from './types'

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

export const api = {
  list: (): Promise<BoardData> => request('/api/requirements'),

  /** 服务端全文检索：md 与索引都在服务端，前端不做遍历 */
  search: (q: string): Promise<{ requirements: Requirement[] }> =>
    request(`/api/search?q=${encodeURIComponent(q)}`),

  move: (slug: string, status: string): Promise<Requirement> =>
    request('/api/move', { method: 'POST', body: JSON.stringify({ slug, status }) }),

  update: (
    slug: string,
    patch: { status?: string; priority?: string; title?: string },
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

  /** 读需求目录下的文档（默认 requirement.md） */
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

  // ------------------------------------------------------------- 待办

  /** 待办是全局的，不分项目 */
  todos: (): Promise<TodosPayload> => request('/api/todos'),

  updateTodo: (id: string, patch: { status?: string }): Promise<Todo> =>
    request('/api/todos/update', { method: 'POST', body: JSON.stringify({ id, ...patch }) }),

  /** 读一条待办的 md 原文（内容源在文件里） */
  todoDoc: (id: string): Promise<{ id: string; path: string; content: string }> =>
    request(`/api/todos/doc?id=${encodeURIComponent(id)}`),

  saveTodoDoc: (id: string, content: string): Promise<{ id: string; path: string; bytes: number }> =>
    request('/api/todos/doc', { method: 'POST', body: JSON.stringify({ id, content }) }),

  /** 在访达里打开这条待办的 md */
  openTodo: (id: string): Promise<{ ok: boolean; path: string }> =>
    request('/api/todos/open', { method: 'POST', body: JSON.stringify({ id }) }),

  // ------------------------------------------------------------- 项目

  /** 侧边栏树：所有项目 + 各自需求，一次拉全 */
  tree: (): Promise<{ tree: Array<Project & { requirements: Requirement[] }>; active: string }> =>
    request('/api/tree'),

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

  open: (slug: string, project?: string): Promise<{ ok: boolean }> =>
    request('/api/open', { method: 'POST', body: JSON.stringify({ slug, project }) }),

  /** 在 Finder 里打开某个工作区的目录 */
  openWorktree: (id: string): Promise<{ ok: boolean; path: string }> =>
    request('/api/worktree/open', { method: 'POST', body: JSON.stringify({ id }) }),

  settings: (): Promise<SettingsPayload> => request('/api/settings'),

  switchDataDir: (dataDir: string): Promise<SwitchResult> =>
    request('/api/settings', { method: 'POST', body: JSON.stringify({ dataDir }) }),

  resync: (): Promise<{ sync: SwitchResult['sync']; dataDir: string }> =>
    request('/api/settings/resync', { method: 'POST' }),

  skill: (): Promise<SkillPayload> => request('/api/skill'),

  installSkill: (): Promise<SkillPayload & { installed: string[] }> =>
    request('/api/skill/install', { method: 'POST' }),
}
