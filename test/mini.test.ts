import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as mini from '../src/renderer/src/lib/mini.ts'
import { sessionActive } from '../src/renderer/src/lib/threads.ts'
import MiniApp from '../src/renderer/src/mini/MiniApp.tsx'
import type { Requirement, Session, ThreadState } from '../src/renderer/src/lib/types.ts'

const NOW = Date.parse('2026-10-20T12:00:00')
const { buildMiniBlocks, miniTime, needsHuman } = mini

function req(over: Partial<Requirement> & { slug: string }): Requirement {
  return {
    id: `req-${over.slug}`,
    project: 'easy-flow',
    parentId: '',
    title: over.slug,
    status: 'in_progress',
    pinned: false,
    sessionAnalysisStatus: 'pending',
    priority: '',
    summary: '',
    repos: [],
    links: '',
    linkItems: [],
    tags: [],
    docs: [],
    path: `/tmp/${over.slug}`,
    mtime: NOW - 86400000,
    updated: '',
    ...over,
  }
}

function sess(
  over: Partial<Session> & { requirementId: string; session: string; state?: ThreadState; observedAt?: number },
): Session {
  const state = over.state ?? 'idle'
  return {
    agent: 'claude',
    title: '',
    cwd: '',
    link: '',
    created: '',
    updated: '2026-10-01 09:00',
    status: { state, needsAction: '', observedAt: over.observedAt ?? 0, detail: '' },
    action: null,
    ...over,
  }
}

const rowsOf = (...reqs: Requirement[]) => reqs.map((r) => ({ req: r, projectName: 'easy-flow' }))
const slugs = (blocks: ReturnType<typeof buildMiniBlocks>) => blocks.map((b) => b.req.slug)

describe('mini 面板的首屏', () => {
  test('数据还没到：画骨架，不先闪「没有匹配的需求」', () => {
    const html = renderToStaticMarkup(createElement(MiniApp))
    assert.match(html, /mini-skel/)
    assert.ok(!html.includes('没有匹配的需求'))
    assert.ok(!html.includes('mini-hints'))
  })
})

describe('mini 面板的过滤', () => {
  test('全部需求阶段均按最近活跃出现', () => {
    const rows = rowsOf(
      req({ slug: 'doing', status: 'in_progress', mtime: NOW - 3000 }),
      req({ slug: 'review', status: 'review', mtime: NOW - 2000 }),
      req({ slug: 'clarify', status: 'clarification', mtime: NOW - 1000 }),
      req({ slug: 'done', status: 'completed', mtime: NOW - 500 }),
    )
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions: [], query: '', expanded: '' })), [
      'done',
      'clarify',
      'review',
      'doing',
    ])
  })

  test('项目和标题分词搜索，忽略词序、大小写和多余空格', () => {
    const rows = rowsOf(req({ slug: 'tf', title: 'TF 标准价接入' }), req({ slug: 'other' }))
    for (const query of ['easy-flow TF 标准价', '标准价  EASY-FLOW   tf', '  TF   标准价  ']) {
      assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions: [], query, expanded: '' })), ['tf'])
    }
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions: [], query: 'TF 无此关键词', expanded: '' })), [])
  })

  test('self 项目在默认与搜索列表中均隐藏', () => {
    const rows = rowsOf(req({ slug: 'self', project: 'self', title: 'mini' }), req({ slug: 'mini', title: 'mini' }))
    for (const query of ['', 'mini']) {
      assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions: [], query, expanded: '' })), ['mini'])
    }
  })

  test('有过滤词时穿透状态：刚合入的需求也搜得到', () => {
    const rows = rowsOf(
      req({ slug: 'done', title: '刚合入的需求', status: 'completed' }),
      req({ slug: 'doing', title: '还在做', status: 'in_progress' }),
    )
    const blocks = buildMiniBlocks({ rows, sessions: [], query: '刚合入', expanded: '' })
    assert.deepEqual(slugs(blocks), ['done'])
  })
})

