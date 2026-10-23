/** 通知编排的回归：前台抑制、badge 去重、重启对齐、按需求合并 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AttentionTracker,
  UNKNOWN_TTL_MS,
  type AttentionEvent,
  type AttentionNotification,
  type AttentionRequirement,
  type AttentionSession,
} from '../server/attention.ts'
import { AttentionRuntime } from '../server/attention-runtime.ts'
import type { ThreadState } from '../server/session-state.ts'
import { shouldNotify, type NotificationMode } from '../src/shared/notification-mode.ts'

const REQ: AttentionRequirement = { id: 'req-1', title: '通知能力', slug: 'agent-notifications', project: 'easy-flow' }
const OTHER: AttentionRequirement = { id: 'req-2', title: '另一条', slug: 'other', project: 'easy-flow' }

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

function memoryStore(initial: AttentionEvent[] = []) {
  let events = [...initial]
  return {
    store: {
      read: () => [...events],
      write: (next: readonly AttentionEvent[]) => {
        events = [...next]
      },
    },
    current: () => events,
  }
}

function harness({
  notify = () => true,
  graceMs,
}: {
  notify?: () => boolean
  graceMs?: number
} = {}) {
  const memory = memoryStore()
  const badges: number[] = []
  const notifications: AttentionNotification[] = []
  const dismissals: string[] = []
  let signals = 0
  const runtime = new AttentionRuntime({
    store: memory.store,
    setBadge: (count) => badges.push(count),
    notify: (notification) => notifications.push(notification),
    shouldNotify: notify,
    dismiss: (requirementId) => dismissals.push(requirementId),
    ...(graceMs !== undefined ? { notifyGraceMs: graceMs } : {}),
    signal: () => {
      signals += 1
    },
  })
  return {
    runtime,
    memory,
    badges,
    notifications,
    dismissals,
    signals: () => signals,
  }
}

describe('前台抑制', () => {
  test('人正看着看板：badge 照更新，不发通知、不闪任务栏', () => {
    const h = harness({ notify: () => false })
    h.runtime.observe([])
    h.runtime.observe([session('blocked', 100, { needsAction: '继续吗' })])

    assert.equal(h.runtime.count(), 1)
    assert.deepEqual(h.badges, [0, 1])
    assert.equal(h.notifications.length, 0)
    assert.equal(h.signals(), 0)
  })

  test('后台：发通知，并给 Win 一个闪烁信号', () => {
    const h = harness()
    h.runtime.observe([])
    h.runtime.observe([session('blocked', 100, { needsAction: '继续吗' })])

    assert.equal(h.notifications.length, 1)
    assert.equal(h.notifications[0].title, REQ.title)
    assert.equal(h.notifications[0].body, '继续吗')
    assert.equal(h.signals(), 1)
  })
})

describe('通知时机', () => {
  const cases: Array<[NotificationMode, boolean, boolean]> = [
    ['never', true, false],
    ['never', false, false],
    ['unfocused', true, false],
    ['unfocused', false, true],
    ['always', true, true],
    ['always', false, true],
  ]

  for (const [mode, foreground, expected] of cases) {
    test(`${mode} / ${foreground ? '前台' : '后台'} → ${expected ? '发' : '不发'}`, () => {
      assert.equal(shouldNotify(mode, foreground), expected)
    })
  }
})

describe('通知门槛', () => {
  test('failed 先挂起，活过 2s 才通知', () => {
    const h = harness()
    h.runtime.observe([], 1_000)
    h.runtime.observe([session('failed', 1_100)], 1_100)
    assert.equal(h.notifications.length, 0)
    assert.equal(h.runtime.count(), 1, 'badge 仍然立即反映失败')

    h.runtime.observe([session('failed', 1_100)], 2_100)
    assert.equal(h.notifications.length, 0, '还没到确认窗口')

    h.runtime.observe([session('failed', 1_100)], 3_100)
    assert.equal(h.notifications.length, 1)
  })

  test('failed 在窗口内被下一个事件翻过去：不通知', () => {
    const h = harness()
    h.runtime.observe([], 1_000)
    h.runtime.observe([session('failed', 1_100)], 1_100)
    h.runtime.observe([session('thinking', 1_300)], 1_300)
    h.runtime.observe([session('thinking', 1_300)], 4_000)

    assert.equal(h.notifications.length, 0)
    assert.equal(h.runtime.count(), 0)
  })

  test('Interrupt 不通知；PermissionRequest 立即通知', () => {
    const h = harness()
    h.runtime.observe([], 1_000)
    h.runtime.observe([session('blocked', 1_100, { hookEvent: 'Interrupt' })], 1_100)
    assert.equal(h.notifications.length, 0)
    assert.equal(h.runtime.count(), 1)

    const h2 = harness()
    h2.runtime.observe([], 1_000)
    h2.runtime.observe(
      [session('blocked', 1_100, { hookEvent: 'PermissionRequest' })],
      1_100,
    )
    assert.equal(h2.notifications.length, 1)
  })
})

describe('通知收敛', () => {
  test('事件消账后关闭该需求的通知', () => {
    const h = harness()
    h.runtime.observe([session('blocked', 100)], 1_000)
    h.runtime.observe([session('idle', 200)], 2_000)

    assert.deepEqual(h.dismissals, [REQ.id])
  })

  test('同需求还有其它事件时不关通知', () => {
    const h = harness()
    h.runtime.observe(
      [session('blocked', 100), session('done', 100, { agent: 'codex', id: 's-2' })],
      1_000,
    )
    h.runtime.observe([session('done', 100, { agent: 'codex', id: 's-2' })], 2_000)

    assert.deepEqual(h.dismissals, [])
  })
})

describe('badge', () => {
  test('数量没变就不重复调 Dock', () => {
    const h = harness()
    h.runtime.observe([])
    h.runtime.observe([session('done', 100)])
    h.runtime.observe([session('done', 100)])
    h.runtime.observe([session('done', 100), session('done', 100, { agent: 'codex', id: 's-2' })])

    // 构造时 0，第一次真正变化 1，第二条会话 2；中间重复轮询不再调用
    assert.deepEqual(h.badges, [0, 1, 2])
  })

  test('事件消账后归零', () => {
    const h = harness()
    h.runtime.observe([session('done', 100)])
    h.runtime.observe([session('idle', 200)])

    assert.equal(h.runtime.count(), 0)
    assert.deepEqual(h.badges, [0, 1, 0])
  })

  test('长期 unknown 到 TTL：badge 归零', () => {
    const h = harness()
    h.runtime.observe([session('blocked', 100)], 1_000)
    h.runtime.observe([session('unknown', 0)], 2_000)
    assert.equal(h.runtime.count(), 1)

    h.runtime.observe([session('unknown', 0)], 2_000 + UNKNOWN_TTL_MS)
    assert.equal(h.runtime.count(), 0)
    assert.deepEqual(h.badges, [0, 1, 0])
  })
})

describe('重启', () => {
  test('持久化的事件恢复成 badge，但不再重复通知', () => {
    const tracker = new AttentionTracker()
    tracker.observe([session('done', 100)])
    const memory = memoryStore(tracker.snapshot())

    const badges: number[] = []
    const notifications: AttentionNotification[] = []
    const runtime = new AttentionRuntime({
      store: memory.store,
      setBadge: (count) => badges.push(count),
      notify: (notification) => notifications.push(notification),
      shouldNotify: () => true,
    })

    assert.deepEqual(badges, [1])
    runtime.observe([session('done', 100)])
    assert.equal(notifications.length, 0)
    assert.equal(runtime.count(), 1)
    assert.deepEqual(badges, [1])
  })
})

describe('合并与持久化', () => {
  test('同一轮询周期内两个需求各一条通知', () => {
    const h = harness()
    h.runtime.observe([])
    h.runtime.observe([
      session('done', 100),
      session('blocked', 200, { agent: 'codex', id: 's-2', requirement: OTHER }),
    ])

    assert.equal(h.notifications.length, 2)
    assert.deepEqual(
      h.notifications.map((n) => n.requirement.id).sort(),
      [REQ.id, OTHER.id],
    )
  })

  test('unknown 的计时起点也落盘，重启后继续累计而不是重新计时', () => {
    const memory = memoryStore()
    const runtime = new AttentionRuntime({
      store: memory.store,
      setBadge: () => {},
      notify: () => {},
      shouldNotify: () => false,
    })

    runtime.observe([session('blocked', 100)], 1_000)
    runtime.observe([session('unknown', 0)], 2_000)
    assert.equal(memory.current()[0].staleSince, 2_000)
  })

})
