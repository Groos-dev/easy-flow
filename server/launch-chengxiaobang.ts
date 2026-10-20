import { registerLaunchProvider, type LaunchProvider } from './launch.ts'

/**
 * 程小帮的 `open` 深链会新开一条会话并把 text 预填进输入框。
 * 文本在客户端侧上限 500 字符；launchPrompt 远低于这个上限。
 *
 * 与 claude 的 folder / codex 的 path 不同，`open` 只收文本：新会话的工作目录是 app
 * 当前选中的项目。所以提示词里必须写清绝对路径，让 agent 先 cd 过去——否则它会在
 * 别处动手，改的不是这条需求的工作区。
 */
export function chengxiaobangLaunchUrl(prompt: string): string {
  return `chengxiaobang://open?text=${encodeURIComponent(prompt)}`
}

export const chengxiaobangProvider: LaunchProvider = {
  id: 'chengxiaobang',
  label: '程小帮',
  build: (_input, prompt) => chengxiaobangLaunchUrl(prompt),
}

registerLaunchProvider(chengxiaobangProvider)
