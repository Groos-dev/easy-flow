/**
 * 标题同步：把 agent 应用里的标题写进登记记录（session 表的 title）。
 *
 * 两条来源——claude 的桌面记录与 CLI 进程文件、codex 的 threads 表；应用里还没起名或读不到，
 * 就不写，保留登记时那句。运行：pnpm test
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { BoardDatabase } from '../server/db.ts'
import { codexTitles } from '../server/codex-titles.ts'
import { pullTitles, type ThreadRoots } from '../server/threads.ts'

const TMP = join(tmpdir(), `easy-flow-test-titles-${process.pid}`)

const roots: ThreadRoots = {
  appSupport: join(TMP, 'appSupport'),
  claudeHome: join(TMP, 'claude'),
  codexHome: join(TMP, 'codex'),
}

/**
 * claude 桌面记录：文件名就是登记 id，内容里那句 title 是应用里显示的标题。
 */
function writeRecord(id: string, rec: Record<string, unknown>): void {
  const dir = join(roots.appSupport, 'Claude', 'claude-code-sessions', 'acc', 'org')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: id, ...rec }), 'utf8')
}

/**
 * claude CLI 进程文件：活着的会话才有，终端会话只有这儿的 name。
 */
function writeLive(pid: number, rec: Record<string, unknown>): void {
  const dir = join(roots.claudeHome, 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(rec), 'utf8')
}

/**
 * codex 自己的库：threads 表的 name 就是侧边栏那个短名。
 */
function writeCodexDb(rows: Array<[string, string]>): void {
  mkdirSync(roots.codexHome, { recursive: true })
  const path = join(roots.codexHome, 'state_5.sqlite')
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)')
  const insert = db.prepare('INSERT INTO threads (id, name) VALUES (?, ?)')
  for (const [id, name] of rows) insert.run(id, name)
  db.close()
}

let seq = 0
function newBoard(): BoardDatabase {
  return new BoardDatabase(join(TMP, `db-${seq++}`), 'p')
}

function registered(db: BoardDatabase, agent: string, session: string, title = '登记时那句'): void {
  db.addSession({ requirementId: 'req-x', agent: agent as 'claude' | 'codex', session, title })
}

const titleOf = (db: BoardDatabase, agent: string, session: string) => db.sessionBy(agent as 'claude', session)?.title

before(() => rmSync(TMP, { recursive: true, force: true }))
after(() => rmSync(TMP, { recursive: true, force: true }))

describe('标题同步：应用里那句覆盖登记那句', () => {
  test('claude 桌面会话：记录里的 title', () => {
    writeRecord('local_a', { cliSessionId: 'cli-a', title: 'pet 气泡：工具动作数据源' })
    const db = newBoard()
    registered(db, 'claude', 'local_a')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'claude', 'local_a'), 'pet 气泡：工具动作数据源')
  })

  test('claude 终端会话：记录没有，退到进程文件的 name', () => {
    writeLive(4242, { sessionId: 'cli-t', name: 'MU 53927 NPE parsing logic', status: 'idle' })
    const db = newBoard()
    registered(db, 'claude', 'cli-t')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'claude', 'cli-t'), 'MU 53927 NPE parsing logic')
  })

  test('应用里还没起名就不写，登记那句留着', () => {
    writeRecord('local_b', { cliSessionId: 'cli-b' })
    const db = newBoard()
    registered(db, 'claude', 'local_b', '先写一句占着')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'claude', 'local_b'), '先写一句占着')
  })

  test('codex：threads 表的 name', () => {
    writeCodexDb([['cx-1', '【长期任务】MU 行李出票监控']])
    const db = newBoard()
    registered(db, 'codex', 'cx-1')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'codex', 'cx-1'), '【长期任务】MU 行李出票监控')
  })

  test('codex：库里没有这条 thread 就不写', () => {
    const db = newBoard()
    registered(db, 'codex', 'cx-没登记过')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'codex', 'cx-没登记过'), '登记时那句')
  })

  test('原样写：换行与长句都不裁', () => {
    const raw = '在 easy-flow 需求 req-3b4f4675ce 上开始工作。\n\n先运行 easy-flow context'
    writeCodexDb([['cx-2', raw]])
    const db = newBoard()
    registered(db, 'codex', 'cx-2')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'codex', 'cx-2'), raw)
  })

  test('与库里那句一样就不动它', () => {
    const db = newBoard()
    registered(db, 'claude', 'local_a', 'pet 气泡：工具动作数据源')
    assert.equal(db.setSessionTitle('claude', 'local_a', 'pet 气泡：工具动作数据源'), false, '没变就不写')
    assert.equal(db.setSessionTitle('claude', 'local_a', '改了'), true)
    assert.equal(titleOf(db, 'claude', 'local_a'), '改了')
  })
})

describe('标题来源读不到时', () => {
  test('codex 的库不存在 / 没有 threads 表，都当没有', () => {
    const empty = new BoardDatabase(join(TMP, 'db-empty'), 'p')
    assert.equal(codexTitles(join(TMP, '根本没有这个目录')).size, 0)

    mkdirSync(join(TMP, 'codex-broken'), { recursive: true })
    writeFileSync(join(TMP, 'codex-broken', 'state_5.sqlite'), '这不是一个库', 'utf8')
    assert.equal(codexTitles(join(TMP, 'codex-broken')).size, 0)

    registered(empty, 'codex', 'cx-1')
    pullTitles(empty.listSessions(), empty, { ...roots, codexHome: join(TMP, 'codex-broken') })
    assert.equal(titleOf(empty, 'codex', 'cx-1'), '登记时那句')
  })

  test('claude 的记录目录整个不在也不抛，什么都不写', () => {
    const db = newBoard()
    registered(db, 'claude', 'local_a')
    const gone: ThreadRoots = { ...roots, appSupport: join(TMP, '没有这个目录'), claudeHome: join(TMP, '也没有') }

    pullTitles(db.listSessions(), db, gone)
    assert.equal(titleOf(db, 'claude', 'local_a'), '登记时那句')
  })
})
