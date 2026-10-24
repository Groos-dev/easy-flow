// 新建会话表单的键盘闭环：可导航行、agent 在启动按钮前、禁用按钮不可达
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import LaunchSession from '../src/renderer/src/components/LaunchSession.tsx'
import LaunchSessionForm from '../src/renderer/src/components/LaunchSessionForm.tsx'
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
    feishuTaskLinks: [],
    codeLinks: [],
    extLinks: [],
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
  test('agent 选择排在启动按钮前面，且都带导航行标记', () => {
    const html = renderForm('codex', [wt('a')])
    const firstRow = html.indexOf('data-info-row=""')
    const launchAt = html.indexOf('class="launch-go"')

    assert.ok(firstRow >= 0, '表单里至少要有一个可导航行')
    assert.ok(launchAt > firstRow, 'agent 选择要先于启动按钮被 j/k 摸到')
    assert.match(html, /class="agent-chip on" data-info-row="" aria-pressed="true"/)
    assert.match(html, /class="agent-chip on"[^>]*aria-label="Codex"[^>]*title="Codex"/, '名称只留在 tooltip / 读屏标签里')
    assert.match(html, /class="launch-go" type="submit" data-info-row=""/)
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
