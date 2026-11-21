import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { BoardDatabase } from '../server/db.ts'
import { createProjectDir, createRequirementDir } from '../server/convention.ts'
import { parseFrontmatter } from '../server/markdown.ts'
import { AppServer } from '../server/codex.ts'
import { reviewWorktree } from '../server/review.ts'

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-review-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const main = join(dir, 'main repo')
  const worktree = join(dir, 'coding repo')
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AI_SKIP_ALL_HOOKS: '1' }
  mkdirSync(main)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (cwd: string) => {
    git(cwd, 'add', '.')
    git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture')
  }
  git(main, 'init', '-b', 'main')
  writeFileSync(join(main, 'app.ts'), 'export const value = 1\n')
  commit(main)
  const base = git(main, 'rev-parse', 'HEAD')
  git(main, 'worktree', 'add', '-b', 'coding', worktree)
  writeFileSync(join(worktree, 'app.ts'), 'export const value = 2\n')
  commit(worktree)
  writeFileSync(join(worktree, 'app.ts'), 'export const value = 3\n')
  git(worktree, 'add', 'app.ts')
  writeFileSync(join(worktree, 'app.ts'), 'export const value = 4\n')
  writeFileSync(join(worktree, 'new file.ts'), 'export const added = true\n')

  const data = join(dir, 'data')
  createProjectDir(data, 'p', '项目')
  const req = createRequirementDir(join(data, 'p'), 'alpha', '实现业务能力', '已确认的需求')
  writeFileSync(join(data, 'p', 'AGENTS.md'), '# 项目规范\n\n遵循现有调用链。\n')
  writeFileSync(join(req.dir, 'context.md'), '## 决策\n\n保留现有对外契约。\n')
  mkdirSync(join(req.dir, 'docs'), { recursive: true })
  writeFileSync(join(req.dir, 'docs', 'design.md'), '# 设计\n\n需要验证真实调用方。\n')
  const db = new BoardDatabase(data)
  db.syncProjects()
  db.addWorktree({ id: 'wt-test', requirementId: req.id, repo: 'demo', short: 'demo', branch: 'coding', path: worktree, main })
  db.setLinks('alpha', [{ title: '设计', url: 'https://example.com/design' }], 'p')
  db.close()
  const config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ dataDir: data }))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
  const capture = join(dir, 'capture.json')
  const stateFile = join(dir, 'codex-state.json')
  const releaseFile = join(dir, 'release-review')
  const shell = join(bin, 'login-shell')
  writeFileSync(shell, '#!/bin/sh\nif [ "$2" = "command -v codex" ]; then command -v codex; else shift 2; exec "$@"; fi\n')
  chmodSync(shell, 0o755)
  const codex = join(bin, 'codex')
  writeFileSync(codex, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const capture = { args }
const stateFile = process.env.REVIEW_TEST_STATE
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { created: 0, sessions: [] }
let threadId = ''
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') return send({ id, result: {} })
  if (method === 'thread/start') {
    capture.start = params
    threadId = 'review-session-' + ++state.created
    state.sessions.push(threadId)
    fs.writeFileSync(stateFile, JSON.stringify(state))
    if (process.env.REVIEW_TEST_MODE === 'start-uncertain') return send({ id, error: { message: 'creation response lost' } })
    return send({ id, result: { thread: { id: threadId, source: 'vscode', cwd: params.cwd } } })
  }
  if (method === 'thread/resume') {
    capture.resume = params
    threadId = params.threadId
    if (process.env.REVIEW_TEST_MODE === 'resume-fail' || !state.sessions.includes(threadId)) return send({ id, error: { message: 'session unavailable' } })
    if (process.env.REVIEW_TEST_MODE === 'resume-other') threadId = 'unexpected-session'
    return send({ id, result: { thread: { id: threadId, source: 'vscode', cwd: params.cwd } } })
  }
  if (method === 'thread/name/set') {
    capture.name = params.name
    return send({ id, result: {} })
  }
  if (method !== 'turn/start') return
  capture.prompt = params.input[0].text
  fs.writeFileSync(process.env.REVIEW_TEST_CAPTURE, JSON.stringify(capture))
  send({ id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
  const finish = () => {
    if (process.env.REVIEW_TEST_MODE === 'slow' && !fs.existsSync(process.env.REVIEW_TEST_RELEASE)) {
      setTimeout(finish, 10)
      return
    }
    if (process.env.REVIEW_TEST_MODE === 'fail') {
      process.stderr.write('provider unavailable')
      process.exit(7)
    }
    send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', phase: 'commentary', text: '评审中' } } })
    if (process.env.REVIEW_TEST_MODE !== 'empty') send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', phase: 'final_answer', text: '## 评审结论\\n\\n### F-1 [high] 契约遗漏\\n- 位置：app.ts:1\\n- 证据：实现与验收不符。\\n- 影响：调用方行为变化。\\n- 改法：补齐契约。\\n' } } })
    send({ method: 'turn/completed', params: { threadId, turn: { status: process.env.REVIEW_TEST_MODE === 'failed-turn' ? 'failed' : 'completed', error: { message: 'provider unavailable' } } } })
  }
  setTimeout(finish, 5)
})
`)
  chmodSync(codex, 0o755)
  const cliArgs = ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'server/cli.ts')]
  const cliOptions = (mode: string) => ({
      cwd: worktree,
      env: { ...gitEnv, PATH: bin, SHELL: shell, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.test.json'), EASY_FLOW_CONFIG: config, REVIEW_TEST_CAPTURE: capture, REVIEW_TEST_STATE: stateFile, REVIEW_TEST_RELEASE: releaseFile, REVIEW_TEST_MODE: mode },
      encoding: 'utf8' as const,
      timeout: 20_000,
  })
  const cli = (args: string[], mode = '') => spawnSync(
    process.execPath, [...cliArgs, ...args], cliOptions(mode),
  )
  const startCli = (args: string[], mode = '') => spawn(
    process.execPath, [...cliArgs, ...args], cliOptions(mode),
  )
  return { dir, data, req, base, main, worktree, git, commit, cli, startCli, capture, codex, stateFile, releaseFile }
}

test('评审通过真实 CLI 带入需求、文档和完整改动范围，报告与会话挂回需求', (t) => {
  const f = fixture(t)
  const result = f.cli(['review', 'wt-test', '--model', 'review-model', '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.sessionId, 'review-session-1')
  assert.equal(output.reportPath, join(f.req.dir, 'docs/review/01-review.md'))
  const report = readFileSync(output.reportPath, 'utf8')
  assert.equal(parseFrontmatter(report).data.status, 'completed')
  assert.equal(parseFrontmatter(report).data.base, f.base)
  assert.match(report, /F-1 \[high\]/)
  assert.match(report, /处理结果/)
  assert.match(readFileSync(output.logPath, 'utf8'), /turn\/completed/)
  const { args, prompt, start, name } = JSON.parse(readFileSync(f.capture, 'utf8'))
  assert.equal(args[0], 'app-server')
  assert.equal(start.sandbox, 'read-only')
  assert.equal(start.approvalPolicy, 'never')
  assert.equal(start.ephemeral, false)
  assert.equal(start.model, 'review-model')
  assert.equal(start.cwd, f.worktree)
  assert.deepEqual(start.runtimeWorkspaceRoots, [f.worktree])
  assert.match(name, /评审.*实现业务能力/)
  for (const expected of [f.req.id, '已确认的需求', '保留现有对外契约', '项目规范', 'docs/design.md', 'https://example.com/design', f.base, 'new file.ts', 'app.ts']) {
    assert.ok(prompt.includes(expected), expected)
  }
  assert.match(prompt, /self-codereview/)
  const db = new BoardDatabase(f.data)
  assert.equal(db.listSessions(f.req.id)[0].session, 'review-session-1')
  assert.equal(db.byId(f.req.id)?.status, 'clarification')
  db.syncProjects()
  assert.ok(db.byId(f.req.id)?.docs.some((doc) => doc.name === 'docs/review/01-review.md'))
  db.close()
})

test('连续复查复用首次评审会话，保留报告、基线与处理记录', (t) => {
  const f = fixture(t)
  const first = f.cli(['review', 'wt-test', '--json'])
  assert.equal(first.status, 0, first.stderr || first.stdout)
  const original = JSON.parse(first.stdout).reportPath
  const handled = `${readFileSync(original, 'utf8')}\nF-1：已修复，pnpm test 通过。\n`
  writeFileSync(original, handled)
  writeFileSync(join(f.main, 'later.ts'), 'export const later = true\n')
  f.commit(f.main)
  const second = f.cli(['review', 'wt-test', '--recheck', original, '--json'])
  assert.equal(second.status, 0, second.stderr || second.stdout)
  const output = JSON.parse(second.stdout)
  assert.equal(output.sessionId, JSON.parse(first.stdout).sessionId)
  assert.equal(output.reportPath, join(f.req.dir, 'docs/review/02-recheck.md'))
  assert.equal(parseFrontmatter(readFileSync(output.reportPath, 'utf8')).data.base, f.base)
  assert.equal(readFileSync(original, 'utf8'), handled)
  assert.match(JSON.parse(readFileSync(f.capture, 'utf8')).prompt, /F-1：已修复/)
  const third = f.cli(['review', 'wt-test', '--recheck', output.reportPath, '--json'])
  assert.equal(third.status, 0, third.stderr || third.stdout)
  assert.equal(JSON.parse(third.stdout).sessionId, output.sessionId)
  const capture = JSON.parse(readFileSync(f.capture, 'utf8'))
  assert.equal(capture.start, undefined)
  assert.equal(capture.resume.threadId, output.sessionId)
  assert.equal(capture.resume.cwd, f.worktree)
  assert.deepEqual(capture.resume.runtimeWorkspaceRoots, [f.worktree])
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
  const db = new BoardDatabase(f.data)
  assert.equal(db.listSessions(f.req.id).length, 1)
  db.close()
})

test('缺少会话或恢复失败时终止复查并保留原会话标识', (t) => {
  const f = fixture(t)
  const first = f.cli(['review', 'wt-test', '--json'])
  assert.equal(first.status, 0, first.stderr || first.stdout)
  const { reportPath, sessionId } = JSON.parse(first.stdout)
  const failed = f.cli(['review', 'wt-test', '--recheck', reportPath, '--json'], 'resume-fail')
  assert.equal(failed.status, 1)
  const result = JSON.parse(failed.stdout)
  assert.match(result.error, /session unavailable/)
  assert.equal(result.sessionId, sessionId)
  assert.equal(parseFrontmatter(readFileSync(result.reportPath, 'utf8')).data.status, 'failed')
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
  writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace(`session: ${sessionId}`, 'session: '))
  assert.equal(f.cli(['review', 'wt-test', '--recheck', reportPath, '--json']).status, 1)
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
})

test('显式基线和复查基线即使不是 HEAD 的祖先也保持原值', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.main, 'later.ts'), 'export const later = true\n')
  f.commit(f.main)
  const selected = f.git(f.main, 'rev-parse', 'HEAD')
  const first = f.cli(['review', 'wt-test', '--base', selected, '--json'])
  assert.equal(first.status, 0, first.stderr || first.stdout)
  const original = JSON.parse(first.stdout).reportPath
  assert.equal(parseFrontmatter(readFileSync(original, 'utf8')).data.base, selected)
  const second = f.cli(['review', 'wt-test', '--recheck', original, '--json'])
  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.equal(parseFrontmatter(readFileSync(JSON.parse(second.stdout).reportPath, 'utf8')).data.base, selected)
})

test('普通 review 重复调用、换基线与换模型始终复用绑定的会话', (t) => {
  const f = fixture(t)
  const first = f.cli(['review', 'wt-test', '--json'])
  assert.equal(first.status, 0, first.stdout || first.stderr)
  const sessionId = JSON.parse(first.stdout).sessionId
  writeFileSync(join(f.main, 'later.ts'), 'export const later = true\n')
  f.commit(f.main)
  const selected = f.git(f.main, 'rev-parse', 'HEAD')
  for (const args of [[], ['--base', selected], ['--base', f.base, '--model', 'another-model']]) {
    const result = f.cli(['review', 'wt-test', ...args, '--json'])
    assert.equal(result.status, 0, result.stdout || result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.sessionId, sessionId)
    assert.equal(parseFrontmatter(readFileSync(output.reportPath, 'utf8')).data.session, sessionId)
  }
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
  const db = new BoardDatabase(f.data)
  assert.equal(db.reviewSession(f.req.id, 'wt-test'), sessionId)
  assert.throws(() => db.bindReviewSession(f.req.id, 'wt-test', 'another-session'), /(?:already bound|已绑定)/)
  assert.equal(db.reviewSession(f.req.id, 'wt-test'), sessionId)
  assert.equal(db.listSessions(f.req.id).length, 1)
  db.removeWorktree('wt-test')
  assert.equal(db.reviewSession(f.req.id, 'wt-test'), undefined)
  db.close()
})

test('首轮失败后普通 review 换模型重试和失败报告复核都沿用原会话', (t) => {
  const f = fixture(t)
  const failed = f.cli(['review', 'wt-test', '--json'], 'failed-turn')
  assert.equal(failed.status, 1)
  const first = JSON.parse(failed.stdout)
  const rechecked = f.cli(['review', 'wt-test', '--recheck', first.reportPath, '--model', 'supported-model', '--json'])
  assert.equal(rechecked.status, 0, rechecked.stdout || rechecked.stderr)
  assert.equal(JSON.parse(rechecked.stdout).sessionId, first.sessionId)
  const retried = f.cli(['review', 'wt-test', '--model', 'another-model', '--json'])
  assert.equal(retried.status, 0, retried.stdout || retried.stderr)
  assert.equal(JSON.parse(retried.stdout).sessionId, first.sessionId)
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
})

test('普通 review 恢复失败保留绑定，下一次仍恢复同一会话', (t) => {
  const f = fixture(t)
  const first = f.cli(['review', 'wt-test', '--json'])
  assert.equal(first.status, 0, first.stdout || first.stderr)
  const sessionId = JSON.parse(first.stdout).sessionId
  const failed = f.cli(['review', 'wt-test', '--json'], 'resume-fail')
  assert.equal(failed.status, 1)
  assert.equal(JSON.parse(failed.stdout).sessionId, sessionId)
  assert.match(JSON.parse(failed.stdout).error, /session unavailable/)
  const retried = f.cli(['review', 'wt-test', '--json'])
  assert.equal(retried.status, 0, retried.stdout || retried.stderr)
  assert.equal(JSON.parse(retried.stdout).sessionId, sessionId)
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
})

test('恢复响应的 session 与绑定不一致时终止执行', (t) => {
  const f = fixture(t)
  const first = f.cli(['review', 'wt-test', '--json'])
  assert.equal(first.status, 0, first.stdout || first.stderr)
  const sessionId = JSON.parse(first.stdout).sessionId
  const failed = f.cli(['review', 'wt-test', '--json'], 'resume-other')
  assert.equal(failed.status, 1, failed.stdout || failed.stderr)
  assert.equal(JSON.parse(failed.stdout).sessionId, sessionId)
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
})

test('旧工作区认领最近的历史 reviewer，旧报告和后续报告都不能改变绑定', (t) => {
  const f = fixture(t)
  const reviewDir = join(f.req.dir, 'docs/review')
  mkdirSync(reviewDir)
  const sessions = Array.from({ length: 6 }, (_, i) => `legacy-${i + 1}`)
  writeFileSync(f.stateFile, JSON.stringify({ created: 6, sessions }))
  for (const [i, session] of sessions.entries()) {
    writeFileSync(join(reviewDir, `${String(i + 1).padStart(2, '0')}-review.md`), `---\nrequirement: ${f.req.id}\nworktree: wt-test\nbase: ${f.base}\nstatus: completed\nsession: ${session}\n---\n# 评审\n`)
  }
  const adopted = f.cli(['review', 'wt-test', '--json'])
  assert.equal(adopted.status, 0, adopted.stdout || adopted.stderr)
  assert.equal(JSON.parse(adopted.stdout).sessionId, 'legacy-6')
  const latestReport = JSON.parse(adopted.stdout).reportPath
  writeFileSync(latestReport, readFileSync(latestReport, 'utf8').replace('session: legacy-6', 'session: legacy-1'))
  const rechecked = f.cli(['review', 'wt-test', '--recheck', join(reviewDir, '01-review.md'), '--json'])
  assert.equal(rechecked.status, 0, rechecked.stdout || rechecked.stderr)
  assert.equal(JSON.parse(rechecked.stdout).sessionId, 'legacy-6')
  const retried = f.cli(['review', 'wt-test', '--json'])
  assert.equal(retried.status, 0, retried.stdout || retried.stderr)
  assert.equal(JSON.parse(retried.stdout).sessionId, 'legacy-6')
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 6)
})

