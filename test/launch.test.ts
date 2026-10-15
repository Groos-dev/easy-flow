/**
 * 启动交接层的契约测试：提示词内容与 provider 注册表。
 * provider 自己的 deeplink 编码在各子需求的测试里覆盖。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  findLaunchProvider,
  launchPrompt,
  launchProviders,
  registerLaunchProvider,
  type LaunchInput,
} from '../server/launch.ts'

const input: LaunchInput = {
  agent: 'claude',
  requirementId: 'req-abc123',
  worktreeId: 'wt-xyz789',
  worktreePath: '/Users/groos/repo/demo.feature-x',
  requirementWorktreePaths: ['/Users/groos/repo/demo.feature-x'],
}

describe('启动交接', () => {
  test('提示词只带需求与工作区身份，并要求先取上下文、再登记自己', () => {
    const prompt = launchPrompt(input)
    assert.match(prompt, /req-abc123/)
    assert.match(prompt, /wt-xyz789/)
    assert.match(prompt, /easy-flow context wt-xyz789/)
    assert.match(prompt, /easy-flow req session add req-abc123 --agent claude/)
    // 不把整份文档快照塞进提示词
    assert.ok(prompt.length < 400)
  })

  test('两个 agent 都按所选工作区取上下文——会话实际只拿到那一个目录', () => {
    const prompt = launchPrompt({ ...input, agent: 'codex' })
    assert.match(prompt, /req-abc123/)
    assert.match(prompt, /wt-xyz789/)
    assert.match(prompt, /easy-flow context wt-xyz789/)
    assert.match(prompt, /easy-flow req session add req-abc123 --agent codex/)
  })

  test('需求还没有工作区时按需求取上下文，并写明先开工作区再动代码', () => {
    const prompt = launchPrompt({ ...input, worktreeId: '', worktreePath: '', requirementWorktreePaths: [] })
    assert.match(prompt, /easy-flow context req-abc123/)
    assert.match(prompt, /easy-flow wt new/)
    assert.match(prompt, /easy-flow req session add req-abc123 --agent claude/)
    assert.doesNotMatch(prompt, /wt-xyz789/)
    // 有工作区时不出现这句：那是正常的开发会话
    assert.doesNotMatch(launchPrompt(input), /easy-flow wt new/)
  })

  test('注册过的 provider 能被查到，没注册的返回 undefined', () => {
    registerLaunchProvider({ id: 'claude', label: 'Claude Code', build: () => 'claude://code/new' })
    assert.equal(findLaunchProvider('claude')?.label, 'Claude Code')
    assert.equal(findLaunchProvider('cursor'), undefined)
    assert.deepEqual(
      launchProviders().map((p) => p.id),
      ['claude'],
    )
  })
})
