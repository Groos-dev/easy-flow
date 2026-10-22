import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  codeLinkStatuses,
  parseCodeLink,
  pipelineOfGitlab,
  stateOfGithub,
  stateOfGitlab,
  statusOfGitlab,
} from '../server/code-host.ts'

describe('代码链接 · 认出是哪条 MR/PR', () => {
  test('GitLab MR：命名空间原样留住，查询串与尾斜杠不影响', () => {
    assert.deepEqual(
      parseCodeLink('http://git.dev.sh.ctripcorp.com/flight-onex/exchange-bookseat-aggregation/-/merge_requests/678'),
      {
        kind: 'gitlab',
        host: 'git.dev.sh.ctripcorp.com',
        project: 'flight-onex/exchange-bookseat-aggregation',
        iid: '678',
      },
    )
    assert.equal(
      parseCodeLink('https://gitlab.example.com/a/b/-/merge_requests/9?tab=notes')?.project,
      'a/b',
    )
  })

  test('GitHub PR：owner/repo 与序号分开', () => {
    assert.deepEqual(parseCodeLink('https://github.com/owner/repo/pull/12'), {
      kind: 'github',
      host: 'github.com',
      project: 'owner/repo',
      iid: '12',
    })
  })

  test('不是 MR/PR 的链接、以及解析不出来的串都不猜', () => {
    assert.equal(parseCodeLink('https://example.com/docs/design.md'), null)
    assert.equal(parseCodeLink('https://github.com/owner/repo/issues/12'), null)
    assert.equal(parseCodeLink('not a url'), null)
    assert.equal(parseCodeLink('https://--host.example/a/b/-/merge_requests/1'), null)
    // owner/repo 会拼进 gh 的 API 路径，转义过的分隔符不认
    assert.equal(parseCodeLink('https://github.com/a%2Fb/repo/pull/1'), null)
  })
})

describe('代码链接 · 状态归一', () => {
  test('GitLab 的 opened 说成人嘴里的 open', () => {
    assert.equal(stateOfGitlab({ state: 'opened' }), 'open')
    assert.equal(stateOfGitlab({ state: 'merged' }), 'merged')
    assert.equal(stateOfGitlab({ state: 'closed' }), 'closed')
  })

  test('GitHub 的 closed 要分合入与关掉', () => {
    assert.equal(stateOfGithub({ state: 'open' }), 'open')
    assert.equal(stateOfGithub({ state: 'closed', merged: true }), 'merged')
    assert.equal(stateOfGithub({ state: 'closed', merged_at: '2026-10-19T16:31:04Z' }), 'merged')
    assert.equal(stateOfGithub({ state: 'closed', merged: false }), 'closed')
  })

  test('认不出的答复不冒充事实', () => {
    assert.equal(stateOfGitlab(null), null)
    assert.equal(stateOfGithub({ state: 'unknown' }), null)
  })

  test('locked 只是锁了讨论，MR 还开着', () => {
    assert.equal(stateOfGitlab({ state: 'locked' }), 'open')
  })

  test('一条 MR 的完整状态：状态与流水线一起归位', () => {
    assert.deepEqual(
      statusOfGitlab({ state: 'opened', head_pipeline: { status: 'failed' } }),
      { state: 'open', pipeline: 'failed' },
    )
    assert.deepEqual(statusOfGitlab({ state: 'merged', head_pipeline: { status: 'success' } }), {
      state: 'merged',
      pipeline: 'success',
    })
    assert.equal(statusOfGitlab({ head_pipeline: { status: 'success' } }), null)
  })

  test('流水线只归并成四种汇总', () => {
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'success' } }), 'success')
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'failed' } }), 'failed')
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'running' } }), 'running')
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'pending' } }), 'running')
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'manual' } }), 'running')
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'canceled' } }), 'skipped')
    assert.equal(pipelineOfGitlab({ head_pipeline: null }), null)
    assert.equal(pipelineOfGitlab({ head_pipeline: { status: 'weird' } }), null)
  })
})

describe('代码链接 · 批量取状态', () => {
  test('取到的按 URL 归位，取不到的那条不出现；同一 URL 只问一次', async () => {
    const asked: string[] = []
    const ok = 'https://gitlab.example.com/a/b/-/merge_requests/1'
    const gone = 'https://gitlab.example.com/a/b/-/merge_requests/2'
    const states = await codeLinkStatuses([ok, gone, ok], async (url) => {
      asked.push(url)
      return url === ok ? { state: 'merged', pipeline: 'success' } : null
    })
    assert.deepEqual(states, { [ok]: { state: 'merged', pipeline: 'success' } })
    assert.deepEqual(asked.sort(), [gone, ok].sort())
  })
})