test('已有报告却无法确定原会话时停止，工作区占用也不会创建新会话', (t) => {
  const f = fixture(t)
  const reviewDir = join(f.req.dir, 'docs/review')
  mkdirSync(reviewDir)
  writeFileSync(join(reviewDir, '01-review.md'), `---\nrequirement: ${f.req.id}\nworktree: wt-test\nbase: ${f.base}\nstatus: failed\nsession: \n---\n`)
  assert.equal(f.cli(['review', 'wt-test', '--json']).status, 1)
  assert.equal(existsSync(f.stateFile), false)
  rmSync(join(reviewDir, '01-review.md'))
  writeFileSync(join(reviewDir, '.wt-test.lock'), `${process.pid}\n`)
  assert.equal(f.cli(['review', 'wt-test', '--json']).status, 1)
  assert.equal(existsSync(f.stateFile), false)
})

test('并发首次 review 只有一个调用能够创建 reviewer', async (t) => {
  const f = fixture(t)
  const child = f.startCli(['review', 'wt-test', '--json'], 'slow')
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  const completed = new Promise<number | null>((resolve) => child.once('close', resolve))
  try {
    for (let i = 0; i < 500 && !existsSync(f.stateFile); i++) await setTimeout(20)
    assert.ok(existsSync(f.stateFile))
    const second = f.cli(['review', 'wt-test', '--json'])
    assert.equal(second.status, 1, second.stdout || second.stderr)
    writeFileSync(f.releaseFile, '')
    assert.equal(await completed, 0, output)
    assert.equal(JSON.parse(output).sessionId, 'review-session-1')
    assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
  } finally {
    writeFileSync(f.releaseFile, '')
    child.kill()
  }
})

