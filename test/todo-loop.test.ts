/**
 * 待办与需求之间那条桥的回归。
 *
 * 这条桥原来的样子：待办侧一个指针，需求侧反查。实测几乎没人走（26 条待办 6 条挂上），
 * 所以这里锁住三件补上的事——归属能由会话推出来、收尾时看得见、立项一次做完。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { BoardDatabase, todoAgeDays, todoSessionKey } from '../server/db.ts'
import { createProjectDir, createRequirementDir } from '../server/convention.ts'

const TMP = join(tmpdir(), `easy-flow-todo-loop-${process.pid}`)

/** 一个干净的数据目录：项目 + 一条需求 + 若干待办 */
function fixture(todos: Array<{ id: string; title: string }>): { dir: string; reqId: string } {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  createProjectDir(TMP, 'p', 'P')
  const req = createRequirementDir(join(TMP, 'p'), 'alpha', '接入标准价', '一句话')
  const dir = join(TMP, '_todos')
  mkdirSync(dir, { recursive: true })
  for (const t of todos) {
    writeFileSync(join(dir, `${t.id}.md`), `# ${t.title}\n\n## 摘要\n\n上下文\n`, 'utf8')
  }
  return { dir: TMP, reqId: req.id }
}

/** 在 fixture 的数据目录上跑一次真实 CLI：块拼装、批量动作这类行为只能从入口验 */
function runCli(args: string[]): ReturnType<typeof spawnSync> {
  const cli = join(process.cwd(), 'server/cli.ts')
  writeFileSync(join(TMP, 'config.json'), JSON.stringify({ dataDir: TMP }), 'utf8')
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    env: { ...process.env, EASY_FLOW_CONFIG: join(TMP, 'config.json'), EASY_FLOW_USER_DATA: TMP },
    encoding: 'utf8',
  })
}

describe('待办闭环 · 会话归一化', () => {
  test('链接式会话串与裸 id 归一化到同一个键', () => {
    const id = '01a0eb80-64ff-7010-9d07-cafc41e6e33b'
    assert.equal(todoSessionKey(`codex://threads/${id}`), id)
    assert.equal(todoSessionKey(id), id)
    assert.equal(todoSessionKey(`claude://claude.ai/epitaxy/local_775b0b34-2667-437b-b33f-7916c88d8b63`), 'local_775b0b34-2667-437b-b33f-7916c88d8b63')
  })

  test('★ id 后面跟着备注也能认出来：待办里的会话是人手写的', () => {
    const id = 'local_58777dd2-2bcd-41b7-91c5-6c82c04c99e8'
    assert.equal(todoSessionKey(`claude://local_${id.slice(6)}（本会话「SUZ 部署」，repo easy-flow）`), id)
    assert.equal(
      todoSessionKey(`codex://threads/01a0c87d-7756-7491-ad58-c78d94ea10ec（选座价格库缓存 ZSet 去重）`),
      '01a0c87d-7756-7491-ad58-c78d94ea10ec',
    )
  })
})

describe('待办闭环 · 停留天数', () => {
  test('按本机日期算整天，未来时间与坏值都落 0', () => {
    assert.equal(todoAgeDays('2026-10-12 16:29', '2026-10-19'), 7)
    assert.equal(todoAgeDays('2026-10-19 09:00', '2026-10-19'), 0)
    assert.equal(todoAgeDays('2026-10-25 09:00', '2026-10-19'), 0, '未来时间不该出现负数')
    assert.equal(todoAgeDays('', '2026-10-19'), 0)
  })
})

