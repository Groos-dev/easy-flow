import type {
  BoardData,
  CodeLinkStatus,
  ContextPayload,
  HookPlan,
  InstallOutcome,
  LaunchAgent,
  LaunchProviderInfo,
  LaunchResult,
  NextUpItem,
  Project,
  Requirement,
  Session,
  SettingsPayload,
  SkillPayload,
  SwitchResult,
  Todo,
  TodosPayload,
} from './types'

// 渲染层走 HTTP 访问本地服务，开发与打包共用同一套代码：
//   dev（浏览器）  → 相对路径，由 Vite proxy 转发到 127.0.0.1:29170
//   dev/build（Electron）→ 主进程内嵌同一服务，直连回环地址
// 可选链是给 node 测试留的：那些用例用 react-dom/server 直接渲染组件，没有 Vite 的 import.meta.env
const BASE: string =
  import.meta.env?.VITE_API_BASE ?? (import.meta.env?.DEV ? '' : 'http://127.0.0.1:29170')

async function request<T>(
  path: string,
  options?: RequestInit,
  { errorIsResult = false }: { errorIsResult?: boolean } = {},
): Promise<T> {
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
  if (!res.ok || (!errorIsResult && data.error)) throw new Error(data.error ?? `HTTP ${res.status}`)
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

  /** MR/PR 状态与流水线汇总：取不到的不在结果里 */
  codeLinkStatuses: (urls: string[]): Promise<{ statuses: Record<string, CodeLinkStatus> }> =>
    request('/api/code-link-statuses', { method: 'POST', body: JSON.stringify({ urls }) }),

  /** 全部 agent 会话（需求归属在每条的 requirementId 上）。mini 面板一次拉全 */
  sessions: (): Promise<{ sessions: Session[] }> => request('/api/sessions'),

  /**
   * 点一下 pet：告诉服务端这条会话此刻「静止」。服务端把它写成一条状态事件，
   * 与 hook 事件共用同一张表——下一个事件一到就覆盖，不需要谁来清。
   * fire-and-forget：记不下也不该拦住人打开会话
   */
  markSessionClicked: (agent: string, session: string): Promise<{ ok: boolean }> =>
    request('/api/sessions/clicked', { method: 'POST', body: JSON.stringify({ agent, session }) }),

  /**
   * 「下一步该动哪个」的排名。名次与理由由服务端算——它要会话实时状态，
   * 渲染层拿不到同一份，所以不在这儿重算。
   */
  nextUp: (): Promise<{ items: NextUpItem[] }> => request('/api/next-up'),

  /** 按需求 id 取单条。待办详情页的「需求」那行只有 id，靠它换成可跳转的需求 */
  requirementById: (id: string): Promise<Requirement> =>
    request(`/api/requirement?id=${encodeURIComponent(id)}`),

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

  // ------------------------------------------------------------- 项目

  /** 项目列表：顶栏的项目 chip 行用它。只要项目本身，不拉各自的需求 */
  projects: (): Promise<{ projects: Project[]; active: string }> => request('/api/projects'),

  /** 所有项目 + 各自需求，一次拉全（mini 面板用） */
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

  launchProviders: (): Promise<{ providers: LaunchProviderInfo[] }> =>
    request('/api/launch/providers'),

  /** 启动失败仍是带 prompt 的结果；仅 HTTP 非 2xx 进入 request 错误通道。 */
  launch: (input: {
    slug: string
    project: string
    worktreeId: string
    agent: LaunchAgent
  }): Promise<LaunchResult> =>
    request('/api/launch', { method: 'POST', body: JSON.stringify(input) }, { errorIsResult: true }),

  settings: (): Promise<SettingsPayload> => request('/api/settings'),

  switchDataDir: (dataDir: string): Promise<SwitchResult> =>
    request('/api/settings', { method: 'POST', body: JSON.stringify({ dataDir }) }),

  resync: (): Promise<{ sync: SwitchResult['sync']; dataDir: string }> =>
    request('/api/settings/resync', { method: 'POST' }),

  skill: (): Promise<SkillPayload> => request('/api/skill'),

  installSkill: (): Promise<SkillPayload & InstallOutcome> =>
    request('/api/skill/install', { method: 'POST' }),

  // ------------------------------------------------------------- Agent hook

  /** 两个 agent 的 hook 安装状态。读的是真文件 */
  hooks: (): Promise<HookPlan> => request('/api/hooks'),

  installHooks: (): Promise<HookPlan & InstallOutcome> =>
    request('/api/hooks/install', { method: 'POST' }),

  uninstallHooks: (): Promise<HookPlan & InstallOutcome> =>
    request('/api/hooks/uninstall', { method: 'POST' }),
}
