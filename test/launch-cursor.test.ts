import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  cursorLaunchUrl,
  cursorProvider,
  cursorWorkspaceKey,
  cursorWorkspaceName,
} from '../server/launch-cursor.ts'
import type { LaunchInput } from '../server/launch.ts'

const input: LaunchInput = {
  agent: 'cursor',
  requirementId: 'req-abc123',
  worktreeId: 'wt-xyz789',
  worktreePath: '/Users/groos/repo/demo.feature-x',
  requirementWorktreePaths: ['/Users/groos/repo/demo.feature-x'],
}

describe('Cursor 启动', () => {
  test('prompt 与 workspace 都进 deeplink 并做 URL 编码', () => {
    const url = cursorLaunchUrl('看下 a b', 'demo.feature-x')
    assert.equal(
      url,
      'cursor://anysphere.cursor-deeplink/prompt?text=%E7%9C%8B%E4%B8%8B%20a%20b&workspace=demo.feature-x',
    )
  })

  test('workspace 取目录名，key 按 Cursor 的规则把非字母数字换成 -', () => {
    assert.equal(cursorWorkspaceName('/Users/groos/repo/demo.feature-x'), 'demo.feature-x')

    const dir = join(tmpdir(), `ef-cursor-key-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try {
      const real = realpathSync(dir)
      const expected = real
        .replace(/[^a-zA-Z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
      assert.equal(cursorWorkspaceKey(dir), expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('provider 要求工作区，build 用所选目录名', async () => {
    assert.equal(cursorProvider.id, 'cursor')
    assert.equal(cursorProvider.requiresWorktree, true)
    const url = await cursorProvider.build(input, 'prompt')
    assert.match(url, /workspace=demo\.feature-x/)
    assert.match(url, /text=prompt/)
  })

  test('同名工作区在打开窗口前就拒绝', () => {
    const dup = {
      ...input,
      worktreePath: '/a/same',
      requirementWorktreePaths: ['/a/same', '/b/same'],
    }
    assert.throws(() => cursorProvider.build(dup, 'prompt'), /cannot tell apart/)
    assert.throws(() => cursorProvider.prepare?.(dup), /cannot tell apart/)
  })
})