describe('待办闭环 · 归属三档', () => {
  test('显式指针归到 explicit；没写指针但会话登记在需求上的是 candidate', () => {
    const { dir, reqId } = fixture([
      { id: 'T-20260101-001', title: '写了指针的' },
      { id: 'T-20260101-002', title: '只有会话的' },
      { id: 'T-20260101-003', title: '什么都没有的' },
    ])
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.setTodoFields('T-20260101-001', { requirementId: reqId })
    // 会话表存裸 id，待办里存链接式——归一化就是为这一对服务的
    db.addSession({ requirementId: reqId, agent: 'codex', session: '01a0eb80-64ff-7010-9d07-cafc41e6e33b' })
    db.setTodoFields('T-20260101-002', { session: 'codex://threads/01a0eb80-64ff-7010-9d07-cafc41e6e33b' })

    const { explicit, candidate } = db.todosForRequirement(reqId)
    assert.deepEqual(explicit.map((t) => t.id), ['T-20260101-001'])
    assert.deepEqual(candidate.map((t) => t.id), ['T-20260101-002'], '推出来的归候选，不冒充登记过的')
    // 候选与显式都算「有归属」：无归属只剩第三条
    assert.deepEqual(db.orphanTodos().map((t) => t.id), ['T-20260101-003'])
    db.close()
  })

  test('★ 指针指向一条不存在的需求：既不算显式，也不算无归属，单独点名', () => {
    const { dir } = fixture([{ id: 'T-20260101-001', title: '指向已删需求的' }])
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.setTodoFields('T-20260101-001', { requirementId: 'req-gone' })

    assert.deepEqual(db.stalePointerTodos().map((t) => t.id), ['T-20260101-001'])
    assert.deepEqual(db.orphanTodos(), [], '有指针就不算无归属——不然会被当成「没人管」而漏掉重挂')
    db.close()
  })

  test('★ 悬空指针不串进别的需求：它不属于任何一条现存需求', () => {
    const { dir, reqId } = fixture([{ id: 'T-20260101-001', title: '指向已删需求的' }])
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.setTodoFields('T-20260101-001', { requirementId: 'req-gone' })

    const { explicit, candidate } = db.todosForRequirement(reqId)
    assert.deepEqual([...explicit, ...candidate], [], '悬空的不该算到这条需求名下')
    db.close()
  })

  test('★ 归属需求已完成：收尾没一并了结的那批要单独取出来', () => {
    const { dir, reqId } = fixture([{ id: 'T-20260101-001', title: '挂在已完成需求下的' }])
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.syncProjects()
    db.setTodoFields('T-20260101-001', { requirementId: reqId })
    db.setStatus('alpha', '已完成', 'p')

    assert.deepEqual(db.finishedRequirementTodos().map((t) => t.id), ['T-20260101-001'])
    db.setTodoStatus('T-20260101-001', 'done')
    assert.deepEqual(
      db.finishedRequirementTodos().filter((t) => t.status !== 'done'),
      [],
      '已了结的不再点名',
    )
    db.close()
  })

  test('需求没有 id 时两档都是空——不能把无归属的算成挂在它下面', () => {
    const { dir } = fixture([{ id: 'T-20260101-001', title: '没挂的' }])
    const db = new BoardDatabase(dir)
    db.syncTodos()
    // 库里的「没挂」读出来是空串，与需求没 id 时的 requirementId 相等
    const { explicit, candidate } = db.todosForRequirement('')
    assert.deepEqual(explicit, [])
    assert.deepEqual(candidate, [])
    assert.deepEqual(db.orphanTodos().map((t) => t.id), ['T-20260101-001'])
    db.close()
  })

  test('按会话反查：链接式、裸 id、带备注都能查到同一条', () => {
    const { dir } = fixture([{ id: 'T-20260101-001', title: '带会话的' }])
    const db = new BoardDatabase(dir)
    db.syncTodos()
    const id = '01a0eb80-64ff-7010-9d07-cafc41e6e33b'
    db.setTodoFields('T-20260101-001', { session: `codex://threads/${id}` })

    assert.deepEqual(db.listTodosBySession(id).map((t) => t.id), ['T-20260101-001'])
    assert.deepEqual(db.listTodosBySession(`codex://threads/${id}`).map((t) => t.id), ['T-20260101-001'])
    assert.deepEqual(db.listTodosBySession('nope'), [])
    db.close()
  })
})