describe('mini 面板的排序', () => {
  test('要人看的排在正在跑的前面', () => {
    const rows = rowsOf(req({ slug: 'running' }), req({ slug: 'finished' }))
    const sessions = [
      sess({ requirementId: 'req-running', session: 's1', state: 'working', observedAt: NOW - 30_000 }),
      sess({ requirementId: 'req-finished', session: 's2', state: 'done', observedAt: NOW - 3_600_000 }),
    ]
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions, query: '', expanded: '' })), [
      'finished',
      'running',
    ])
  })

  test('要人的一组内部按事件时刻倒序', () => {
    const rows = rowsOf(req({ slug: 'blocked' }), req({ slug: 'done' }), req({ slug: 'failed' }))
    const sessions = [
      sess({ requirementId: 'req-blocked', session: 'a', state: 'blocked', observedAt: NOW - 9_000 }),
      sess({ requirementId: 'req-done', session: 'b', state: 'done', observedAt: NOW - 1_000 }),
      sess({ requirementId: 'req-failed', session: 'c', state: 'failed', observedAt: NOW - 5_000 }),
    ]
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions, query: '', expanded: '' })), [
      'done',
      'failed',
      'blocked',
    ])
  })

  test('介入任务同组按最近活跃排序，包含最近文档活动', () => {
    const rows = rowsOf(req({ slug: 'recent-doc', mtime: NOW }), req({ slug: 'recent-event' }))
    const sessions = [
      sess({ requirementId: 'req-recent-doc', session: 'a', state: 'blocked', observedAt: NOW - 10_000 }),
      sess({ requirementId: 'req-recent-event', session: 'b', state: 'done', observedAt: NOW - 1_000 }),
    ]
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions, query: '', expanded: '' })), ['recent-doc', 'recent-event'])
  })

  test('活跃取会话状态更新时刻，而不是登记时刻', () => {
    const old = sess({
      requirementId: 'req-live',
      session: 's1',
      state: 'thinking',
      observedAt: NOW - 20_000,
      updated: '2026-10-01 09:00',
    })
    const rows = rowsOf(
      req({ slug: 'live', mtime: NOW - 3 * 86400000 }),
      req({ slug: 'quiet', mtime: NOW - 60_000 }),
    )
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions: [old], query: '', expanded: '' })), [
      'live',
      'quiet',
    ])
  })

  test('点过 pet（写 idle + 新时刻）也算一次活跃', () => {
    const clicked = sess({ requirementId: 'req-clicked', session: 's1', state: 'idle', observedAt: NOW - 1_000 })
    const rows = rowsOf(
      req({ slug: 'clicked', mtime: NOW - 5 * 86400000 }),
      req({ slug: 'quiet', mtime: NOW - 60_000 }),
    )
    assert.deepEqual(slugs(buildMiniBlocks({ rows, sessions: [clicked], query: '', expanded: '' })), [
      'clicked',
      'quiet',
    ])
  })

  test('sessionActive 取观察时刻与登记时刻里更晚的那个', () => {
    assert.equal(sessionActive(sess({ requirementId: 'r', session: 's', observedAt: NOW })), NOW)
    const registered = sess({ requirementId: 'r', session: 's', observedAt: 0, updated: '2026-10-19 08:00' })
    assert.equal(sessionActive(registered), Date.parse('2026-10-19T08:00'))
  })

  test('跑完 / 卡住 / 出错要人看，正在跑与静止不要', () => {
    const at = (state: ThreadState) => [sess({ requirementId: 'r', session: 's', state })]
    assert.equal(needsHuman(at('done')), true)
    assert.equal(needsHuman(at('blocked')), true)
    assert.equal(needsHuman(at('failed')), true)
    assert.equal(needsHuman(at('working')), false)
    assert.equal(needsHuman(at('idle')), false)
  })
})

