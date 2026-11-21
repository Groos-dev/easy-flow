import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BoardDatabase } from '../server/db.ts'
import { createProjectDir, createRequirementDir } from '../server/convention.ts'
import { createBoardApp } from '../server/index.ts'

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-session-analysis-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  createProjectDir(dir, 'p', '项目')
  const req = createRequirementDir(join(dir, 'p'), 'alpha', '会话复盘')
  const config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ dataDir: dir }))
  const db = new BoardDatabase(dir)
  db.syncProjects()
  db.close()
  const cli = (...args: string[]) => spawnSync(
    process.execPath, ['--import', 'tsx', join(process.cwd(), 'server/cli.ts'), ...args],
    { env: { ...process.env, EASY_FLOW_CONFIG: config, EASY_FLOW_USER_DATA: dir }, encoding: 'utf8' },
  )
  return { dir, req, config, cli }
}

test('新需求待分析，登记结果后 context 与重新同步保留分析状态', (t) => {
  const { dir, req, cli } = fixture(t)
  const initial = JSON.parse(cli('context', req.id, '--json').stdout)
  assert.equal(initial.requirement.sessionAnalysisStatus, 'pending')
  assert.match(cli('context', req.id).stdout, /会话分析：待分析/)

  const marked = cli('req', 'set', req.id, '--session-analysis', 'completed', '--json')
  assert.equal(marked.status, 0, marked.stderr)
  assert.equal(JSON.parse(marked.stdout).sessionAnalysisStatus, 'completed')
  writeFileSync(join(req.dir, 'context.md'), '## 决策\n\n已分析全部关联会话，无值得沉淀内容。\n')
  const db = new BoardDatabase(dir)
  db.syncProjects()
  assert.equal(db.byId(req.id)?.sessionAnalysisStatus, 'completed')
  db.close()
  assert.match(cli('context', req.id).stdout, /会话分析：已分析/)
  assert.equal(JSON.parse(cli('context', req.id, '--json').stdout).requirement.sessionAnalysisStatus, 'completed')
})

test('CLI 完成被拦截，文本及 JSON 提醒用户另开 session，状态与优先级保持原值', (t) => {
  const { dir, req, cli } = fixture(t)
  assert.equal(cli('req', 'set', req.id, '--status', 'review', '--priority', 'p1').status, 0)
  for (const format of [[], ['--json']]) {
    const result = cli('req', 'set', req.id, '--status', 'completed', '--priority', 'p0', ...format)
    assert.equal(result.status, 1)
    const error = format.length ? JSON.parse(result.stdout).error : result.stderr
    assert.match(error, new RegExp(req.id))
    assert.match(error, /提醒用户/)
    assert.match(error, /另开.*session/i)
    assert.match(error, /全部.*会话/)
    assert.match(error, /工具调用/)
    assert.match(error, /Skill/)
  }
  const db = new BoardDatabase(dir)
  assert.equal(db.byId(req.id)?.status, 'review')
  assert.equal(db.byId(req.id)?.priority, 'p1')
  assert.equal(db.byId(req.id)?.sessionAnalysisStatus, 'pending')
  db.close()
})

test('分析 session 登记完成后 CLI 可以收尾', (t) => {
  const { req, cli } = fixture(t)
  assert.equal(cli('req', 'set', req.id, '--session-analysis', 'completed').status, 0)
  const result = cli('req', 'set', req.id, '--status', 'completed', '--json')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'completed')
  assert.equal(JSON.parse(result.stdout).sessionAnalysisStatus, 'completed')
})

test('跳过分析不能通过 CLI 完成门禁，失败时分析字段也保持原值', (t) => {
  const { req, cli } = fixture(t)
  const rejected = cli('req', 'set', req.id, '--session-analysis', 'skipped', '--status', 'completed')
  assert.equal(rejected.status, 1)
  assert.equal(JSON.parse(cli('context', req.id, '--json').stdout).requirement.sessionAnalysisStatus, 'pending')
  assert.equal(cli('req', 'set', req.id, '--session-analysis', 'skipped').status, 0)
  assert.equal(cli('req', 'set', req.id, '--status', 'completed').status, 1)
  assert.match(cli('context', req.id).stdout, /会话分析：已跳过分析/)
  const completed = cli('req', 'set', req.id, '--session-analysis', 'completed', '--status', 'completed', '--json')
  assert.equal(completed.status, 0, completed.stderr)
  assert.equal(JSON.parse(completed.stdout).sessionAnalysisStatus, 'completed')
})

