import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chengxiaobangLaunchUrl, chengxiaobangProvider } from '../server/launch-chengxiaobang.ts'
import type { LaunchInput } from '../server/launch.ts'

const input: LaunchInput = {
  agent: 'chengxiaobang',
  requirementId: 'req-demo',
  worktreeId: 'wt-demo',
  worktreePath: '/Users/groos/repo/demo.feature-x',
  requirementWorktreePaths: ['/Users/groos/repo/demo.feature-x'],
}

describe('程小帮新会话启动', () => {
  test('用 open 深链预填提示词', () => {
    const prompt = '先读上下文 & 再开始\n第二行'
    const url = new URL(chengxiaobangLaunchUrl(prompt))
    assert.equal(url.protocol, 'chengxiaobang:')
    assert.equal(url.hostname, 'open')
    assert.equal(url.searchParams.get('text'), prompt)
  })

  test('provider 固定使用程小帮与提示词', async () => {
    const prompt = 'easy-flow context wt-demo'
    const url = await chengxiaobangProvider.build(input, prompt)
    assert.equal(chengxiaobangProvider.id, 'chengxiaobang')
    assert.equal(chengxiaobangProvider.label, '程小帮')
    assert.equal(new URL(url).searchParams.get('text'), prompt)
  })
})
