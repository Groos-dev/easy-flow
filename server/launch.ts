/**
 * 从需求详情页启动 agent 会话的交接层。
 *
 * easy-flow 不持有会话本体：这里只把「需求 + 工作区 + agent」组装成一段提示词和一条
 * 新会话 deeplink。目录授权与首条消息的发送由 agent 应用和用户完成——新会话跑起来后
 * 用 easy-flow context 拉实时上下文，再按现有 req session add 把自己登记回来。
 *
 * 各 provider 的 deeplink 构造在各自的 launch-<agent>.ts 里，由 server/index.ts 引入时注册进来。
 */

// 支持新会话启动的 agent
export type LaunchAgent = 'claude' | 'codex' | 'chengxiaobang' | 'cursor'

// 一次启动请求：详情页上选中的 agent 与工作区
export interface LaunchInput {
  agent: LaunchAgent
  // 需求 id（req-…）
  requirementId: string
  // 用户选中的工作区：两个 agent 的 deeplink 都只能带一个目录——Claude 用它当工作目录，Codex 用它当 path 定位项目
  worktreeId: string
  // 工作区目录；deeplink 里的那个目录就是它
  worktreePath: string
  // Codex 用：需求名下全部可用工作区路径——一条需求一个 project，roots 收这些
  requirementWorktreePaths: string[]
}

export interface LaunchProvider {
  id: LaunchAgent
  label: string
  // 没有工作区就不能启动（Cursor 的 deeplink 只能按工作区名路由）
  requiresWorktree?: boolean
  // 打开 deeplink 前要先让应用准备好目标工作区；失败会直接走启动失败
  prepare?: (input: LaunchInput) => Promise<void> | void
  // 生成 deeplink。codex 要先备好 project，所以允许异步
  build: (input: LaunchInput, prompt: string) => Promise<string> | string
}

const providers = new Map<LaunchAgent, LaunchProvider>()

// provider 在自己的文件里注册；调用方只读，不关心谁注册的
export function registerLaunchProvider(provider: LaunchProvider): void {
  providers.set(provider.id, provider)
}

export function launchProviders(): LaunchProvider[] {
  return [...providers.values()]
}

export function findLaunchProvider(id: string): LaunchProvider | undefined {
  return providers.get(id as LaunchAgent)
}

// 新会话把自己登记回需求的那条命令；提示词里那句与失败降级给用户手动执行的是同一条
export function sessionAddCommand(requirementId: string, agent: LaunchAgent): string {
  return `easy-flow req session add ${requirementId} --agent ${agent} --title "<一句话说明在做什么>"`
}

// 预填提示词：只带身份与下一步动作，实时内容由新会话自己用 easy-flow context 拉
export function launchPrompt(input: LaunchInput): string {
  const register = sessionAddCommand(input.requirementId, input.agent)
  // 有工作区就按工作区取上下文：新会话实际只拿到这一个目录
  // 没有工作区时都退到需求：Claude 的 deeplink 不带 folder，Codex 不建 project、也不带 path
  const byWorktree = !!input.worktreeId
  const lines = [
    byWorktree
      ? `在 easy-flow 需求 ${input.requirementId} 的工作区 ${input.worktreeId} 上开始工作。`
      : `在 easy-flow 需求 ${input.requirementId} 上开始工作。`,
    '',
    `先运行 easy-flow context ${byWorktree ? input.worktreeId : input.requirementId} 读项目规范、需求内容与状态，再动手。`,
  ]
  if (!input.requirementWorktreePaths.length) {
    lines.push('这条需求还没有工作区：要改代码先用 easy-flow wt new 开工作区，别直接改仓库主 checkout。')
  }
  // 程小帮的 open 深链只带文本，工作目录由 app 当前项目决定：不写死路径，新会话会在别处动手
  if (input.agent === 'chengxiaobang' && input.worktreePath) {
    lines.push(`程小帮的新会话不跟随链接切目录：先 cd ${input.worktreePath} 再动手。`)
  }
  lines.push(`发送首条消息、当前会话 ID 已产生后${byWorktree ? '，在这个工作区' : ''}运行 ${register}`)
  return lines.join('\n')
}