describe('待办闭环 · context 与批量收尾', () => {
  test('★ 收尾提示只点名本需求的待办，悬空的不算进来', () => {
    const { reqId } = fixture([
      { id: 'T-20260101-001', title: '本需求的' },
      { id: 'T-20260101-002', title: '指向已删需求的' },
    ])
    const db = new BoardDatabase(TMP)
    db.syncTodos()
    db.setTodoFields('T-20260101-001', { requirementId: reqId })
    db.setTodoFields('T-20260101-002', { requirementId: 'req-gone' })
    db.close()

    const res = runCli(['req', 'set', reqId, '--status', 'Review'])
    assert.equal(res.status, 0, String(res.stderr))
    assert.match(String(res.stdout), /还有 1 条未完成待办/)
    assert.doesNotMatch(String(res.stdout), /T-20260101-002/, '悬空的不属于这条需求')
  })

  test('context 把悬空与归属需求已完成全局点名，各只一次', () => {
    const { reqId } = fixture([
      { id: 'T-20260101-001', title: '挂在已完成需求下的' },
      { id: 'T-20260101-002', title: '指向已删需求的' },
      { id: 'T-20260101-003', title: '谁都没挂的' },
    ])
    const db = new BoardDatabase(TMP)
    db.syncTodos()
    db.syncProjects()
    db.setTodoFields('T-20260101-001', { requirementId: reqId })
    db.setTodoFields('T-20260101-002', { requirementId: 'req-gone' })
    db.setStatus('alpha', '已完成', 'p')
    db.close()

    const res = runCli(['context', reqId])
    assert.equal(res.status, 0, String(res.stderr))
    const out = String(res.stdout)
    assert.equal(out.split('## 待办 · 指针悬空').length - 1, 1)
    assert.equal(out.split('## 待办 · 归属需求已完成').length - 1, 1)
    assert.match(out, /## 无归属待办（1，超期 0）/)
    assert.match(out, /T-20260101-002/)
    assert.match(out, /T-20260101-001/)
  })

  test('★ todo set 一次收多条：全部落库，不多不少', () => {
    fixture([
      { id: 'T-20260101-001', title: '第一条' },
      { id: 'T-20260101-002', title: '第二条' },
      { id: 'T-20260101-003', title: '没动的' },
    ])
    const res = runCli(['todo', 'set', 'T-20260101-001', 'T-20260101-002', '--status', 'done', '--json'])
    assert.equal(res.status, 0, String(res.stderr))
    const out = JSON.parse(String(res.stdout)) as { todos: Array<{ id: string; status: string }> }
    assert.deepEqual(out.todos.map((t) => t.id), ['T-20260101-001', 'T-20260101-002'])

    const db = new BoardDatabase(TMP)
    db.syncTodos()
    const status = (id: string) => db.todoById(id)!.status
    assert.equal(status('T-20260101-001'), 'done')
    assert.equal(status('T-20260101-002'), 'done')
    assert.equal(status('T-20260101-003'), 'todo', '没点名的不能被顺带改掉')
    db.close()
  })

  test('多 id 配 --title 直接报错，不假装改成功', () => {
    fixture([
      { id: 'T-20260101-001', title: '第一条' },
      { id: 'T-20260101-002', title: '第二条' },
    ])
    const res = runCli(['todo', 'set', 'T-20260101-001', 'T-20260101-002', '--title', '新标题'])
    assert.notEqual(res.status, 0)
    assert.match(String(res.stderr) + String(res.stdout), /--title/)
  })

  test('todo list --orphan 给出未归属 / 超期 / 最老三个数，JSON 只数未完成', () => {
    fixture([
      { id: 'T-20260101-001', title: '还开着的' },
      { id: 'T-20260101-002', title: '已经做完的' },
    ])
    const db = new BoardDatabase(TMP)
    db.syncTodos()
    db.setTodoStatus('T-20260101-002', 'done')
    db.close()

    const human = runCli(['todo', 'list', '--orphan'])
    assert.equal(human.status, 0, String(human.stderr))
    assert.match(String(human.stdout), /未归属 1 条、其中超期 0 条、最老 0 天/)

    const json = runCli(['todo', 'list', '--orphan', '--json'])
    const out = JSON.parse(String(json.stdout)) as { orphan: number }
    assert.equal(out.orphan, 1, '已了结的不算进未归属')
  })
})

describe('待办闭环 · 立项一次做完', () => {
  test('★ promote 建需求并回填指针，重复调用不再长出第二条需求', () => {
    const { dir, reqId } = fixture([{ id: 'T-20260101-001', title: '要做成需求的事' }])
    const board = new BoardDatabase(dir)
    board.syncTodos()
    // 先让库认得这条待办
    assert.equal(board.todoById('T-20260101-001')!.requirementId, '')
    board.close()

    const cli = join(process.cwd(), 'server/cli.ts')
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
        env: { ...process.env, EASY_FLOW_CONFIG: join(TMP, 'config.json'), EASY_FLOW_USER_DATA: TMP },
        encoding: 'utf8',
      })
    writeFileSync(join(TMP, 'config.json'), JSON.stringify({ dataDir: dir }), 'utf8')

    const first = run(['todo', 'promote', 'T-20260101-001', '--project', 'p', '--slug', 'from-todo', '--json'])
    assert.equal(first.status, 0, first.stderr)
    const out = JSON.parse(first.stdout) as { todo: { requirementId: string }; requirement: { id: string; slug: string } }
    assert.match(out.requirement.id, /^req-/)
    assert.equal(out.todo.requirementId, out.requirement.id, '指针在同一次动作里回填')
    assert.notEqual(out.requirement.id, reqId)

    // 需求目录真的落地了，且能被扫进库
    const again = new BoardDatabase(dir)
    again.syncProjects()
    const stored = again.byId(out.requirement.id)
    assert.ok(stored, '新需求应当已经入库')
    assert.equal(stored!.slug, 'from-todo')
    assert.deepEqual(again.listTodos(out.requirement.id).map((t) => t.id), ['T-20260101-001'])
    again.close()

    // 第二次调用：报错并指出已有的那条需求，不再新建
    const second = run(['todo', 'promote', 'T-20260101-001', '--project', 'p', '--slug', 'again', '--json'])
    assert.notEqual(second.status, 0)
    assert.match(second.stdout, /already belongs to/)
  })
})
