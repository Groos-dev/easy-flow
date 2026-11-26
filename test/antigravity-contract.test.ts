import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { antigravityNeedsInput, antigravityObservations, antigravityTitles, antigravityToolCall, observationOfSteps } from '../server/antigravity.ts'
import { normalizeAntigravityPayload, normalizeHookEvent, recordHook } from '../server/hook.ts'
import { SessionStateStore, type SessionObservation } from '../server/session-state.ts'
import { hookPlan, installHooks, uninstallHooks } from '../server/hook-install.ts'

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'easy-flow-agy-contract-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test('Antigravity Stop does not report completion while background work remains', () => {
  const payload = normalizeAntigravityPayload({
    conversationId: 'conversation', hookEventName: 'Stop', terminationReason: 'model_stop', fullyIdle: false,
  })
  assert.equal(normalizeHookEvent(payload)?.state, 'working')
})

test('Antigravity cancellation spelling is normalized without treating it as success', () => {
  const payload = normalizeAntigravityPayload({
    conversationId: 'conversation', hookEventName: 'Stop', terminationReason: 'user_cancelled', fullyIdle: true,
  })
  assert.equal(normalizeHookEvent(payload)?.state, 'blocked')
})

test('Official permission and question tools surface blocked state and the actual request', () => {
  for (const [name, args, question] of [
    ['ask_question', { questions: [{ question: 'Which environment?', options: ['Local', 'Test'] }] }, 'Which environment?'],
    ['ask_permission', { Action: 'read_file', Target: '/fixture', Reason: 'May I read the repository?' }, 'May I read the repository?'],
  ] as const) {
    const payload = normalizeAntigravityPayload({ conversationId: 'conversation', hookEventName: 'PreToolUse', toolCall: { name, args } })
    const status = normalizeHookEvent(payload)
    assert.equal(status?.state, 'blocked')
    assert.equal(status.needsAction, question)
    const pulled = observationOfSteps([{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name, args }] }], 100)
    assert.equal(pulled?.status.state, 'blocked')
    assert.equal(pulled.status.needsAction, question)
  }
})

test('Native per-step status distinguishes streaming responses and failed model calls', () => {
  assert.equal(observationOfSteps([{ type: 'PLANNER_RESPONSE', status: 'RUNNING' }], 100)?.status.state, 'thinking')
  assert.equal(observationOfSteps([{ type: 'PLANNER_RESPONSE', status: 'ERROR' }], 100)?.status.state, 'failed')
  assert.equal(observationOfSteps([{ type: 'ERROR_MESSAGE', status: 'ERROR' }], 100)?.status.state, 'failed')
})

test('Unknown tool names cannot resolve inherited object properties', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(antigravityToolCall(name, {}), { tool: name, input: {} })
  }
  assert.deepEqual(antigravityToolCall('mcp_test_read', {}), { tool: 'CallMcpTool', input: { toolName: 'mcp_test_read' } })
})

