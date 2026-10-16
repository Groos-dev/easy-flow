/**
 * 工具动作：一次工具调用裁成气泡里那句文案。
 *
 * 两件事——各工具的裁剪规则（含认不出的工具）、动作与状态怎么并排落库。
 * 每条规则都对应本机真实取样里的形态（见需求 docs/easy-flow/action-sources.html）。
 *
 * 运行：pnpm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ACTION_MAX_WIDTH, actionOf, actionTextOf } from '../server/action.ts'
import { BoardDatabase } from '../server/db.ts'
import { SessionStateStore, type SessionStatus } from '../server/session-state.ts'
import { hookActionOf, normalizeHookEvent } from '../server/hook.ts'
import { rolloutActionOf, rolloutStatusOf } from '../server/rollout.ts'
import { readObservations } from '../server/threads.ts'

/** 状态层与读位置都落在 sqlite 上：动作要跟着状态一起落库，用真库才测得到那一层 */
let storeSeq = 0
function newStore(): { db: BoardDatabase; store: SessionStateStore } {
  const db = new BoardDatabase(join(tmpdir(), `easy-flow-test-action-${process.pid}`, String(storeSeq++)), 'p')
  const store = new SessionStateStore({
    get: (agent, session) => db.getSessionObservation(agent, session),
    put: (agent, session, observation) => db.putSessionObservation(agent, session, observation),
    drop: (agent, session) => db.dropSessionObservation(agent, session),
    keyOf: (agent, session) => db.keyOf(agent, session),
    alias: (agent, session, key) => db.alias(agent, session, key),
  })
  return { db, store }
}

function status(patch: Partial<SessionStatus> = {}): SessionStatus {
  return { state: 'working', needsAction: '', observedAt: 1_000, detail: '夹具', ...patch }
}

// ---------------------------------------------------------------- 归一

describe('工具动作：一次调用裁成一句文案', () => {
  test('文件类取路径末段——一行里放得下的是文件名', () => {
    const file = { file_path: '/Users/groos/repo/easy-flow/server/hook.ts' }
    assert.equal(actionTextOf('Edit', file), '改 hook.ts')
    assert.equal(actionTextOf('Write', file), '写 hook.ts')
    assert.equal(actionTextOf('Read', file), '读 hook.ts')
    assert.equal(actionTextOf('Read', { file_path: 'hook.ts' }), '读 hook.ts', '本来就只有一段')
  })

  test('命令类取前两个词，丢掉开关与后面的参数', () => {
    assert.equal(actionTextOf('Bash', { command: 'pnpm test --filter app' }), '跑 pnpm test')
    assert.equal(actionTextOf('Bash', { command: 'rg -n "foo|bar" src/' }), '跑 rg "foo|bar"')
    assert.equal(actionTextOf('Bash', { command: '  pnpm   typecheck  ' }), '跑 pnpm typecheck', '多余空白不影响')
  })

  test('开头的 cd 段只是定位，剥掉再取前两个词', () => {
    assert.equal(actionTextOf('Bash', { command: 'cd /Users/groos/repo/easy-flow && pnpm test' }), '跑 pnpm test')
    assert.equal(actionTextOf('Bash', { command: 'cd /a 2>/dev/null && cd sub && git status' }), '跑 git status')
    assert.equal(actionTextOf('Bash', { command: 'cd /x; pnpm test' }), '跑 pnpm test')
    assert.equal(
      actionTextOf('Bash', { command: 'cd /Users/groos/repo/easy-flow' }),
      '跑 cd /Users/groos/repo/easy-flow',
      '整条命令只有 cd 时剥完就空了，退回原样——那一下它确实只是在切目录',
    )
  })

  test('codex 的工具名与参数位置也认', () => {
    assert.equal(actionTextOf('exec_command', { cmd: 'cd /x && pnpm test' }), '跑 pnpm test')
    assert.equal(actionTextOf('view_image', { path: '/tmp/shot.png' }), '看 shot.png')
  })

  test('搜索类原样给 pattern', () => {
    assert.equal(actionTextOf('Grep', { pattern: 'focusIndex' }), '搜 focusIndex')
    assert.equal(actionTextOf('Glob', { pattern: 'src/**/*.ts' }), '搜 src/**/*.ts')
  })

  test('派子 agent 用描述，超过 12 个字就截', () => {
    assert.equal(actionTextOf('Agent', { description: '查登录流程' }), '派 查登录流程')
    assert.equal(actionTextOf('Task', { description: 'Confirm hook semantics' }), '派 Confirm hook…')
  })

  test('认不出的工具返回空串，不猜参数、不编动作', () => {
    assert.equal(actionTextOf('mcp__Claude_Browser__preview_screenshot', { name: 'x' }), '')
    assert.equal(actionTextOf('Skill', { skill: 'easy-flow' }), '')
    assert.equal(actionTextOf('write_stdin', { chars: 'y' }), '')
    assert.equal(actionTextOf('Edit', { file_path: 42 }), '', '参数类型不对也算取不到')
    assert.equal(actionTextOf('Edit', {}), '')
    assert.equal(actionTextOf('Bash', null), '')
  })

  test('整句封顶：超过两行的容量就截断加省略号', () => {
    const long = actionTextOf('Bash', {
      command: 'cat bookseat-aggregation-domain/src/main/java/com/ctrip/flight/onex/exchange/FlightPlaneService.java',
    })
    assert.ok(long.length < 60, `该被截短，实际 ${long}`)
    assert.ok(long.endsWith('…'), '截了就该看得出来')
    assert.ok(long.startsWith('跑 cat'), '动词与开头照旧')

    assert.equal(actionTextOf('Bash', { command: 'pnpm test' }), '跑 pnpm test', '没超的照原样，不加省略号')

    const wide = actionTextOf('Grep', { pattern: 'x'.repeat(ACTION_MAX_WIDTH + 20) })
    assert.ok(wide.endsWith('…'), '搜索词原样交给整句封顶去管')
  })
})

