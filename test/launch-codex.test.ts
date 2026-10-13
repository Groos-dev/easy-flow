import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { AppServer, ensureRequirementProject } from '../server/codex.ts'
import { BoardDatabase } from '../server/db.ts'
import { findLaunchProvider, type LaunchInput } from '../server/launch.ts'
import {
  codexAppServerStartError,
  codexProvider,
  codexProjectRoots,
  codexLaunchUrl,
} from '../server/launch-codex.ts'

const input: LaunchInput = {
  agent: 'codex',
  requirementId: 'req-demo',
  worktreeId: '',
  worktreePath: '',
  requirementWorktreePaths: ['/Users/groos/repo/demo.feature-x', '/Users/groos/repo/demo.feature-y'],
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

  test('一条需求一个 project：roots 收全部工作区（键由 ensureRequirementProject 拼）', () => {
    assert.deepEqual(codexProjectRoots(input), input.requirementWorktreePaths)
  })

  test('需求级 project 只在创建时指定 roots', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const server = {
      async call(method: string, params: Record<string, unknown>) {
        calls.push({ method, params })
        return method === 'project/create' ? { project: { id: 'requirement-project' } } : undefined
      },
    } as unknown as AppServer
    const roots = ['/repo/one', '/repo/two']

    assert.equal(await ensureRequirementProject(server, input.requirementId, 'requirement', roots), 'requirement-project')
    // 复用已有 project 时不再刷 roots（幂等键命中时 create 本身就忽略新 roots），
    // 免得覆盖掉人在 Codex 里对 project 的调整
    assert.deepEqual(calls, [
      {
        method: 'project/create',
        params: {
          idempotencyKey: 'easy-flow:req-demo',
          name: 'requirement',
          roots: roots.map((path) => ({ path })),
        },
      },
    ])
  })

  test('开发会话用需求级 project（全部工作区 roots）并返回深链', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const server = {
      async call(method: string, params: Record<string, unknown>) {
        calls.push({ method, params })
        return method === 'project/create' ? { project: { id: 'requirement-project' } } : undefined
      },
      close() {},
    } as unknown as AppServer
    const start = AppServer.start
    try {
      AppServer.start = async () => server
      const url = await codexProvider.build(input, 'start work')

      assert.equal(new URL(url).searchParams.get('projectId'), 'requirement-project')
      assert.equal(new URL(url).searchParams.get('prompt'), 'start work')
      const roots = input.requirementWorktreePaths.map((path) => ({ path }))
      assert.deepEqual(calls, [
        {
          method: 'project/create',
          params: { idempotencyKey: 'easy-flow:req-demo', name: 'req-demo', roots },
        },
      ])
    } finally {
      AppServer.start = start
    }
  })

  test('开发 project 响应缺少 id 时报告具体字段路径', async () => {
    const server = {
      async call() {
        return {}
      },
      close() {},
    } as unknown as AppServer
    const start = AppServer.start
    try {
      AppServer.start = async () => server
      await assert.rejects(async () => codexProvider.build(input, 'prompt'), /app-server 返回里没有 project\.id/)
    } finally {
      AppServer.start = start
    }
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
        cwd: input.requirementWorktreePaths[0],
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
        throw new Error('initialize timed out after 60s')
      }
      await assert.rejects(
        async () => codexProvider.build(input, 'prompt'),
        /Codex app-server failed to start: initialize timed out after 60s/,
      )
    } finally {
      AppServer.start = start
    }

    assert.equal(
      codexAppServerStartError(new Error('找不到 codex 命令：装好 Codex，或让它在 PATH 里再重跑')).message,
      'Codex command not found. Install Codex or add it to PATH.',
    )
    assert.equal(
      codexAppServerStartError(new Error('initialize timed out after 60s')).message,
      'Codex app-server failed to start: initialize timed out after 60s',
    )
  })
})
