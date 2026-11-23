/**
 * Antigravity（Agent Manager）接入的回归：hook 报文归一、工具名、transcript 读取、
 * hooks.json 的分组写法（只动 easy-flow 那组、装完再卸逐字还原），以及新会话启动的 provider。
 *
 * 全程在临时目录上跑，绝不碰用户的 ~/.gemini。
 *
 * 运行：pnpm test
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { recordHook } from '../server/hook.ts'
import { SessionStateStore, type SessionObservation } from '../server/session-state.ts'
import { antigravityObservations, antigravityTitles, antigravityToolCall, observationOfSteps } from '../server/antigravity.ts'
import { hookPlan, installHooks, uninstallHooks } from '../server/hook-install.ts'
import { antigravityOpenArgs, antigravityProvider } from '../server/launch-antigravity.ts'
import { agentLabel, canOpenWorkspace, workspaceAppOf } from '../src/shared/agents.ts'

const TMP = join(tmpdir(), `easy-flow-antigravity-${process.pid}`)

function newStore(): SessionStateStore {
  const table = new Map<string, SessionObservation>()
  return new SessionStateStore({
    list: () => [...table].map(([key, observation]) => {
      const [agent, session] = key.split(':')
      return { agent, session, observation }
    }),
    keys: () => [],
    get: (agent, session) => table.get(`${agent}:${session}`),
    put: (agent, session, observation) => { table.set(`${agent}:${session}`, observation) },
    drop: (agent, session) => table.delete(`${agent}:${session}`),
    keyOf: (_agent, session) => session,
    alias: () => {},
  })
}

const AGENT = { agent: 'antigravity' }

describe('Antigravity hook 归一', () => {
  test('conversationId 当会话 id；事件名可以只在 URL 里（index.ts 填进 hook_event_name）', () => {
    const store = newStore()
    let at = 1_000
    const send = (payload: Record<string, unknown>) => recordHook({ conversationId: 'conv-1', ...payload }, { ...AGENT, at: at++ }, store)
    const state = () => store.get('antigravity', 'conv-1')?.status.state

    send({ hookEventName: 'SessionStart' })
    assert.equal(state(), 'idle')
    send({ hookEventName: 'PreInvocation' })
    assert.equal(state(), 'thinking')
    send({ hook_event_name: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'cd /repo && npm test -- --ci' } } })
    assert.equal(state(), 'working')
    assert.match(store.get('antigravity', 'conv-1')?.action?.text ?? '', /npm test/)
    send({ hookEventName: 'PostToolUse', toolCall: { name: 'run_command', args: {} }, error: '' })
    assert.equal(state(), 'thinking')
    send({ hookEventName: 'PostInvocation' })
    assert.equal(state(), 'thinking')
    send({ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', error: '' })
    assert.equal(state(), 'done')
  })

  test('出错与终止原因折成已有状态', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ hookEventName: 'PostToolUse', toolCall: { name: 'read_file', args: {} }, error: 'ENOENT' }, 'failed'],
      [{ hookEventName: 'Stop', terminationReason: 'ERROR', error: '' }, 'failed'],
      [{ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL', error: 'quota' }, 'failed'],
      [{ hookEventName: 'Stop', terminationReason: 'USER_CANCELED', error: '' }, 'blocked'],
      [{ hookEventName: 'Stop', terminationReason: 'MAX_INVOCATIONS', error: '' }, 'blocked'],
    ]
    for (const [payload, expected] of cases) {
      const store = newStore()
      recordHook({ conversationId: 'c', ...payload }, AGENT, store)
      assert.equal(store.get('antigravity', 'c')?.status.state, expected, JSON.stringify(payload))
    }
  })

  test('别的 agent 的报文不走 Antigravity 归一', () => {
    const store = newStore()
    assert.equal(recordHook({ conversationId: 'c', hookEventName: 'PreInvocation' }, { agent: 'claude' }, store), null)
  })
})

describe('Antigravity 工具名', () => {
  test('新名与旧别名都归到已有动作，参数名各取各的', () => {
    assert.deepEqual(antigravityToolCall('run_command', { CommandLine: 'ls' }), { tool: 'Bash', input: { command: 'ls' } })
    assert.deepEqual(antigravityToolCall('view_file', { AbsolutePath: '/a/b.ts' }), { tool: 'Read', input: { file_path: '/a/b.ts' } })
    assert.deepEqual(antigravityToolCall('write_to_file', { TargetFile: '/a/c.ts' }), { tool: 'Write', input: { file_path: '/a/c.ts' } })
    assert.deepEqual(antigravityToolCall('edit_file', { Path: '/a/d.ts' }), { tool: 'Edit', input: { file_path: '/a/d.ts' } })
    assert.deepEqual(antigravityToolCall('grep_search', '{"Query":"TODO"}'), { tool: 'Grep', input: { pattern: 'TODO' } })
    assert.deepEqual(antigravityToolCall('invoke_subagent', { Subagents: [{ Role: 'reviewer' }] }), { tool: 'Task', input: { description: 'reviewer' } })
  })

  test('认不出的工具原样留名、参数为空', () => {
    assert.deepEqual(antigravityToolCall('browser_click', { x: 1 }), { tool: 'browser_click', input: {} })
  })
})

describe('Antigravity transcript', () => {
  const home = join(TMP, 'gemini')
  const write = (app: string, id: string, steps: unknown[], mtime: number) => {
    const dir = join(home, app, 'brain', id, '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'transcript.jsonl')
    writeFileSync(file, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
    utimesSync(file, mtime, mtime)
  }

  before(() => rmSync(TMP, { recursive: true, force: true }))
  after(() => rmSync(TMP, { recursive: true, force: true }))

  test('最后一步决定状态', () => {
    assert.equal(observationOfSteps([{ type: 'USER_INPUT' }], 1)?.status.state, 'thinking')
    assert.equal(observationOfSteps([{ type: 'USER_INPUT' }, { type: 'PLANNER_RESPONSE' }], 1)?.status.state, 'done')
    const working = observationOfSteps([{ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: '/x/y.ts' } }] }], 1)
    assert.equal(working?.status.state, 'working')
    assert.match(working?.action?.text ?? '', /y\.ts/)
    assert.equal(observationOfSteps([{ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command' }] }, { type: 'TOOL_RESULT' }], 1)?.status.state, 'working')
    assert.equal(observationOfSteps([{ type: 'USER_INPUT' }, { type: 'SYSTEM_MESSAGE' }], 1), null)
    assert.equal(observationOfSteps([], 1), null)
  })

  test('Agent Manager 与 CLI 的 brain 都找；读不到的不返回', () => {
    write('antigravity', 'conv-app', [{ type: 'USER_INPUT' }, { type: 'PLANNER_RESPONSE' }], 1_700_000_000)
    write('antigravity-cli', 'conv-cli', [{ type: 'USER_INPUT' }], 1_700_000_100)
    const found = antigravityObservations(home, ['conv-app', 'conv-cli', 'missing', '../escape'])
    assert.equal(found.get('conv-app')?.status.state, 'done')
    assert.equal(found.get('conv-cli')?.status.state, 'thinking')
    assert.equal(found.has('missing'), false)
    assert.equal(found.has('../escape'), false)
  })

  test('标题取 history.jsonl 里第一句提示的第一行', () => {
    mkdirSync(join(home, 'antigravity-cli'), { recursive: true })
    writeFileSync(
      join(home, 'antigravity-cli', 'history.jsonl'),
      [
        JSON.stringify({ conversationId: 'conv-cli', display: 'Fix the login bug\nmore detail', timestamp: 1 }),
        JSON.stringify({ conversationId: 'conv-cli', display: 'second prompt', timestamp: 2 }),
        'not json',
      ].join('\n'),
    )
    const titles = antigravityTitles(home, ['conv-cli', 'conv-app'])
    assert.equal(titles.get('conv-cli'), 'Fix the login bug')
    assert.equal(titles.has('conv-app'), false)
  })
})

describe('Antigravity hooks.json', () => {
  const home = join(TMP, 'hook-home')
  const file = join(home, '.gemini', 'config', 'hooks.json')
  const others = {
    'safety-gate': {
      enabled: false,
      PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './scripts/safety-check.sh' }] }],
    },
  }

  before(() => rmSync(home, { recursive: true, force: true }))
  after(() => rmSync(home, { recursive: true, force: true }))

  test('只加 easy-flow 分组；装完再卸逐字还原别人的分组', () => {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    const original = JSON.stringify(others, null, 2) + '\n'
    writeFileSync(file, original)

    installHooks({ port: 3210, home })
    const installed = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(installed['safety-gate'], others['safety-gate'])
    const group = installed['easy-flow']
    assert.equal(group.enabled, true)
    assert.deepEqual(Object.keys(group).filter((k) => k !== 'enabled'), ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'])
    assert.equal(group.PreToolUse[0].matcher, '*')
    assert.match(group.PreToolUse[0].hooks[0].command, /\/api\/hook\?agent=antigravity&event=PreToolUse/)
    assert.match(group.Stop[0].command, /&event=Stop/)

    const plan = hookPlan({ port: 3210, home }).agents.find((a) => a.id === 'antigravity')
    assert.equal(plan?.installed, true)
    assert.equal(plan?.events, 6)

    // 再装一次不改文件
    assert.equal(installHooks({ port: 3210, home }).summary.length > 0, true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), installed)

    uninstallHooks({ home })
    assert.equal(readFileSync(file, 'utf8'), original)
  })

  test('PreToolUse 委托原有审批策略；其他事件是观察者，不重启 agent', () => {
    installHooks({ port: 3210, home })
    const group = JSON.parse(readFileSync(file, 'utf8'))['easy-flow']
    for (const [event, list] of Object.entries(group)) {
      if (event === 'enabled') continue
      const entry = (list as Array<Record<string, any>>)[0]
      const command: string = entry.command ?? entry.hooks[0].command
      if (event === 'PreToolUse') assert.match(command, /printf '\{"decision":"allow"\}'$/, event)
      else assert.match(command, /printf '\{\}'$/, event)
      assert.doesNotMatch(command, /force_allow|continue/, event)
    }
    uninstallHooks({ home })
  })

  test('同名分组不是我们写的：装就拒改，卸就跳过', () => {
    const mine = { 'easy-flow': { Stop: [{ type: 'command', command: './my-own-script.sh' }] } }
    const text = JSON.stringify(mine, null, 2) + '\n'
    writeFileSync(file, text)
    assert.throws(() => installHooks({ port: 3210, home }), /(?:did not write|不是 easy-flow 写的)/)
    uninstallHooks({ home })
    assert.equal(readFileSync(file, 'utf8'), text)
  })
})

describe('Antigravity 启动与展示', () => {
  test('provider: keep the workspace in the handoff, copy the prompt and focus the App', async () => {
    assert.equal(antigravityProvider.id, 'antigravity')
    assert.equal(antigravityProvider.requiresWorktree, true)
    assert.equal(antigravityProvider.copyPromptBeforeOpen, true)
    assert.equal(typeof antigravityProvider.open, 'function')
    assert.equal(await antigravityProvider.build({
      agent: 'antigravity',
      requirementId: 'req-demo',
      worktreeId: 'wt-demo',
      worktreePath: '/Users/groos/repo/demo.feature-x',
      requirementWorktreePaths: ['/Users/groos/repo/demo.feature-x'],
    }, 'prompt'), '')
    assert.deepEqual(antigravityOpenArgs('/Users/groos/repo/demo.feature-x'), ['-a', 'Antigravity'])
  })

  test('显示名与打开工作区', () => {
    assert.equal(agentLabel('antigravity'), 'Antigravity')
    assert.equal(workspaceAppOf('antigravity'), 'Antigravity')
    assert.equal(canOpenWorkspace({ agent: 'antigravity', cwd: '/repo' }), true)
    assert.equal(canOpenWorkspace({ agent: 'antigravity', cwd: '' }), true)
    assert.equal(canOpenWorkspace({ agent: 'codex', cwd: '/repo' }), false)
  })
})