test('Native SQLite conversation titles are recovered after restarting easy-flow', (t) => {
  const home = fixture(t)
  const app = join(home, 'antigravity')
  mkdirSync(app)
  const db = new DatabaseSync(join(app, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('conversation', 'Native sidebar title', 'Earlier preview')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run('preview-only', '', 'Native preview title\nMore content')
  db.close()
  assert.equal(antigravityTitles(home, ['conversation']).get('conversation'), 'Native sidebar title')
  assert.equal(antigravityTitles(home, ['preview-only']).get('preview-only'), 'Native preview title')
})

test('Rewriting a transcript cannot make an old observation newer than a hook', (t) => {
  const home = fixture(t)
  const logs = join(home, 'antigravity', 'brain', 'conversation', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const path = join(logs, 'transcript.jsonl')
  const created = '2026-11-22T10:00:00Z'
  writeFileSync(path, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: created, content: 'Complete.' }) + '\n')
  utimesSync(path, new Date('2026-11-22T12:00:00Z'), new Date('2026-11-22T12:00:00Z'))
  assert.equal(antigravityObservations(home, ['conversation']).get('conversation')?.status.observedAt, Date.parse(created))
})

test('An available full transcript provides recovery when the rolling transcript is absent', (t) => {
  const home = fixture(t)
  const logs = join(home, 'antigravity', 'brain', 'conversation', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'transcript_full.jsonl'), JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:00Z', content: 'Complete.' }) + '\n')
  assert.equal(antigravityObservations(home, ['conversation']).get('conversation')?.status.state, 'done')
})

test('Reinstalling and uninstalling preserves user handlers within the easy-flow hook group', (t) => {
  const home = fixture(t)
  installHooks({ home, port: 29170 })
  const file = join(home, '.gemini', 'config', 'hooks.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const foreign = { command: 'printf "{}" # user hook', timeout: 7 }
  config['easy-flow'].description = 'User-maintained metadata'
  config['easy-flow'].PostInvocation.push(foreign)
  config['easy-flow'].PreToolUse[0].hooks.push(foreign)
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  installHooks({ home, port: 29171 })
  const reinstalled = JSON.parse(readFileSync(file, 'utf8'))['easy-flow']
  assert.equal(reinstalled.description, 'User-maintained metadata')
  assert.ok(reinstalled.PostInvocation.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify(foreign)))
  assert.ok(reinstalled.PreToolUse.some((entry: { hooks: unknown[] }) => entry.hooks.some(hook => JSON.stringify(hook) === JSON.stringify(foreign))))
  uninstallHooks({ home })
  const remaining = JSON.parse(readFileSync(file, 'utf8'))['easy-flow']
  assert.equal(remaining.description, 'User-maintained metadata')
  assert.deepEqual(remaining.PostInvocation, [foreign])
  assert.deepEqual(remaining.PreToolUse[0].hooks, [foreign])
  assert.doesNotMatch(JSON.stringify(remaining), /\/api\/hook/)
  assert.equal(hookPlan({ home, port: 29171 }).agents.find(agent => agent.id === 'antigravity')?.installed, false)
  installHooks({ home, port: 29172 })
  const installedAgain = JSON.parse(readFileSync(file, 'utf8'))['easy-flow']
  assert.ok(installedAgain.PostInvocation.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify(foreign)))
  uninstallHooks({ home })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['easy-flow'], remaining)
})

