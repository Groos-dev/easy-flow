import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { recordHook } from '../server/hook.ts'
import { SessionStateStore, type SessionObservation } from '../server/session-state.ts'

function newStore(): SessionStateStore {
  const table = new Map<string, SessionObservation>()
  return new SessionStateStore({
    get: (agent, session) => table.get(`${agent}:${session}`),
    put: (agent, session, observation) => { table.set(`${agent}:${session}`, observation) },
    drop: (agent, session) => table.delete(`${agent}:${session}`),
    keyOf: (_agent, session) => session,
    alias: () => {},
  })
}

const stateOf = (store: SessionStateStore, session = 'conv-1') =>
  store.get('cursor', session)?.status.state

describe('Cursor hook 归一', () => {
  test('只有 conversation_id 也能认；sessionStart 静止，后续事件按 camelCase 映射', () => {
    const store = newStore()
    recordHook({ hook_event_name: 'sessionStart', conversation_id: 'conv-1' }, { agent: 'cursor' }, store)
    assert.equal(stateOf(store), 'idle')

    recordHook({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-1' }, { agent: 'cursor' }, store)
    assert.equal(stateOf(store), 'thinking')

    recordHook(
      { hook_event_name: 'preToolUse', conversation_id: 'conv-1', tool_name: 'Shell', tool_input: { command: 'ls' } },
      { agent: 'cursor' },
      store,
    )
    assert.equal(stateOf(store), 'working')
    assert.equal(store.get('cursor', 'conv-1')?.action?.text, '跑 ls')

    recordHook({ hook_event_name: 'postToolUse', conversation_id: 'conv-1' }, { agent: 'cursor' }, store)
    assert.equal(stateOf(store), 'thinking')

    recordHook({ hook_event_name: 'postToolUseFailure', conversation_id: 'conv-1' }, { agent: 'cursor' }, store)
    assert.equal(stateOf(store), 'failed')

    recordHook({ hook_event_name: 'preCompact', conversation_id: 'conv-1' }, { agent: 'cursor' }, store)
    assert.equal(stateOf(store), 'sweeping')
  })

  test('stop 按 status 分 done / blocked / failed', () => {
    for (const [status, expected] of [
      ['completed', 'done'],
      ['aborted', 'blocked'],
      ['error', 'failed'],
    ] as const) {
      const store = newStore()
      recordHook({ hook_event_name: 'stop', conversation_id: 'conv-1', status }, { agent: 'cursor' }, store)
      assert.equal(stateOf(store), expected, status)
    }
  })

  test('sessionEnd 的 aborted / error 留最终状态，completed 摘除', () => {
    const aborted = newStore()
    recordHook({ hook_event_name: 'sessionEnd', conversation_id: 'conv-1', reason: 'aborted' }, { agent: 'cursor' }, aborted)
    assert.equal(stateOf(aborted), 'blocked')

    const failed = newStore()
    recordHook({ hook_event_name: 'sessionEnd', conversation_id: 'conv-1', reason: 'error', error_message: 'boom' }, { agent: 'cursor' }, failed)
    assert.equal(stateOf(failed), 'failed')
    assert.match(failed.get('cursor', 'conv-1')!.status.detail, /boom/)

    const completed = newStore()
    recordHook({ hook_event_name: 'sessionStart', conversation_id: 'conv-1' }, { agent: 'cursor' }, completed)
    recordHook({ hook_event_name: 'sessionEnd', conversation_id: 'conv-1', reason: 'completed' }, { agent: 'cursor' }, completed)
    assert.equal(stateOf(completed), undefined)
  })

  test('子 agent / 后台会话事件不写主会话', () => {
    for (const extra of [
      { subagent_id: 'sub-1' },
      { parent_conversation_id: 'parent-1' },
      { is_background_agent: true },
    ]) {
      const store = newStore()
      recordHook(
        { hook_event_name: 'preToolUse', conversation_id: 'conv-1', tool_name: 'Shell', tool_input: { command: 'ls' }, ...extra },
        { agent: 'cursor' },
        store,
      )
      assert.equal(stateOf(store), undefined)
    }
  })
})