test('初次连接失败且尚未请求创建时，修复环境后只创建一次 reviewer', (t) => {
  const f = fixture(t)
  const executable = readFileSync(f.codex)
  rmSync(f.codex)
  const failed = f.cli(['review', 'wt-test', '--json'])
  assert.equal(failed.status, 1)
  assert.equal(JSON.parse(failed.stdout).sessionId, '')
  assert.equal(existsSync(f.stateFile), false)
  writeFileSync(f.codex, executable)
  chmodSync(f.codex, 0o755)
  const retried = f.cli(['review', 'wt-test', '--json'])
  assert.equal(retried.status, 0, retried.stdout || retried.stderr)
  assert.equal(JSON.parse(retried.stdout).sessionId, 'review-session-1')
  const again = f.cli(['review', 'wt-test', '--model', 'another-model', '--json'])
  assert.equal(again.status, 0, again.stdout || again.stderr)
  assert.equal(JSON.parse(again.stdout).sessionId, 'review-session-1')
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
})

test('创建响应丢失后保持停止，避免重复创建 reviewer', (t) => {
  const f = fixture(t)
  const failed = f.cli(['review', 'wt-test', '--json'], 'start-uncertain')
  assert.equal(failed.status, 1)
  assert.match(JSON.parse(failed.stdout).error, /creation response lost/)
  const retried = f.cli(['review', 'wt-test', '--json'])
  assert.equal(retried.status, 1)
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).created, 1)
})

