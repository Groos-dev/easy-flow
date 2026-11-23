import { AgentId } from './domain.ts'
import { t as tr } from './i18n.ts'
/**
 * 各 agent 的展示事实，服务端与渲染层共用一份。
 * 分开写迟早漂移（通知里认得的 agent，详情页却认不出来）；接新 agent 只改这里。
 */

// agent 显示名。取值与 CLI 的 --agent 一致，认不出来的原样显示
export const AGENT_LABELS: Record<string, string> = {
  [AgentId.Claude]: 'Claude Code',
  [AgentId.Codex]: 'Codex',
  [AgentId.Cursor]: 'Cursor',
  get [AgentId.Chengxiaobang]() { return tr("Chengxiaobang") },
  [AgentId.Antigravity]: 'Antigravity',
}

// Resolve known agent names from IDs at display time; server labels may be cached in another language.
export function agentLabel(id: string, fallback = id): string {
  return Object.hasOwn(AGENT_LABELS, id) ? AGENT_LABELS[id] : fallback
}

// 没有会话级 deeplink 的 agent：用哪个 macOS 应用打开会话所在的工作区（open -a）
const WORKSPACE_APPS: Record<string, string> = {
  [AgentId.Cursor]: 'Cursor',
  // The App can be focused; project/workspace selection remains a manual handoff.
  [AgentId.Antigravity]: 'Antigravity',
}

// 打开工作区用的应用名；不支持的 agent 返回空串
export function workspaceAppOf(agent: string): string {
  return Object.hasOwn(WORKSPACE_APPS, agent) ? WORKSPACE_APPS[agent] : ''
}

// 这条会话能不能退而求其次，打开它所在的工作区
export function canOpenWorkspace(session: { agent: string; cwd: string }): boolean {
  return !!workspaceAppOf(session.agent) && (!!session.cwd || session.agent === AgentId.Antigravity)
}

export function workspaceOpenArgs(agent: string, path: string): string[] {
  const app = workspaceAppOf(agent)
  if (!app) return []
  // Antigravity App 2.34 has no open-file handler. Passing a directory does not
  // select a project and must not be presented as a successful workspace open.
  return agent === AgentId.Antigravity ? ['-a', app] : ['-a', app, path]
}

export function workspaceOpenHint(session: { agent: string; cwd: string; session: string }): string {
  return session.agent === AgentId.Antigravity
    ? session.cwd
      ? tr("Open Antigravity to find the conversation manually; original workspace: {0}.", [session.cwd])
      : tr("Open Antigravity and find this conversation manually.")
    : tr("Open this session's workspace in {0} (does not navigate to the session): {1}", [workspaceAppOf(session.agent), session.session])
}

export function workspaceOpenNotice(result: { manualWorkspaceSelection?: boolean; workspaceExists?: boolean }): string {
  return result.manualWorkspaceSelection && result.workspaceExists === false
    ? tr("Antigravity is open. The original workspace is unavailable; find the conversation manually in the App.") : ''
}
