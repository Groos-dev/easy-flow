import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { claudeLaunchUrl, claudeProvider } from '../server/launch-claude.ts'
import type { LaunchInput } from '../server/launch.ts'

const input: LaunchInput = {
  agent: 'claude',
  requirementId: 'req-abc123',
  worktreeId: 'wt-xyz789',
  worktreePath: '/Users/groos/repo/Claude worktree #1?x=1&y=2',
}

describe('Claude Code 启动链接', () => {
  test('对提示词和含空格、保留字符的绝对路径分别编码', () => {
    const prompt = '在 req-abc123 的 wt-xyz789 工作；先运行 easy-flow context wt-xyz789。a&b=c #你好'
    const folder = '/Users/groos/repo/Claude worktree #1?x=1&y=2'
    const url = claudeLaunchUrl(prompt, folder)

    assert.equal(
      url,
      `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`,
    )
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('q'), prompt)
    assert.equal(parsed.searchParams.get('folder'), folder)
  })

  test('缺失或非绝对工作区路径时报错', () => {
    assert.throws(() => claudeLaunchUrl('prompt', ''), /folder/i)
    assert.throws(() => claudeLaunchUrl('prompt', 'relative/worktree'), /absolute/i)
  })

  test('provider 为选中的单个工作区生成 Claude 新会话链接', () => {
    const prompt = 'req-abc123 wt-xyz789: easy-flow context wt-xyz789'
    const url = claudeProvider.build(input, prompt)

    assert.equal(claudeProvider.id, 'claude')
    assert.equal(claudeProvider.label, 'Claude Code')
    assert.equal(url, claudeLaunchUrl(prompt, input.worktreePath))
    const parsed = new URL(url)
    assert.equal(parsed.protocol, 'claude:')
    assert.equal(parsed.hostname, 'code')
    assert.equal(parsed.pathname, '/new')
    assert.equal(parsed.searchParams.get('q'), prompt)
    assert.equal(parsed.searchParams.get('folder'), input.worktreePath)
  })
})
