import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureAntigravityProject } from './antigravity-project.ts'
import { AgentId } from '../src/shared/domain.ts'
import { registerLaunchProvider, type LaunchProvider } from './launch.ts'

export async function antigravityLaunchUrl(prompt: string, folder: string, projects = join(homedir(), '.gemini', 'config', 'projects')): Promise<string> {
  const query = new URLSearchParams({ prompt })
  if (folder) query.set('project', await ensureAntigravityProject(folder, projects))
  return `antigravity://open?${query}`
}

export const antigravityProvider: LaunchProvider = {
  id: AgentId.Antigravity,
  label: 'Antigravity',
  copyPromptOnFailure: true,
  fallbackApp: 'Antigravity',
  build: (input, prompt) => antigravityLaunchUrl(prompt, input.worktreePath),
}

registerLaunchProvider(antigravityProvider)