test('同一需求的不同工作区并发时，各自保存完整报告', async (t) => {
  const f = fixture(t)
  const otherPath = join(f.dir, 'other repo')
  f.git(f.main, 'worktree', 'add', '-b', 'other', otherPath)
  const db = new BoardDatabase(f.data)
  const first = db.worktreeById('wt-test')!
  const second = db.addWorktree({ ...first, id: 'wt-other', branch: 'other', path: otherPath })
  let nextId = 0
  let waiting = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(AppServer, 'start', async () => {
    const session = `parallel-${++nextId}`
    return {
      async call(method: string) { return method === 'thread/start' ? { thread: { id: session } } : {} },
      async runTurn() {
        if (++waiting === 2) release()
        await ready
        return `## 评审结论\n\n${session}`
      },
      close() {},
    } as unknown as AppServer
  })
  try {
    const results = await Promise.all([first, second].map((worktree) => reviewWorktree({
      worktree, requirementPath: f.req.dir, context: '需求上下文', title: '并发评审',
      getSession: () => db.reviewSession(f.req.id, worktree.id),
      onSessionResolved: (session) => db.bindReviewSession(f.req.id, worktree.id, session),
    })))
    assert.ok(results.every((result) => result.ok))
    assert.notEqual(results[0].reportPath, results[1].reportPath)
    for (const [i, result] of results.entries()) {
      const text = readFileSync(result.reportPath, 'utf8')
      assert.equal(parseFrontmatter(text).data.worktree, [first, second][i].id)
      assert.match(text, new RegExp(result.sessionId))
    }
    assert.equal(readdirSync(join(f.req.dir, 'docs/review')).filter((name) => name.endsWith('.md')).length, 2)
  } finally {
    db.close()
  }
})

