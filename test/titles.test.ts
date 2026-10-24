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
  chengxiaobangHome: join(TMP, 'chengxiaobang'),
  cursorHome: join(TMP, 'cursor'),
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

/**
 * 程小帮自己的库：sessions 表的 title 就是侧边栏那个名字。
 * 按登记 id 逐条写，没给 title 的当「还没起名」。
 */
function writeCxbDb(rows: Array<[string, string]>): void {
  const dir = join(roots.chengxiaobangHome, 'data')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'chengxiaobang.sqlite')
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true })
  const db = new DatabaseSync(path)
  db.exec(
    `create table sessions (id text primary key, title text not null default '', created_at text not null, updated_at text not null, last_viewed_at text);`,
  )
  const now = new Date().toISOString()
  const insert = db.prepare('insert into sessions (id, title, created_at, updated_at) values (?, ?, ?, ?)')
  for (const [id, title] of rows) insert.run(id, title, now, now)
  db.close()
}

// Cursor 的 chat 库：chats/<workspace>/<conversation>/store.db 的 meta key 0 里有 name
function writeCursorDb(session: string, name: string, encode: 'json' | 'hex' = 'json'): void {
  const dir = join(roots.cursorHome, 'chats', 'workspace-hash', session)
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'store.db'))
  db.exec('create table meta (key text primary key, value text)')
  const json = JSON.stringify({ agentId: session, name })
  db.prepare('insert into meta (key, value) values (?, ?)').run(
    '0',
    encode === 'hex' ? Buffer.from(json, 'utf8').toString('hex') : json,
  )
  db.close()
}

// Cursor 3.27 的会话标题在全局 state.vscdb 的 composerHeaders.value.name
function writeComposerHeader(session: string, name: string): void {
  const dir = join(roots.appSupport, 'Cursor', 'User', 'globalStorage')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'state.vscdb'))
  db.exec('create table if not exists composerHeaders (composerId text primary key, value text)')
  db.prepare('insert or replace into composerHeaders (composerId, value) values (?, ?)').run(
    session,
    JSON.stringify({ composerId: session, name }),
  )
  db.close()
}

function registered(db: BoardDatabase, agent: string, session: string, title = '登记时那句'): void {
  db.addSession({ requirementId: 'req-x', agent: agent as 'claude' | 'codex' | 'chengxiaobang' | 'cursor', session, title })
}

const titleOf = (db: BoardDatabase, agent: string, session: string) =>
  db.sessionBy(agent as 'claude', session)?.title

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

  test('程小帮：sessions 表的 title', () => {
    writeCxbDb([['s_cxb1', '补齐小帮标题同步']])
    const db = newBoard()
    registered(db, 'chengxiaobang', 's_cxb1')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'chengxiaobang', 's_cxb1'), '补齐小帮标题同步')
  })

  test('程小帮：应用里还没起名（空标题）就不写', () => {
    writeCxbDb([['s_cxb2', '']])
    const db = newBoard()
    registered(db, 'chengxiaobang', 's_cxb2', '先写一句占着')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'chengxiaobang', 's_cxb2'), '先写一句占着')
  })

  test('程小帮：库里没有这条会话就不写', () => {
    writeCxbDb([['s_other', '别人的会话']])
    const db = newBoard()
    registered(db, 'chengxiaobang', 's_missing', '登记时那句')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'chengxiaobang', 's_missing'), '登记时那句')
  })

  test('程小帮：标题改了要跟着更新', () => {
    writeCxbDb([['s_cxb3', '占位标题']])
    const db = newBoard()
    registered(db, 'chengxiaobang', 's_cxb3')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'chengxiaobang', 's_cxb3'), '占位标题')

    writeCxbDb([['s_cxb3', 'AI 总结后的标题']])
    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'chengxiaobang', 's_cxb3'), 'AI 总结后的标题')
  })

  test('cursor：chat 库 meta 里的 name', () => {
    writeCursorDb('conv-title', 'Seat Feature Map')
    const db = newBoard()
    registered(db, 'cursor', 'conv-title')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'cursor', 'conv-title'), 'Seat Feature Map')
  })

  test('cursor：占位名 New Agent 不覆盖登记标题', () => {
    writeCursorDb('conv-placeholder', 'New Agent')
    const db = newBoard()
    registered(db, 'cursor', 'conv-placeholder', '先写一句占着')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'cursor', 'conv-placeholder'), '先写一句占着')
  })

  test('cursor：全局 composerHeaders 里的 name 覆盖登记标题', () => {
    writeComposerHeader('conv-composer', 'test2')
    const db = newBoard()
    registered(db, 'cursor', 'conv-composer', '登记时那句')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'cursor', 'conv-composer'), 'test2')
  })

  test('cursor：chat 库 meta 是十六进制时也能读到 name', () => {
    writeCursorDb('conv-hex', '十六进制标题', 'hex')
    const db = newBoard()
    registered(db, 'cursor', 'conv-hex')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'cursor', 'conv-hex'), '十六进制标题')
  })

  test('cursor：composerHeaders 的占位名不覆盖，chat 库的真标题仍然生效', () => {
    writeComposerHeader('conv-composer-placeholder', 'New Agent')
    writeCursorDb('conv-composer-placeholder', '改名之后', 'hex')
    const db = newBoard()
    registered(db, 'cursor', 'conv-composer-placeholder', '登记时那句')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'cursor', 'conv-composer-placeholder'), '改名之后')
  })

  test('cursor：composerHeaders 有真标题时盖过 chat 库', () => {
    writeComposerHeader('conv-composer-wins', 'test2')
    writeCursorDb('conv-composer-wins', '旧库里的标题')
    const db = newBoard()
    registered(db, 'cursor', 'conv-composer-wins')

    pullTitles(db.listSessions(), db, roots)
    assert.equal(titleOf(db, 'cursor', 'conv-composer-wins'), 'test2')
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

  test('程小帮的库不存在 / 不是合法库，都当没有', () => {
    const db = newBoard()
    registered(db, 'chengxiaobang', 's_cxb_missing', '登记时那句')
    pullTitles(db.listSessions(), db, { ...roots, chengxiaobangHome: join(TMP, '根本没有这个目录') })
    assert.equal(titleOf(db, 'chengxiaobang', 's_cxb_missing'), '登记时那句')

    const broken = join(TMP, 'cxb-broken')
    mkdirSync(join(broken, 'data'), { recursive: true })
    writeFileSync(join(broken, 'data', 'chengxiaobang.sqlite'), '这不是一个库', 'utf8')
    pullTitles(db.listSessions(), db, { ...roots, chengxiaobangHome: broken })
    assert.equal(titleOf(db, 'chengxiaobang', 's_cxb_missing'), '登记时那句')
  })
})
