import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { AppServer } from '../server/codex.ts'
import { BoardDatabase } from '../server/db.ts'
import { findLaunchProvider, type LaunchInput } from '../server/launch.ts'
import {
  codexAppServerStartError,
  codexProvider,
  codexDevelopmentProjectKey,
  codexDevelopmentProjectRoots,
  codexLaunchUrl,
} from '../server/launch-codex.ts'

const input: LaunchInput = {
  agent: 'codex',
  requirementId: 'req-demo',
  worktreeId: 'wt-selected',
  worktreePath: '/Users/groos/repo/demo.feature-x',
}

describe('Codex 开发会话启动', () => {
  test('模块加载时注册 Codex provider', () => {
    assert.equal(findLaunchProvider('codex'), codexProvider)
  })

  test('深链分别编码项目 id 与预填提示词', () => {
    const projectId = 'project id+&/中文'
    const prompt = '先读上下文 & 再开始 + 保留原文\n第二行'
    const url = new URL(codexLaunchUrl(projectId, prompt))

    assert.equal(url.protocol, 'codex:')
    assert.equal(url.hostname, 'threads')
    assert.equal(url.pathname, '/new')
    assert.equal(url.searchParams.get('projectId'), projectId)
    assert.equal(url.searchParams.get('prompt'), prompt)
  })

  test('开发 project 只包含所选工作区，幂等键与 review project 分开', () => {
    assert.deepEqual(codexDevelopmentProjectRoots(input), [input.worktreePath])
    assert.equal(codexDevelopmentProjectKey(input), 'easy-flow:req-demo:wt-selected')
    assert.notEqual(codexDevelopmentProjectKey(input), 'easy-flow:req-demo')
  })

  test('新开发 thread 默认登记为 dev，不覆盖已有 review thread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-flow-codex-launch-'))
    const db = new BoardDatabase(dir)
    try {
      db.addSession({
        requirementId: input.requirementId,
        agent: 'codex',
        session: 'review-thread',
        role: 'review',
      })
      const dev = db.addSession({
        requirementId: input.requirementId,
        agent: 'codex',
        session: 'new-dev-thread',
        cwd: input.worktreePath,
      })

      assert.equal(dev.role, 'dev')
      assert.equal(db.sessionBy('codex', 'review-thread')?.role, 'review')
      assert.deepEqual(
        db
          .listSessions(input.requirementId)
          .map(({ session, role }) => ({ session, role }))
          .sort((a, b) => a.session.localeCompare(b.session)),
        [
          { session: 'new-dev-thread', role: 'dev' },
          { session: 'review-thread', role: 'review' },
        ],
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('app-server 启动失败时 provider 抛明确英文错误供调用方降级', async () => {
    const start = AppServer.start
    try {
      AppServer.start = async () => {
        throw new Error('找不到 codex 命令：装好 Codex，或让它在 PATH 里再重跑')
      }
      await assert.rejects(async () => codexProvider.build(input, 'prompt'), /Codex command not found/)

      AppServer.start = async () => {
        throw new Error('初始化失败')
      }
      await assert.rejects(async () => codexProvider.build(input, 'prompt'), /Codex app-server failed to start/)
    } finally {
      AppServer.start = start
    }

    assert.equal(
      codexAppServerStartError(new Error('找不到 codex 命令：装好 Codex，或让它在 PATH 里再重跑')).message,
      'Codex command not found. Install Codex or add it to PATH.',
    )
  })
})
