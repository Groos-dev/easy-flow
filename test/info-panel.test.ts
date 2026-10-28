/**
 * 详情页浮窗的渲染回归。
 *
 * 这里只管「真渲染出来的 markup 对不对」：一条会话只出现 agent 与标题、没 deeplink 的不给假链接、
 * 工作区失联要露馅、目录压成末行。用 react-dom/server 直接渲染组件，不需要 DOM 环境。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import InfoPanel, { CodeLinkStatusCell } from '../src/renderer/src/components/InfoPanel.tsx'
import type {
  CodeLinkStatus,
  ContextPayload,
  Requirement,
  Session,
  Todo,
  Worktree,
} from '../src/renderer/src/lib/types.ts'

function mkReq(patch: Partial<Requirement> = {}): Requirement {
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
    ...patch,
  }
}

// 会话的 id 与 deeplink 故意取成不同的串：测试要能分辨"亮的是 id"还是"亮的是链接"
function sess(patch: Partial<Session> = {}): Session {
  return {
    requirementId: 'req-1',
    agent: 'codex',
    session: 'raw-session-id',
    title: '把开关下沉到下游',
    cwd: '/Users/groos/repo/x.feature-a',
    link: 'codex://threads/abc',
    created: '',
    updated: '',
    status: { state: 'working', needsAction: '', observedAt: 0, detail: '' },
    action: null,
    ...patch,
  }
}

function wt(patch: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    requirementId: 'req-1',
    short: 'router',
    repo: 'flight-onex-exchange-router',
    branch: 'feature-a',
    path: '/Users/groos/repo/java/router.feature-a',
    main: '/Users/groos/repo/java/router',
    created: '',
    updated: '',
    missing: false,
    ...patch,
  }
}

function mkTodo(patch: Partial<Todo> = {}): Todo {
  return {
    id: 'T-1',
    title: '扫一遍日志',
    status: 'todo',
    source: '',
    channel: '',
    origin: '',
    chat: '',
    session: '',
    ref: '',
    happened: '',
    link: '',
    summary: '',
    path: '/Users/groos/requirements/_todos/T-1.md',
    mtime: 0,
    created: '',
    updated: '',
    requirementId: 'req-1',
    missing: false,
    ...patch,
  }
}

function render(patch: Partial<ContextPayload> = {}): string {
  const ctx: ContextPayload = {
    requirement: mkReq(),
    docs: [],
    requirementMd: null,
    worktrees: [],
    sessions: [],
    todos: [],
    candidateTodos: [],
    ...patch,
  }
  return renderToStaticMarkup(
    createElement(InfoPanel, {
      req: ctx.requirement,
      ctx,
      onOpenTodo: () => {},
    }),
  )
}

describe('详情页浮窗 · 会话块', () => {
  test('一条会话只留 agent 与标题，整行就是跳转', () => {
    const html = render({ sessions: [sess()] })
    assert.match(html, /Codex/)
    assert.match(html, /把开关下沉到下游/)
    assert.match(html, /href="codex:\/\/threads\/abc"/)
  })

  test('会话 id 与 cwd 不再露面：它们是句柄，不是给人看的', () => {
    const html = render({ sessions: [sess()] })
    assert.doesNotMatch(html, /raw-session-id/)
    assert.doesNotMatch(html, /x\.feature-a/)
    // 状态点与状态文案在看板卡片上表达过了，浮窗里不重复
    assert.doesNotMatch(html, /thread-dot/)
    assert.doesNotMatch(html, /正在干活/)
  })

  test('「需要人介入」的原话不进浮窗：状态类提示留在看板卡片上', () => {
    const html = render({
      sessions: [
        sess({
          status: { state: 'blocked', needsAction: '要不要按他说的改？', observedAt: 1, detail: 'hook 判定' },
        }),
      ],
    })
    assert.doesNotMatch(html, /要不要按他说的改？/)
    assert.doesNotMatch(html, /需要人介入/)
  })

  test('没登记标题就拿登记目录的末段兜底，不留一行空的', () => {
    const html = render({ sessions: [sess({ title: '' })] })
    assert.match(html, /x\.feature-a/)
  })

  test('没有 deeplink 的会话整行置灰，不给假链接', () => {
    const html = render({ sessions: [sess({ agent: 'claude', link: '' })] })
    assert.match(html, /sess-off/)
    assert.doesNotMatch(html, /href=/)
  })

  test('Cursor 会话没有 deeplink，但可以点开它所在的工作区', () => {
    const html = render({ sessions: [sess({ agent: 'cursor', link: '' })] })
    assert.doesNotMatch(html, /sess-off/)
    assert.match(html, /role="button"/)
    assert.match(html, /在 Cursor 里打开这条会话所在的工作区/)
  })

  test('新会话入口跟在会话列表后面', () => {
    const html = render({ sessions: [sess()] })
    assert.match(html, /＋ 新建会话/)
  })

  test('ctx 未到时不能把空列表误报成"没有会话"', () => {
    const html = renderToStaticMarkup(
      createElement(InfoPanel, { req: mkReq(), ctx: null, onOpenTodo: () => {} }),
    )
    assert.doesNotMatch(html, /会话/)
  })
})

describe('详情页浮窗 · 工作区与链接', () => {
  test('工作区一条一行：repo · branch 并排，完整路径挂在 title 上', () => {
    const html = render({ worktrees: [wt()] })
    assert.match(html, /flight-onex-exchange-router/)
    assert.match(html, /feature-a/)
    assert.match(html, /title="在目录里打开：\/Users\/groos\/repo\/java\/router\.feature-a（右键或 ⌥ 选打开方式）"/)
  })

  test('打开方式只写在 title 里，行上不多一个字', () => {
    const html = render({ worktrees: [wt()] })
    const row = /<div class="path-row".*?<\/div>/.exec(html)?.[0] ?? ''
    assert.match(row, /打开方式/) // title 里有
    assert.doesNotMatch(row.replace(/title="[^"]*"/g, ''), /打开方式/) // 行上看不见
  })

  test('失联的工作区留下标记且不可点', () => {
    const html = render({ worktrees: [wt({ missing: true })] })
    const row = /<div class="path-row off".*?<\/div>/.exec(html)?.[0] ?? ''
    assert.match(row, /目录已失联/)
    assert.doesNotMatch(row, /role=|tabindex/)
    assert.match(row, /title="目录已失联：\/Users\/groos\/repo\/java\/router\.feature-a"/)
  })

  test('链接没标题时按 URL 出短名，完整地址退到 title', () => {
    const html = render({
      requirement: mkReq({
        linkItems: [{ title: '', url: 'https://project.feishu.cn/onex/story/detail/123' }],
      }),
    })
    assert.match(html, />onex\/story\/123<\/a>/)
    assert.match(html, /title="https:\/\/project\.feishu\.cn\/onex\/story\/detail\/123"/)
  })

  test('requirement.md 的原文段不再搬进浮窗', () => {
    const html = render({ requirement: mkReq({ links: '- [索引](https://example.com/doc-index)' }) })
    assert.doesNotMatch(html, /doc-index/)
  })

  test('没有链接时整块不出现', () => {
    const html = render()
    assert.doesNotMatch(html, /class="link-line"/)
    assert.doesNotMatch(html, />链接</)
  })

  test('需求目录压成末行，仍然是可点的一整行', () => {
    const html = render()
    assert.match(html, /foot-path/)
    assert.match(html, /\/Users\/groos\/requirements\/p\/a/)
  })
})

describe('详情页浮窗 · 代码链接状态', () => {
  const cell = (status: CodeLinkStatus) =>
    renderToStaticMarkup(createElement(CodeLinkStatusCell, { status }))

  test('还开着的 MR 带流水线图标，hover 说人话', () => {
    const html = cell({ state: 'open', pipeline: 'failed' })
    assert.match(html, /class="link-pipe" data-pipeline="failed"/)
    assert.match(html, /✕/)
    assert.match(html, /title="流水线：失败"/)
  })

  test('合入后不再挂历史流水线，只有状态', () => {
    const html = cell({ state: 'merged', pipeline: 'success' })
    assert.doesNotMatch(html, /link-pipe/)
    assert.match(html, /data-state="merged"/)
    assert.match(html, />merged</)
  })

  test('没跑过流水线时只留状态', () => {
    const html = cell({ state: 'open', pipeline: null })
    assert.doesNotMatch(html, /link-pipe/)
    assert.match(html, /data-state="open"/)
  })
})

describe('详情页浮窗 · 关联待办', () => {
  test('只列未完成的，整行点开那条待办', () => {
    const html = render({
      todos: [mkTodo({ id: 'T-1', title: '扫一遍日志', status: 'in_progress' }), mkTodo({ id: 'T-2', title: '已经做完的', status: 'done' })],
    })
    assert.match(html, /进行中/)
    assert.match(html, /扫一遍日志/)
    assert.doesNotMatch(html, /已经做完的/)
  })

  test('候选归属单独一段，行尾标「未确认」——推出来的不能冒充登记过的', () => {
    const html = render({
      todos: [mkTodo({ id: 'T-1', title: '登记过的' })],
      candidateTodos: [mkTodo({ id: 'T-9', title: '推出来的', requirementId: '' })],
    })
    assert.match(html, /关联待办/)
    assert.match(html, /待确认归属/)
    assert.match(html, /推出来的/)
    assert.match(html, /未确认/)
    // 标记只挂在候选那一行上：按标题定位到那条待办，别拿全文第一行凑数
    const rows = html.split('<div class="sess"').slice(1)
    const registered = rows.find((r) => r.includes('登记过的')) ?? ''
    assert.ok(registered, '登记过的那一行应当渲染出来')
    assert.doesNotMatch(registered, /未确认/)
    assert.match(rows.find((r) => r.includes('推出来的')) ?? '', /未确认/)
  })

  test('候选段在没候选时整段不出现', () => {
    const html = render({ todos: [mkTodo()] })
    assert.doesNotMatch(html, /待确认归属/)
  })
})
