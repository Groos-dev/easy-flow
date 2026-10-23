/** 会话事件 → 通知 / dock 红点的纯逻辑回归 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AttentionTracker,
  UNKNOWN_TTL_MS,
  attentionPushKeyOf,
  groupAttentionNotifications,
  readAttentionFile,
  type AttentionEvent,
  type AttentionRequirement,
  type AttentionSession,
} from '../server/attention.ts'
import type { ThreadState } from '../server/session-state.ts'

const REQ: AttentionRequirement = { id: 'req-1', title: '通知能力', slug: 'agent-notifications', project: 'easy-flow' }

function session(
  state: ThreadState,
  observedAt: number,
  {
    agent = 'claude',
    id = 's-1',
    needsAction = '',
    sessionTitle = '',
    hookEvent = '',
    requirement = REQ,
  }: {
    agent?: string
    id?: string
    needsAction?: string
    sessionTitle?: string
    hookEvent?: string
    requirement?: AttentionRequirement
  } = {},
): AttentionSession {
  return {
    agent,
    session: id,
    sessionTitle,
    link: '',
    requirement,
    status: { state, needsAction, observedAt, hookEvent: hookEvent || undefined },
  }
}

function event(
  state: 'done' | 'blocked' | 'failed',
  observedAt: number,
  {
    agent = 'claude',
    id = 's-1',
    needsAction = '',
    sessionTitle = '',
    hookEvent = '',
    requirement = REQ,
  }: {
    agent?: string
    id?: string
    needsAction?: string
    sessionTitle?: string
    hookEvent?: string
    requirement?: AttentionRequirement
  } = {},
): AttentionEvent {
  return {
    id: `${agent}:${id}`,
    pushKey: attentionPushKeyOf(agent, id, state, observedAt),
    agent,
    session: id,
    sessionTitle,
    link: '',
    requirement,
    state,
    needsAction,
    observedAt,
    hookEvent: hookEvent || undefined,
  }
}

describe('事件判定', () => {
  test('启动第一轮只对齐，不补炸停机期间的事件', () => {
    const tracker = new AttentionTracker()
    const diff = tracker.observe([session('done', 100)])
    assert.equal(diff.outstanding.length, 1)
    assert.equal(diff.added.length, 0)
  })

  test('同一轮询反复读到同一个观察：只算一次', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('done', 100)])
    const first = tracker.observe([session('done', 100)])
    assert.equal(first.added.length, 0)
    const again = tracker.observe([session('done', 100)])
    assert.equal(again.added.length, 0)
    assert.equal(again.outstanding.length, 1)
  })

  test('同一状态在 10s 内重复投递：只算一条', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('failed', 1_000)], 1_000)

    const duplicate = tracker.observe([session('failed', 4_000)], 4_000)
    assert.equal(duplicate.added.length, 0)
    assert.equal(duplicate.outstanding.length, 1)

    const later = tracker.observe([session('failed', 20_000)], 20_000)
    assert.equal(later.added.length, 1)
  })

  test('hook 推送与随后的 pull 快照是同一事件：不重复', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('failed', 1_000, { hookEvent: 'PostToolUseFailure' })], 1_000)

    const pulled = tracker.observe([session('failed', 2_000)], 2_000)
    assert.equal(pulled.added.length, 0)
    assert.equal(pulled.outstanding.length, 1)
  })

  test('hook 先到、问题原文后到：合并成一条并补上原文', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('blocked', 1_000, { hookEvent: 'PermissionRequest' })], 1_000)

    const pulled = tracker.observe([session('blocked', 2_000, { needsAction: '批准这条命令' })], 2_000)
    assert.equal(pulled.added.length, 0)
    assert.equal(pulled.outstanding[0].needsAction, '批准这条命令')
  })

  test('10s 内换了 hook 事件不算重复投递：Interrupt 之后的授权请求要推', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('blocked', 1_000, { hookEvent: 'Interrupt' })], 1_000)

    const permission = tracker.observe(
      [session('blocked', 4_000, { hookEvent: 'PermissionRequest' })],
      4_000,
    )
    assert.equal(permission.added.length, 1)
    assert.equal(permission.added[0].hookEvent, 'PermissionRequest')
  })

  test('同一会话下一轮：新事件，要推送', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('done', 100)])
    const next = tracker.observe([session('blocked', 200, { needsAction: '选 A 还是 B' })])
    assert.equal(next.added.length, 1)
    assert.equal(next.added[0].state, 'blocked')
    assert.equal(next.added[0].needsAction, '选 A 还是 B')
  })

  test('unknown 是读不到，不是没事了：保留已挂事件', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('blocked', 100)])
    const diff = tracker.observe([session('unknown', 0)])
    assert.equal(diff.outstanding.length, 1)
    assert.equal(diff.cleared.length, 0)
  })

  test('点 pet / 开始新一轮：消账', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('blocked', 100)])
    const idle = tracker.observe([session('idle', 300)])
    assert.equal(idle.outstanding.length, 0)
    assert.equal(idle.cleared.length, 1)
  })

  test('一直 unknown 超过 24h：TTL 收掉，不永久占着红点', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('blocked', 100)], 1_000)
    const kept = tracker.observe([session('unknown', 0)], 2_000)
    assert.equal(kept.outstanding.length, 1)
    assert.equal(kept.expired.length, 0)

    const expired = tracker.observe([session('unknown', 0)], 2_000 + UNKNOWN_TTL_MS)
    assert.equal(expired.outstanding.length, 0)
    assert.equal(expired.cleared.length, 0)
    assert.equal(expired.expired.length, 1)
    assert.equal(expired.expired[0].state, 'blocked')
  })

  test('unknown 中途读回来：TTL 重新计时', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('done', 100)], 1_000)
    tracker.observe([session('unknown', 0)], 2_000)
    // 读回来了，staleSince 清掉
    tracker.observe([session('done', 100)], 3_000)
    // 再次 unknown 从这一刻重新累计，不满 24h 不收
    const kept = tracker.observe([session('unknown', 0)], 3_000 + UNKNOWN_TTL_MS - 1)
    assert.equal(kept.outstanding.length, 1)
    assert.equal(kept.expired.length, 0)
  })

  test('会话下线：消账', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('failed', 100)])
    const gone = tracker.observe([])
    assert.equal(gone.outstanding.length, 0)
    assert.equal(gone.cleared.length, 1)
  })

  test('重启：恢复 outstanding，但不重复推送', () => {
    const before = new AttentionTracker()
    before.observe([session('done', 100)])

    const after = new AttentionTracker(before.snapshot())
    const diff = after.observe([session('done', 100)])
    assert.equal(diff.outstanding.length, 1)
    assert.equal(diff.added.length, 0)
  })

  test('重启：停机期间已经消掉的事件被清掉', () => {
    const after = new AttentionTracker([event('done', 100)])
    const diff = after.observe([session('idle', 300)])
    assert.equal(diff.outstanding.length, 0)
    assert.equal(diff.cleared.length, 1)
    assert.equal(diff.added.length, 0)
  })
})

describe('通知合并', () => {
  test('同一需求的多条事件合成一条：标题是需求，副标题是 agent', () => {
    const other: AttentionRequirement = { id: 'req-2', title: '另一条', slug: 'two', project: 'easy-flow' }
    const items = groupAttentionNotifications([
      event('done', 100),
      event('blocked', 200, { agent: 'codex', id: 's-2', needsAction: '批准这条命令' }),
      event('failed', 300, { agent: 'codex', id: 's-3', requirement: other }),
    ])

    assert.equal(items.length, 2)

    const first = items.find((i) => i.requirement.id === REQ.id)!
    assert.equal(first.title, REQ.title)
    assert.equal(first.subtitle, 'Claude Code、Codex')
    assert.equal(first.body, 'Codex：批准这条命令')
    assert.equal(first.silent, false)

    const second = items.find((i) => i.requirement.id === other.id)!
    assert.equal(second.subtitle, 'Codex')
    assert.equal(second.body, '')
    assert.equal(second.silent, false)
  })

  test('单条 blocked 的正文用 needsAction 原话；跑完不写轮次描述', () => {
    const blocked = groupAttentionNotifications([
      event('blocked', 100, { needsAction: '要不要继续？' }),
    ])[0]
    assert.equal(blocked.title, REQ.title)
    assert.equal(blocked.subtitle, 'Claude Code')
    assert.equal(blocked.body, '要不要继续？')
    assert.equal(blocked.silent, false)

    const done = groupAttentionNotifications([event('done', 100)])[0]
    assert.equal(done.subtitle, 'Claude Code')
    assert.equal(done.body, '')
    assert.equal(done.silent, true)
  })

  test('需求标题过长：压成一行并截断加省略号', () => {
    const long: AttentionRequirement = {
      ...REQ,
      id: 'req-long',
      title: '这是一个非常非常非常非常非常长的需求标题\n第二行也要压掉',
    }
    const title = groupAttentionNotifications([
      event('done', 100, { requirement: long }),
    ])[0].title

    assert.equal(title.includes('\n'), false)
    assert.equal(title.endsWith('…'), true)
    assert.equal([...title].length, 15)
  })

  test('同 agent 同名会话只列一次；空标题只显示 agent', () => {
    const items = groupAttentionNotifications([
      event('done', 100, { id: 's-1', sessionTitle: '修复通知图标' }),
      event('done', 200, { id: 's-2', sessionTitle: '修复通知图标' }),
    ])
    assert.equal(items[0].subtitle, 'Claude Code · 修复通知图标')

    const empty = groupAttentionNotifications([event('done', 100)])[0]
    assert.equal(empty.subtitle, 'Claude Code')
  })

  test('副标题在 agent 名后带上会话标题', () => {
    const n = groupAttentionNotifications([
      event('blocked', 100, { sessionTitle: '修复通知图标', needsAction: '继续吗' }),
    ])[0]
    assert.equal(n.subtitle, 'Claude Code · 修复通知图标')
  })

})

describe('持久化文件', () => {
  test('坏文件读成空数组，不让启动失败', () => {
    assert.deepEqual(readAttentionFile('not json'), [])
    assert.deepEqual(readAttentionFile('{"events":null}'), [])
  })

  test('只认形状完整的事件', () => {
    const saved = JSON.stringify({ events: [event('done', 100), { id: 'broken' }] })
    const events = readAttentionFile(saved)
    assert.equal(events.length, 1)
    assert.equal(events[0].pushKey, attentionPushKeyOf('claude', 's-1', 'done', 100))
  })

})