test('Native summaries recover running, background, empty, finished and cancelled sessions', (t) => {
  const home = fixture(t)
  const app = join(home, 'antigravity')
  mkdirSync(app)
  const db = new DatabaseSync(join(app, 'conversation_summaries.db'))
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, status TEXT, last_modified_time TEXT,
    last_user_input_time TEXT, not_fully_idle INTEGER, killed INTEGER, step_count INTEGER,
    last_user_input_step_index INTEGER)`)
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const at = '2026-11-22 10:00:00.123456+00:00'
  insert.run('running', 'CASCADE_RUN_STATUS_RUNNING', at, at, 0, 0, 2, -1)
  insert.run('background', 'CASCADE_RUN_STATUS_IDLE', at, at, 1, 0, 2, -1)
  insert.run('empty', 'CASCADE_RUN_STATUS_IDLE', at, at, 0, 0, 0, -1)
  insert.run('finished', 'CASCADE_RUN_STATUS_IDLE', at, at, 0, 0, 2, -1)
  insert.run('cancelled', 'CASCADE_RUN_STATUS_IDLE', at, at, 0, 1, 2, -1)
  insert.run('unknown', 'A_FUTURE_NATIVE_STATE', at, at, 0, 0, 2, -1)
  db.close()
  const found = antigravityObservations(home, ['running', 'background', 'empty', 'finished', 'cancelled', 'unknown'])
  assert.equal(found.get('running')?.status.state, 'thinking')
  assert.equal(found.get('background')?.status.state, 'working')
  assert.equal(found.get('empty')?.status.state, 'idle')
  assert.equal(found.get('finished')?.status.state, 'done')
  assert.equal(found.get('cancelled')?.status.state, 'blocked')
  assert.equal(found.has('unknown'), false)
  assert.equal(found.get('finished')?.status.observedAt, Date.parse('2026-11-22T10:00:00.123Z'))
})

test('A disabled or partial Antigravity group is not reported as fully installed', (t) => {
  const home = fixture(t)
  installHooks({ home, port: 29170 })
  const file = join(home, '.gemini/config/hooks.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  config['easy-flow'].enabled = false
  writeFileSync(file, JSON.stringify(config))
  assert.equal(hookPlan({ home, port: 29170 }).agents.find(agent => agent.id === 'antigravity')?.installed, false)
  config['easy-flow'].enabled = true
  delete config['easy-flow'].Stop
  writeFileSync(file, JSON.stringify(config))
  const plan = hookPlan({ home, port: 29170 }).agents.find(agent => agent.id === 'antigravity')
  assert.equal(plan?.installed, false)
  assert.equal(plan?.events, 5)
  assert.ok(plan?.problem)
})

test('Foreign similarly named hook URLs and metadata survive removal of owned commands', (t) => {
  const home = fixture(t)
  installHooks({ home, port: 29170 })
  const file = join(home, '.gemini/config/hooks.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const foreign = { command: 'curl http://localhost:3000/api/hook?agent=another-system' }
  config['easy-flow'].Stop.push(foreign)
  config['easy-flow'].examples = [{ command: 'curl http://127.0.0.1:29170/api/hook?agent=antigravity' }]
  writeFileSync(file, JSON.stringify(config))
  uninstallHooks({ home })
  const remaining = JSON.parse(readFileSync(file, 'utf8'))['easy-flow']
  assert.deepEqual(remaining.Stop, [foreign])
  assert.deepEqual(remaining.examples, config['easy-flow'].examples)
})

test('A former namespace proof cannot authorize replacing a new foreign group', (t) => {
  const home = fixture(t)
  installHooks({ home, port: 29170 })
  const file = join(home, '.gemini/config/hooks.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  config['easy-flow'].Stop.push({ command: './retained-user-hook.sh' })
  writeFileSync(file, JSON.stringify(config))
  uninstallHooks({ home })
  const replacement = { 'easy-flow': { Stop: [{ command: './new-independent-user-hook.sh' }] } }
  const bytes = JSON.stringify(replacement, null, 2) + '\n'
  writeFileSync(file, bytes)
  assert.throws(() => installHooks({ home, port: 29170 }), /did not write|不是 easy-flow/)
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.equal(antigravityNeedsInput('run_command', { BypassSandbox: true, CommandLine: 'echo fixture' }), null)
})

test('A partial write does not reuse an earlier completed turn', (t) => {
  const home = fixture(t)
  const logs = join(home, 'antigravity', 'brain', 'conversation', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const path = join(logs, 'transcript.jsonl')
  const complete = JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:00Z' }) + '\n'
  writeFileSync(path, complete)
  assert.equal(antigravityObservations(home, ['conversation']).get('conversation')?.status.state, 'done')
  writeFileSync(path, complete + '{"step_index":2,"type":"USER_INPUT"')
  assert.equal(antigravityObservations(home, ['conversation']).has('conversation'), false)
})

test('A previous-turn question cannot replace a newer thinking hook during checkpoint delay', (t) => {
  const home = fixture(t)
  const app = join(home, 'antigravity')
  const logs = join(app, 'brain/conversation/.system_generated/logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'transcript.jsonl'), JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:00Z', tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'An old answered question?' }] } }] }) + '\n')
  const db = new DatabaseSync(join(app, 'conversation_summaries.db'))
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, status TEXT, last_modified_time TEXT,
    last_user_input_time TEXT, last_user_input_step_index INTEGER, not_fully_idle INTEGER, killed INTEGER, step_count INTEGER)`)
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('conversation', 'CASCADE_RUN_STATUS_RUNNING', '2026-11-22T10:02:00Z', '2026-11-22T10:01:00.123Z', 3, 0, 0, 4)
  db.close()
  const table = new Map<string, SessionObservation>()
  const store = new SessionStateStore({
    list: () => [...table].map(([session, observation]) => ({ agent: 'antigravity', session, observation })),
    keys: () => [], get: (_agent, session) => table.get(session),
    put: (_agent, session, observation) => { table.set(session, observation) },
    drop: (_agent, session) => table.delete(session), keyOf: (_agent, session) => session, alias: () => {},
  })
  recordHook({ conversationId: 'conversation', hookEventName: 'PreInvocation' }, { agent: 'antigravity', at: Date.parse('2026-11-22T10:01:30Z') }, store)
  const recovered = antigravityObservations(home, ['conversation']).get('conversation')!
  store.put('antigravity', 'conversation', recovered.status, recovered.action)
  assert.equal(store.get('antigravity', 'conversation')?.status.state, 'thinking')
  assert.equal(store.get('antigravity', 'conversation')?.status.needsAction, '')
  assert.equal(recovered.action, null)
})