test('非法分析状态拒绝更新，普通状态与优先级操作保持可用', (t) => {
  const { req, cli } = fixture(t)
  const bad = cli('req', 'set', req.id, '--session-analysis', 'done', '--status', 'review', '--json')
  assert.equal(bad.status, 1)
  assert.match(JSON.parse(bad.stdout).error, /(?:Unknown session analysis status|未知会话分析状态)/)
  assert.equal(JSON.parse(cli('context', req.id, '--json').stdout).requirement.status, 'clarification')
  for (const status of ['clarification', 'in_progress', 'review']) {
    const updated = cli('req', 'set', req.id, '--status', status, '--priority', 'p2', '--json')
    assert.equal(updated.status, 0, updated.stderr)
    assert.equal(JSON.parse(updated.stdout).sessionAnalysisStatus, 'pending')
  }
  assert.equal(cli('req', 'set', req.id, '--priority', '').status, 0)
  assert.equal(cli('req', 'set', req.id, '--session-analysis', 'completed').status, 0)
  assert.equal(cli('req', 'set', req.id, '--session-analysis', 'pending').status, 0)
  assert.equal(cli('req', 'set', req.id, '--status', 'completed').status, 1)
})

test('老库补分析字段，历史已完成记为跳过，重复开库保留已有结果', (t) => {
  const { dir, req, cli } = fixture(t)
  const other = createRequirementDir(join(dir, 'p'), 'beta', '历史已完成需求')
  const seed = new BoardDatabase(dir)
  seed.syncProjects()
  seed.setStatus('beta', 'completed', 'p')
  seed.close()
  const old = new DatabaseSync(join(dir, 'easy-flow.db'))
  const cols = old.prepare('PRAGMA table_info(requirement)').all()
  if (cols.some((c) => c.name === 'session_analysis_status')) {
    old.exec('ALTER TABLE requirement DROP COLUMN session_analysis_status')
  }
  old.close()
  const migrated = new BoardDatabase(dir)
  assert.equal(migrated.byId(req.id)?.sessionAnalysisStatus, 'pending')
  assert.equal(migrated.byId(other.id)?.sessionAnalysisStatus, 'skipped')
  migrated.close()
  assert.equal(cli('req', 'set', other.id, '--session-analysis', 'completed').status, 0)
  const reopened = new BoardDatabase(dir)
  assert.equal(reopened.byId(other.id)?.sessionAnalysisStatus, 'completed')
  reopened.close()
})

test('UI 两个入口均直接完成，待分析记为跳过，已有分析结果保留', async (t) => {
  const { dir, config, cli } = fixture(t)
  const previous = process.env.EASY_FLOW_CONFIG
  process.env.EASY_FLOW_CONFIG = config
  t.after(() => {
    if (previous === undefined) delete process.env.EASY_FLOW_CONFIG
    else process.env.EASY_FLOW_CONFIG = previous
  })
  const cases = [
    { route: '/api/move', slug: 'move-pending', analyzed: false },
    { route: '/api/move', slug: 'move-completed', analyzed: true },
    { route: '/api/update', slug: 'update-pending', analyzed: false },
    { route: '/api/update', slug: 'update-completed', analyzed: true },
  ]
  for (const c of cases) {
    const req = createRequirementDir(join(dir, 'p'), c.slug, '测试需求')
    if (c.analyzed) assert.equal(cli('req', 'set', req.id, '--session-analysis', 'completed').status, 0)
  }
  const app = createBoardApp({ dataDir: dir })
  const server = createServer((req, res) => void app.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  for (const c of cases) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}${c.route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: c.slug, project: 'p', status: 'completed' }),
    })
    assert.equal(response.status, 200)
    const data = await response.json() as { status: string; sessionAnalysisStatus: string }
    assert.equal(data.status, 'completed')
    assert.equal(data.sessionAnalysisStatus, c.analyzed ? 'completed' : 'skipped')
    assert.equal(app.db.get(c.slug, 'p')?.sessionAnalysisStatus, data.sessionAnalysisStatus)
  }
})