for (const mode of ['fail', 'empty', 'missing', 'failed-turn']) {
  test(`评审 ${mode} 时保存失败报告并返回非零退出码`, (t) => {
    const f = fixture(t)
    if (mode === 'missing') rmSync(f.codex)
    const result = f.cli(['review', 'wt-test', '--json'], mode)
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const output = JSON.parse(result.stdout)
    assert.ok(output.error)
    const reportPath = join(f.req.dir, 'docs/review/01-review.md')
    const report = readFileSync(reportPath, 'utf8')
    assert.equal(parseFrontmatter(report).data.status, 'failed')
    assert.match(output.error, /01-review.md/)
    if (mode === 'fail') assert.match(report, /7/)
    assert.ok(!readdirSync(join(f.req.dir, 'docs/review')).some((name) => name.endsWith('.tmp')))
  })
}

test('拒绝缺失工作区、无效基线和其他归属的复查报告', (t) => {
  const f = fixture(t)
  for (const args of [[], ['wt-unknown'], ['wt-test', '--base', 'no-such-branch']]) {
    const result = f.cli(['review', ...args, '--json'])
    assert.notEqual(result.status, 0)
    assert.ok(JSON.parse(result.stdout).error)
  }
  const previous = join(f.req.dir, 'docs/review/01-review.md')
  mkdirSync(join(f.req.dir, 'docs/review'), { recursive: true })
  writeFileSync(previous, `---\nrequirement: ${f.req.id}\nworktree: wt-other\nbase: ${f.base}\nstatus: completed\n---\n# 评审\n`)
  assert.equal(f.cli(['review', 'wt-test', '--recheck', previous, '--json']).status, 1)
  assert.equal(f.cli(['review', 'wt-test', '--recheck', previous, '--base', 'HEAD', '--json']).status, 2)
  assert.equal(existsSync(f.capture), false)
})

test('review 帮助说明执行、落盘和复查参数', (t) => {
  const f = fixture(t)
  const result = f.cli(['review', '--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--recheck/)
  assert.match(result.stdout, /docs\/review/)
})
