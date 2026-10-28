// 新建会话表单的键盘闭环：可导航行、agent 在启动按钮前、禁用按钮不可达
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import LaunchSession from '../src/renderer/src/components/LaunchSession.tsx'
import LaunchSessionForm from '../src/renderer/src/components/LaunchSessionForm.tsx'
import { launchRows, stepLaunchRow } from '../src/renderer/src/lib/launch.ts'
import type {
  LaunchAgent,
  LaunchProviderInfo,
  Requirement,
  Worktree,
} from '../src/renderer/src/lib/types.ts'

const providers: LaunchProviderInfo[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]

function mkReq(): Requirement {
  return {
    slug: 'a',
    project: 'p',
    id: 'req-1',
    parentId: '',
    title: '标题',
    status: '执行中',
    priority: '',
    summary: '',
    repos: [],
    links: '',
    linkItems: [],
    docs: [],
    path: '/Users/groos/requirements/p/a',
    mtime: 0,
    updated: '',
  }
}

function wt(id: string): Worktree {
  return {
    id,
    requirementId: 'req-1',
    short: 'router',
    repo: 'flight-onex-exchange-router',
    branch: `feature-${id}`,
    path: `/Users/groos/repo/java/router.${id}`,
    main: '/Users/groos/repo/java/router',
    created: '',
    updated: '',
    missing: false,
  }
}

function renderForm(agent: LaunchAgent, worktrees: Worktree[], worktreeId = worktrees[0]?.id ?? ''): string {
  return renderToStaticMarkup(
    createElement(LaunchSessionForm, {
      requirementId: 'req-1',
      worktrees,
      providers,
      worktreeId,
      agent,
      loading: false,
      providerError: '',
      requestError: '',
      busy: false,
      result: null,
      onWorktreeChange: () => {},
      onAgentChange: () => {},
      onLaunch: () => {},
    }),
  )
}

describe('新建会话 · 键盘可达', () => {
  test('agent 整排占一个导航行，排在启动按钮前面', () => {
    const html = renderForm('codex', [wt('a')])
    const firstRow = html.indexOf('data-info-row=""')
    const launchAt = html.indexOf('class="launch-go"')

    assert.ok(firstRow >= 0, '表单里至少要有一个可导航行')
    assert.ok(launchAt > firstRow, 'agent 选择要先于启动按钮被 j/k 摸到')
    assert.match(html, /class="agent-chips" role="radiogroup" aria-label="用哪个 Agent 开始" data-info-row="" tabindex="0"/)
    assert.match(html, /class="agent-chip on" role="radio" aria-checked="true"/)
    assert.match(html, /class="agent-chip on"[^>]*aria-label="Codex"[^>]*title="Codex"/, '名称只留在 tooltip / 读屏标签里')
    assert.equal((html.match(/data-info-row=""/g) ?? []).length, 2, 'agent 整排只算一行，另一行是启动按钮')
    assert.match(html, /class="launch-go" type="submit" data-info-row=""/)
  })

  test('agent 再多也只是一块：四个 agent 仍然只占一个导航行', () => {
    const html = renderToStaticMarkup(
      createElement(LaunchSessionForm, {
        requirementId: 'req-1',
        worktrees: [wt('a')],
        providers: [
          { id: 'claude', label: 'Claude Code' },
          { id: 'codex', label: 'Codex' },
          { id: 'chengxiaobang', label: '程小帮' },
          { id: 'cursor', label: 'Cursor' },
        ],
        worktreeId: 'a',
        agent: 'codex',
        loading: false,
        providerError: '',
        requestError: '',
        busy: false,
        result: null,
        onWorktreeChange: () => {},
        onAgentChange: () => {},
        onLaunch: () => {},
      }),
    )
    assert.equal((html.match(/role="radio"/g) ?? []).length, 4)
    assert.equal((html.match(/data-info-row=""/g) ?? []).length, 2)
  })

  test('有多个工作区时，工作区选项也在导航行里', () => {
    const html = renderForm('claude', [wt('a'), wt('b')])
    assert.match(html, /class="wt-option on" data-info-row=""/)
    assert.match(html, /role="radiogroup"/)
  })

  test('多个工作区还没选时，禁用的启动按钮不占导航位', () => {
    const html = renderForm('claude', [wt('a'), wt('b')], '')
    assert.match(html, /class="launch-go"[^>]*disabled=""/)
    assert.doesNotMatch(html, /class="launch-go"[^>]*data-info-row/)
  })

  test('收起态是一行可导航入口', () => {
    const closed = renderToStaticMarkup(
      createElement(LaunchSession, { req: mkReq(), worktrees: [] }),
    )
    assert.match(closed, /class="add-sess" data-info-row=""/)
  })
})

describe('新建会话 · 上下走法', () => {
  const two = [wt('a'), wt('b')]

  test('agent 整排一块，工作区逐档，启动按钮殿后', () => {
    assert.deepEqual(launchRows(two, true).map((r) => r.kind), ['agent', 'worktree', 'worktree', 'launch'])
    assert.deepEqual(launchRows([wt('a')], true).map((r) => r.kind), ['agent', 'launch'], '唯一工作区只是说明文字')
    assert.deepEqual(launchRows([], false).map((r) => r.kind), ['agent'], '禁用的启动按钮不占位')
  })

  test('从 agent 往下落在当前选中的工作区，没选就落第一行', () => {
    const rows = launchRows(two, true)
    assert.equal(stepLaunchRow(rows, 0, 1, 'b'), 2)
    assert.equal(stepLaunchRow(rows, 0, 1, ''), 1)
    assert.equal(stepLaunchRow(rows, 1, -1, 'b'), 0)
  })

  test('两端停住，工作区之间逐行移动', () => {
    const rows = launchRows(two, true)
    assert.equal(stepLaunchRow(rows, 1, 1, 'b'), 2)
    assert.equal(stepLaunchRow(rows, 2, -1, 'b'), 1)
    assert.equal(stepLaunchRow(rows, 3, 1, 'b'), 3)
    assert.equal(stepLaunchRow(launchRows([], true), 0, -1, ''), 0)
  })
})