test('Native step indices retain a current-turn question despite second-resolution log timestamps', (t) => {
  const home = fixture(t)
  const app = join(home, 'antigravity')
  const logs = join(app, 'brain/conversation/.system_generated/logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'transcript.jsonl'), JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:01:00Z', tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'A current question?' }] } }] }) + '\n')
  const db = new DatabaseSync(join(app, 'conversation_summaries.db'))
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, status TEXT, last_modified_time TEXT,
    last_user_input_time TEXT, last_user_input_step_index INTEGER, not_fully_idle INTEGER, killed INTEGER, step_count INTEGER)`)
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('conversation', 'CASCADE_RUN_STATUS_RUNNING', '2026-11-22T10:01:01Z', '2026-11-22T10:01:00.123Z', 3, 0, 0, 5)
  db.close()
  const recovered = antigravityObservations(home, ['conversation']).get('conversation')!
  assert.equal(recovered.status.state, 'blocked')
  assert.equal(recovered.status.needsAction, 'A current question?')
})

test('Rolling/full transcript choice uses native sequence before checkpoint file times', (t) => {
  const home = fixture(t)
  const logs = join(home, 'antigravity', 'brain', 'conversation', '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  const rolling = join(logs, 'transcript.jsonl')
  const full = join(logs, 'transcript_full.jsonl')
  writeFileSync(rolling, JSON.stringify({ step_index: 4, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T10:00:00Z' }) + '\n')
  writeFileSync(full, JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:01Z' }) + '\n')
  utimesSync(rolling, new Date('2026-11-22T12:00:00Z'), new Date('2026-11-22T12:00:00Z'))
  assert.equal(antigravityObservations(home, ['conversation']).get('conversation')?.status.state, 'done')
})

test('Generated Antigravity commands forward the official payload and remain valid offline', async (t) => {
  const home = fixture(t)
  const received: Array<{ event: string | null; agent: string | null; body: unknown }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      received.push({ event: url.searchParams.get('event'), agent: url.searchParams.get('agent'), body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  installHooks({ home, port: address.port })
  const group = JSON.parse(readFileSync(join(home, '.gemini/config/hooks.json'), 'utf8'))['easy-flow']
  const payload = { conversationId: 'fixture-conversation', workspacePaths: ['/fixture'], fullyIdle: false, toolCall: { name: 'read_file', args: { Path: '/fixture/a.ts' } } }
  const run = (command: string) => new Promise<string>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', data => { stdout += data.toString() })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Hook exited ${code}`)))
    child.stdin.end(JSON.stringify(payload))
  })
  const commands: string[] = []
  for (const [event, entries] of Object.entries(group)) {
    if (!Array.isArray(entries)) continue
    const command = entries[0].command ?? entries[0].hooks[0].command
    commands.push(command)
    assert.deepEqual(JSON.parse(await run(command)), event === 'PreToolUse' ? { decision: 'allow' } : {})
    assert.deepEqual(received.at(-1), { event, agent: 'antigravity', body: payload })
  }
  assert.equal(received.length, 6)
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.deepEqual(JSON.parse(await run(commands[0])), {})
})
