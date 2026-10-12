/**
 * 从需求详情页启动 agent 会话的交接层。
 *
 * easy-flow 不持有会话本体：这里只把「需求 + 工作区 + agent」组装成一段提示词和一条
 * 新会话 deeplink。目录授权与首条消息的发送由 agent 应用和用户完成——新会话跑起来后
 * 用 easy-flow context 拉实时上下文，再按现有 req session add 把自己登记回来。
 *
 * 各 provider 的 deeplink 构造在各自的 launch-<agent>.ts 里，由 server/index.ts 引入时注册进来。
 */

/** 首期支持的 agent。cursor 没有验证过的新会话启动方式，不在其中 */
export type LaunchAgent = 'claude' | 'codex'

/** 一次启动请求：详情页上选中的 agent 与工作区 */
export interface LaunchInput {
  agent: LaunchAgent
  /** 需求 id（req-…） */
  requirementId: string
  /** 选中的工作区 id（wt-…） */
  worktreeId: string
  /** 工作区目录；deeplink 的工作目录就是它 */
  worktreePath: string
}

/** 启动结果：要打开的链接 + 给用户复制的提示词 */
export interface LaunchTarget {
  agent: LaunchAgent
  /** 新会话 deeplink */
  url: string
  /** 预填给新会话的提示词；也是「复制提示词」降级路径的内容 */
  prompt: string
}

export interface LaunchProvider {
  id: LaunchAgent
  label: string
  /** 生成 deeplink。codex 要先备好 project，所以允许异步 */
  build: (input: LaunchInput, prompt: string) => Promise<string> | string
}

const providers = new Map<LaunchAgent, LaunchProvider>()

/** provider 在自己的文件里注册；调用方只读，不关心谁注册的 */
export function registerLaunchProvider(provider: LaunchProvider): void {
  providers.set(provider.id, provider)
}

export function launchProviders(): LaunchProvider[] {
  return [...providers.values()]
}

export function findLaunchProvider(id: string): LaunchProvider | undefined {
  return providers.get(id as LaunchAgent)
}

/** 预填提示词：只带身份与下一步动作，实时内容由新会话自己用 easy-flow context 拉 */
export function launchPrompt(input: LaunchInput): string {
  return [
    `在 easy-flow 需求 ${input.requirementId} 的工作区 ${input.worktreeId} 上开始工作。`,
    '',
    `先运行 easy-flow context ${input.worktreeId} 读项目规范、需求内容与状态，再动手。`,
    `开工后把当前会话登记到这条需求：easy-flow req session add ${input.requirementId} --agent ${input.agent} --title "<一句话说明在做什么>"`,
  ].join('\n')
}