describe('动作带时刻', () => {
  const calledAt = 1_700_000_000_000

  test('认得出才造动作，认不出是 null', () => {
    assert.deepEqual(actionOf('Edit', { file_path: '/a/hook.ts' }, calledAt), { text: '改 hook.ts', calledAt })
    assert.equal(actionOf('Skill', { skill: 'x' }, calledAt), null)
  })

})

// ---------------------------------------------------------------- 进状态层

describe('动作与状态并排进状态层', () => {
  const calledAt = 1_700_000_000_000

  test('hook：PreToolUse 有动作，其余事件没有', () => {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/hook.ts' } }
    assert.equal(normalizeHookEvent(payload, calledAt)?.state, 'working')
    assert.deepEqual(hookActionOf(payload, calledAt), { text: '改 hook.ts', calledAt })

    assert.equal(hookActionOf({ hook_event_name: 'PostToolUse', tool_name: 'Edit' }, calledAt), null, '跑完不换动作')
    assert.equal(hookActionOf({ hook_event_name: 'PreToolUse', tool_name: 'Skill' }, calledAt), null, '认不出工具就没有动作')
  })

  test('后到的观察没带动作时，旧动作留着', () => {
    const { store } = newStore()
    store.put('claude', 'a', status({ observedAt: calledAt }), { text: '改 hook.ts', calledAt })
    store.put('claude', 'a', status({ state: 'thinking', observedAt: calledAt + 1_000 }))
    const got = store.get('claude', 'a')
    assert.equal(got?.status.state, 'thinking')
    assert.equal(got?.action?.text, '改 hook.ts', 'codex 那条「动作来自 rollout、hook 只报事件名」的兜底就靠这条')
  })

  test('带了更新的动作就换掉，带更旧的不许顶掉新的', () => {
    const { store } = newStore()
    store.put('claude', 'a', status({ observedAt: calledAt }), { text: '改 hook.ts', calledAt })

    store.put('claude', 'a', status({ observedAt: calledAt + 1_000 }), { text: '跑 pnpm test', calledAt: calledAt - 5_000 })
    assert.equal(store.get('claude', 'a')?.action?.text, '改 hook.ts', '状态换了但动作更旧，不该顶掉')

    store.put('claude', 'a', status({ observedAt: calledAt + 2_000 }), { text: '跑 pnpm test', calledAt: calledAt + 2_000 })
    assert.equal(store.get('claude', 'a')?.action?.text, '跑 pnpm test')
  })

  test('两样一起落库，重启后读得回来', () => {
    const { db, store } = newStore()
    store.put('claude', 'a', status({ observedAt: calledAt }), { text: '改 hook.ts', calledAt })

    const reopened = new SessionStateStore({
      get: (agent, session) => db.getSessionObservation(agent, session),
      put: (agent, session, observation) => db.putSessionObservation(agent, session, observation),
      drop: (agent, session) => db.dropSessionObservation(agent, session),
      keyOf: (agent, session) => db.keyOf(agent, session),
      alias: (agent, session, key) => db.alias(agent, session, key),
    })
    const got = reopened.get('claude', 'a')
    assert.equal(got?.status.state, 'working')
    assert.deepEqual(got?.action, { text: '改 hook.ts', calledAt })
  })

  test('读口把动作原样带出来，没有就是 null', () => {
    const { store } = newStore()
    store.put('claude', 'a', status({ observedAt: calledAt }), { text: '改 hook.ts', calledAt })
    store.put('claude', 'b', status({ observedAt: calledAt }))

    const [a, b] = readObservations(
      [
        { agent: 'claude', session: 'a' },
        { agent: 'claude', session: 'b' },
      ],
      store,
    )
    assert.deepEqual(a.action, { text: '改 hook.ts', calledAt })
    assert.equal(b.action, null)
  })
})

describe('rollout 也给动作', () => {
  const calledAt = 1_700_000_000_000
  const call = (name: string, args: unknown) => ({
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args) },
  })

  test('function_call 的工具名与参数归一成动作，状态照旧是干活', () => {
    const line = call('exec_command', { cmd: 'cd /x && pnpm test' })
    assert.equal(rolloutStatusOf(line, calledAt)?.state, 'working')
    assert.deepEqual(rolloutActionOf(line, calledAt), { text: '跑 pnpm test', calledAt })
  })

  test('参数解不开就没有动作', () => {
    const line = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{半截' } }
    assert.equal(rolloutStatusOf(line, calledAt)?.state, 'working')
    assert.equal(rolloutActionOf(line, calledAt), null)
  })

  test('认不出的工具、以及不是 function_call 的行，都没有动作', () => {
    assert.equal(rolloutActionOf(call('write_stdin', {}), calledAt), null)
    assert.equal(rolloutActionOf({ type: 'response_item', payload: { type: 'reasoning' } }, calledAt), null)
    assert.equal(rolloutActionOf({ type: 'event_msg', payload: { type: 'task_complete' } }, calledAt), null)
  })
})