describe('mini 面板的动作行', () => {
  const requirement = req({
    slug: 'demo',
    title: '示例需求',
    linkItems: [
      { title: '', url: 'https://gitlab.example.com/onex/easy-flow/-/merge_requests/128' },
      { title: '', url: 'https://quicket.feishu.cn/onex/story/detail/123' },
      { title: '设计稿', url: 'https://example.com/design' },
    ],
  })
  const sessions = [
    sess({ requirementId: 'req-demo', session: 'old', title: '旧方案调研', observedAt: NOW - 90_000_000, link: 'claude://1' }),
    sess({ requirementId: 'req-demo', session: 'new', title: '', observedAt: NOW - 60_000, link: 'codex://2' }),
  ]

  test('展开后会话与链接依序排列，长链接列表带更多入口', () => {
    const blocks = buildMiniBlocks({
      rows: rowsOf(requirement),
      sessions,
      query: '',
      expanded: 'easy-flow:demo',
    })
    const kinds = blocks[0].children.map((c) => c.kind)
    assert.deepEqual(kinds, ['session', 'session', 'more', 'link', 'link'])
    const more = blocks[0].children.find(c => c.kind === 'more')
    assert.ok(more?.kind === 'more' && more.group === 'links' && more.remaining === 1 && !more.expanded)
  })

  test('没展开就没有动作行', () => {
    const blocks = buildMiniBlocks({ rows: rowsOf(requirement), sessions, query: '', expanded: '' })
    assert.equal(blocks[0].children.length, 0)
  })

  test('会话按活跃倒序，标题为空的那条交给 id', () => {
    const [block] = buildMiniBlocks({ rows: rowsOf(requirement), sessions, query: '', expanded: 'easy-flow:demo' })
    const list = block.children.filter((c) => c.kind === 'session')
    assert.deepEqual(
      list.map((c) => (c.kind === 'session' ? c.session.session : '')),
      ['new', 'old'],
    )
    assert.equal(list[0].kind === 'session' && list[0].session.title, '')
  })

  test('MR 与飞书链接用短标签，扩展链接用描述', () => {
    const [block] = buildMiniBlocks({ rows: rowsOf(requirement), sessions: [], query: '', expanded: 'easy-flow:demo', expandedLinks: true })
    const links = block.children.filter((c) => c.kind === 'link')
    assert.deepEqual(
      links.map((c) => (c.kind === 'link' ? c.value : '')),
      ['easy-flow !128', 'onex/story/123', '设计稿'],
    )
  })

  test('较早的介入会话排在较新的普通会话之前', () => {
    const ss = [
      sess({ requirementId: 'req-demo', session: 'normal', observedAt: NOW }),
      sess({ requirementId: 'req-demo', session: 'waiting', state: 'blocked', observedAt: NOW - 5_000 }),
    ]
    const [block] = buildMiniBlocks({ rows: rowsOf(requirement), sessions: ss, query: '', expanded: 'easy-flow:demo' })
    assert.deepEqual(block.sessions.map(s => s.session), ['waiting', 'normal'])
  })

  test('默认展示两条会话，展开更多可访问全部，保持会话键稳定', () => {
    const ss = Array.from({ length: 4 }, (_, i) => sess({ requirementId: 'req-demo', session: `s${i}`, observedAt: NOW - i * 1000 }))
    const input = { rows: rowsOf(requirement), sessions: ss, query: '', expanded: 'easy-flow:demo' }
    const compact = buildMiniBlocks(input)[0].children
    const full = buildMiniBlocks({ ...input, expandedSessions: true })[0].children
    const compactSessions = compact.filter(c => c.kind === 'session')
    const fullSessions = full.filter(c => c.kind === 'session')
    assert.equal(compactSessions.length, 2)
    assert.equal(fullSessions.length, 4)
    assert.deepEqual(compactSessions.map(c => c.key), fullSessions.slice(0, 2).map(c => c.key))
    assert.ok(compact.some(c => c.kind === 'more' && c.group === 'sessions' && c.remaining === 2 && !c.expanded))
    assert.ok(full.some(c => c.kind === 'more' && c.group === 'sessions' && c.expanded))
  })

  test('全部介入会话始终可见，普通会话可通过更多查看', () => {
    const ss = ['blocked', 'failed', 'done', 'idle'].map((state, i) => sess({ requirementId: 'req-demo', session: `s${i}`, state: state as ThreadState, observedAt: NOW - i * 1000 }))
    const [block] = buildMiniBlocks({ rows: rowsOf(requirement), sessions: ss, query: '', expanded: 'easy-flow:demo' })
    assert.deepEqual(block.children.filter(c => c.kind === 'session').map(c => c.session.status.state), ['blocked', 'failed', 'done'])
    assert.ok(block.children.some(c => c.kind === 'more' && c.group === 'sessions' && c.remaining === 1))
  })

  test('没有会话与链接时，展开列表为空', () => {
    const [block] = buildMiniBlocks({ rows: rowsOf(req({ slug: 'empty' })), sessions: [], query: '', expanded: 'easy-flow:empty' })
    assert.deepEqual(block.children, [])
  })
})

describe('mini 会话可打开性', () => {
  test('深链与 Cursor 工作区可打开，其余无链接会话不可打开', () => {
    const base = { requirementId: 'r', session: 's' }
    assert.equal(mini.miniSessionOpenable(sess({ ...base, link: 'codex://threads/s' })), true)
    assert.equal(mini.miniSessionOpenable(sess({ ...base, agent: 'cursor', cwd: '/repo' })), true)
    assert.equal(mini.miniSessionOpenable(sess({ ...base, agent: 'cursor' })), false)
    assert.equal(mini.miniSessionOpenable(sess({ ...base, agent: 'claude', cwd: '/repo' })), false)
  })
})

describe('mini 面板的相对时间', () => {
  test('分钟 / 小时 / 天', () => {
    const now = Date.now()
    assert.equal(miniTime(now - 5_000), '刚刚')
    assert.equal(miniTime(now - 5 * 60_000), '5 分钟前')
    assert.equal(miniTime(now - 3 * 3600_000), '3 小时前')
    assert.equal(miniTime(now - 2 * 86400_000), '2 天前')
    assert.equal(miniTime(0), '')
  })
})
