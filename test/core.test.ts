/**
 * easy-flow 核心回归测试。
 *
 * 目的：给重构提供可验证的行为基线。
 * 覆盖数据层（markdown 解析、sqlite 同步、状态读写）与 HTTP 层的外在行为，
 * 不测内部实现细节——所以重构实现时这些测试应保持全绿。
 *
 * 运行：pnpm test
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync, readdirSync, cpSync, realpathSync, lstatSync, readlinkSync, statSync } from 'node:fs'
import { join, basename, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BoardDatabase, normalizeLinkList, normalizeCodeLinks, normalizeExtLinks } from '../server/db.ts'
import { hookKeyOf, pullStatuses, readObservations } from '../server/threads.ts'
import { RolloutStore, rolloutStatusOf, sessionDirFor } from '../server/rollout.ts'
import type { SourceTable } from '../server/source-file.ts'
import { normalizeHookEvent, recordHook } from '../server/hook.ts'
import { idleStatus, SessionStateStore, THREAD_STATES, type SessionStatus } from '../server/session-state.ts'
import { parseFrontmatter, readDocs, section } from '../server/markdown.ts'
import { createProjectDir, createRequirementDir, setRequirementId } from '../server/convention.ts'
import { createBoardApp } from '../server/index.ts'
import { readConfig, writeConfig } from '../server/config.ts'
import { buildTree, layoutTree, nodeWidth } from '../src/renderer/src/lib/mindmap.ts'
import { codeLinkLabel, feishuTaskLabel } from '../src/renderer/src/lib/links.ts'
import { acceleratorFromEvent, formatAccelerator } from '../src/renderer/src/lib/shortcut.ts'
import { moveKey, resolveKey } from '../src/renderer/src/lib/selection.ts'
import { badgesOf, isEventState } from '../src/renderer/src/lib/threads.ts'
import { bubbleToneOf, PET_LABEL, PET_RANK, focusIndex, planPetRow, type Pose } from '../src/renderer/src/lib/pets.ts'
import type { SessionAction } from '../src/renderer/src/lib/types.ts'
import { petArt, scopeCloudling, idleMoodOf, type IdleMood } from '../src/renderer/src/lib/pet-art.ts'
import { CLOUDLING_SVG } from '../src/renderer/src/lib/pet-cloudling-art.ts'
import { childStatsOf, childrenOf } from '../src/renderer/src/lib/children.ts'
import { parseStamp, relTime } from '../src/renderer/src/lib/time.ts'
import type { Requirement, Session } from '../src/renderer/src/lib/types.ts'

// 夹具不该受用户全局 git 配置影响：core.hooksPath 指向 lefthook，每条命令都要跑它，
// 偶尔会卡上几分钟（还会让随后的 rmSync 撞 ENOTEMPTY）。身份由每条命令显式 -c 传，够用。
process.env.GIT_CONFIG_GLOBAL = '/dev/null'

// 固定一个路径，多个 worktree 并行跑测试时会互相删对方的夹具（fresh 每次清空它）。
// 按 cwd 派生：每个工作区一份，同工作区内仍是同一目录。
const TMP = process.env.EASY_FLOW_TEST_TMP ?? join(tmpdir(), `easy-flow-test-${basename(process.cwd())}`)

/** 状态层与读位置都落在 sqlite 上：每个用例一个自己的库。放 OS 临时目录——TMP 会被 fresh() 整个清掉 */
let storeSeq = 0
function newState(): { store: SessionStateStore; sources: SourceTable } {
  const db = new BoardDatabase(join(tmpdir(), `easy-flow-test-state-${process.pid}`, String(storeSeq++)), 'p')
  return {
    store: new SessionStateStore({
      get: (agent, session) => db.getSessionObservation(agent, session),
      put: (agent, session, observation) => db.putSessionObservation(agent, session, observation),
      drop: (agent, session) => db.dropSessionObservation(agent, session),
      keyOf: (agent, session) => db.keyOf(agent, session),
      alias: (agent, session, key) => db.alias(agent, session, key),
    }),
    sources: {
      source: (path) => db.source(path),
      listSources: () => db.listSources(),
      touchSource: (path, patch) => db.touchSource(path, patch),
    },
  }
}

/** 造一个需求目录 */
function makeReq(
  dataDir: string,
  project: string,
  slug: string,
  body: string,
  opts: { id?: string; docs?: Record<string, string>; symlink?: boolean } = {},
): string {
  const dir = join(dataDir, project, slug)
  mkdirSync(join(dir, 'docs'), { recursive: true })
  // 身份写在 AGENTS.md：两份齐备才算需求，requirement.md 放需求描述
  const fm = opts.id ? `---\nid: ${opts.id}\n---\n\n` : ''
  writeFileSync(join(dir, 'AGENTS.md'), `${fm}<!-- agent 指令 -->\n`, 'utf8')
  writeFileSync(join(dir, 'requirement.md'), `${body}\n`, 'utf8')
  for (const [name, content] of Object.entries(opts.docs ?? {})) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  if (opts.symlink) {
    // 指向仓库的软链：不应被遍历进去
    const target = join(TMP, 'fake-repo')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'README.md'), '# 不应被索引', 'utf8')
    symlinkSync(target, join(dir, 'repo'))
  }
  return dir
}

function fresh(structure: (dir: string) => void): string {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  structure(TMP)
  return TMP
}

// ---------------------------------------------------------------- markdown

describe('markdown 解析', () => {
  test('parseFrontmatter 能解析键值并剥离正文', () => {
    const { data, body } = parseFrontmatter('---\nstage: 开发\npriority: p1\n---\n\n# 标题\n\n正文')
    assert.equal(data.stage, '开发')
    assert.equal(data.priority, 'p1')
    assert.equal(body, '# 标题\n\n正文')
  })

  test('无 frontmatter 时原样返回', () => {
    const { data, body } = parseFrontmatter('# 标题\n正文')
    assert.deepEqual(data, {})
    assert.equal(body, '# 标题\n正文')
  })

  test('section 正确按 ## 切分（不会把正文截成空）', () => {
    const body = '# T\n\n## 需求\n\n这是需求段落\n\n## 链接\n\n链接内容\n'
    assert.equal(section(body, '需求'), '这是需求段落')
    assert.equal(section(body, '链接'), '链接内容')
    assert.equal(section(body, '不存在的标题'), '')
  })

  test('readDocs 不跟随软链（仓库软链不应被索引）', () => {
    const dir = fresh((d) => {
      makeReq(d, 'p', 'r', '# r\n\n## 需求\n\nx', {
        docs: { 'docs/a.md': 'AAA' },
        symlink: true,
      })
    })
    const docs = readDocs(join(dir, 'p', 'r'))
    const names = docs.map((x) => x.name)
    assert.ok(names.includes('docs/a.md'))
    assert.ok(!names.some((n) => n.startsWith('repo/')))
  })

  test('readDocs 跳过 AGENTS.md 本身', () => {
    const dir = fresh((d) => makeReq(d, 'p', 'r', '# r'))
    const names = readDocs(join(dir, 'p', 'r')).map((x) => x.name)
    assert.ok(!names.includes('AGENTS.md'))
  })
})

// ------------------------------------------------------------ 数据层：同步

describe('数据层 · 项目与需求同步', () => {
  test('首次同步识别项目与需求', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\nA 需求')
      makeReq(d, 'onex', 'beta', '# beta\n\n## 需求\n\nB 需求')
      makeReq(d, 'personal', 'gamma', '# gamma\n\n## 需求\n\nC 需求')
    })
    const db = new BoardDatabase(dir)
    const sync = db.syncProjects()
    assert.equal(sync.added.length, 3)

    const projects = db.listProjects().map((p) => p.slug).sort()
    assert.deepEqual(projects, ['onex', 'personal'])

    const counts = Object.fromEntries(db.listProjects().map((p) => [p.slug, p.requirementCount]))
    assert.equal(counts.onex, 2)
    assert.equal(counts.personal, 1)
    db.close()
  })

  test('下划线开头的目录不被当作项目', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha')
      mkdirSync(join(d, '_inbox', 'stuff'), { recursive: true })
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.deepEqual(db.listProjects().map((p) => p.slug), ['onex'])
    db.close()
  })

  test('★ 同步不覆盖已有状态（status/priority 是权威的）', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\n内容'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.setStatus('alpha', 'Review')

    // 再同步多次，状态必须保持
    db.syncProjects()
    db.syncProjects()
    assert.equal(db.get('alpha')?.status, 'Review')
    db.close()
  })

  test('★ agent 重写 md 后状态仍在，且标题/摘要跟随更新', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# 旧标题\n\n## 需求\n\n旧描述'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.setPriority('alpha', 'p1')

    writeFileSync(join(dir, 'onex', 'alpha', 'requirement.md'), '# 新标题\n\n## 需求\n\n新描述', 'utf8')
    db.syncProjects()

    const req = db.get('alpha')
    assert.equal(req?.title, '新标题')
    assert.equal(req?.summary, '新描述')
    assert.equal(req?.priority, 'p1', '状态不应被文件重写冲掉')
    db.close()
  })

  test('新增需求不影响已有需求状态', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.setStatus('alpha', '已完成')

    makeReq(dir, 'onex', 'beta', '# beta')
    db.syncProjects()

    assert.equal(db.get('alpha')?.status, '已完成')
    assert.ok(db.get('beta'))
    db.close()
  })

  test('目录消失 → 标记失联但不丢状态', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.setStatus('alpha', 'Review')

    rmSync(join(dir, 'onex', 'alpha'), { recursive: true, force: true })
    const sync = db.syncProjects()
    assert.ok(sync.missing.includes('onex/alpha'))
    assert.equal(db.get('alpha')?.status, 'Review', '失联仍需可查且状态不丢')
    db.close()
  })

  test('目录恢复 → 从失联状态恢复', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    rmSync(join(dir, 'onex', 'alpha'), { recursive: true, force: true })
    db.syncProjects()

    makeReq(dir, 'onex', 'alpha', '# alpha')
    const sync = db.syncProjects()
    assert.ok(sync.restored.includes('onex/alpha'))
    db.close()
  })

  test('重复同步幂等', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha')
      makeReq(d, 'onex', 'beta', '# beta')
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()
    const first = JSON.stringify(db.list())
    db.syncProjects()
    db.syncProjects()
    assert.equal(JSON.stringify(db.list()), first)
    db.close()
  })

  test('新记录一律从「澄清」起步', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.equal(db.get('alpha')?.status, '澄清')
    db.close()
  })

  test('老库升级：补出 parent_id 列，已有需求的状态不被同步覆盖', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\n甲', { id: 'req-alpha' }))
    // 造一个没有 parent_id 的老库（这次改动之前的表结构）。
    // orphan 是有意留的旧列名——它正是这轮要迁移掉的，跟着改成 missing 就测不到迁移了
    const old = new DatabaseSync(join(dir, 'easy-flow.db'))
    old.exec(`CREATE TABLE requirement (
      slug TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', id TEXT, title TEXT NOT NULL,
      path TEXT NOT NULL, status TEXT NOT NULL, priority TEXT, summary TEXT, repos TEXT, links TEXT,
      feishu_task_links TEXT, code_links TEXT, ext_links TEXT, mtime INTEGER NOT NULL DEFAULT 0,
      updated TEXT, orphan INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (slug, project))`)
    old
      .prepare(
        `INSERT INTO requirement (slug, project, id, title, path, status, mtime)
         VALUES ('alpha', 'onex', 'req-alpha', '标题', '/x', '已完成', 0)`,
      )
      .run()
    old.close()

    const db = new BoardDatabase(dir)
    db.syncProjects()
    const r = db.get('alpha', 'onex')!
    assert.equal(r.status, '已完成', '老库的状态是权威，同步不能动它')
    assert.equal(r.parentId, '')
    db.close()
  })
})

// ------------------------------------------------------------ 数据层：待办

/** 造一条待办 md（<dataDir>/_todos/<id>.md） */
function makeTodo(dataDir: string, id: string, title: string, summary = '', progress = ''): string {
  const dir = join(dataDir, '_todos')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.md`)
  writeFileSync(file, `# ${title}\n\n## 摘要\n\n${summary}\n\n## 进度\n\n${progress}\n`, 'utf8')
  return file
}

describe('数据层 · 待办同步', () => {
  test('首次同步识别待办：标题取 H1、摘要取「摘要」段', () => {
    const dir = fresh((d) => {
      makeTodo(d, 'T-20260101-001', '统计失败原因分布', '动作：按错误码统计。完成标准：给出占比。')
    })
    const db = new BoardDatabase(dir)
    const sync = db.syncTodos()
    assert.deepEqual(sync.added, ['T-20260101-001'])

    const t = db.todoById('T-20260101-001')!
    assert.equal(t.title, '统计失败原因分布')
    assert.equal(t.summary, '动作：按错误码统计。完成标准：给出占比。')
    assert.equal(t.status, 'todo', '新条目一律从 todo 起步')
    assert.equal(t.path, join(dir, '_todos', 'T-20260101-001.md'))
    db.close()
  })

  test('★ 同步不覆盖已有状态与来源', () => {
    const dir = fresh((d) => makeTodo(d, 'T-20260101-001', '原标题', '原摘要'))
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.setTodoStatus('T-20260101-001', 'in_progress')
    db.setTodoFields('T-20260101-001', { source: 'chat', session: 'codex://threads/x' })

    // agent 重写了 md：标题与摘要跟着变，状态与来源必须还在
    makeTodo(dir, 'T-20260101-001', '新标题', '新摘要')
    db.syncTodos()

    const t = db.todoById('T-20260101-001')!
    assert.equal(t.title, '新标题')
    assert.equal(t.summary, '新摘要')
    assert.equal(t.status, 'in_progress', '状态是库的权威，同步不能动它')
    assert.equal(t.source, 'chat')
    assert.equal(t.session, 'codex://threads/x')
    db.close()
  })

  test('md 消失 → 标记失联；恢复 → 复原', () => {
    const dir = fresh((d) => makeTodo(d, 'T-20260101-001', '会消失的待办'))
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.setTodoStatus('T-20260101-001', 'done')

    rmSync(join(dir, '_todos', 'T-20260101-001.md'))
    const gone = db.syncTodos()
    assert.deepEqual(gone.missing, ['T-20260101-001'])
    assert.equal(db.todoById('T-20260101-001')!.missing, true)
    assert.equal(db.todoById('T-20260101-001')!.status, 'done', 'md 失联也要保住状态')

    makeTodo(dir, 'T-20260101-001', '又回来了')
    const back = db.syncTodos()
    assert.deepEqual(back.restored, ['T-20260101-001'])
    assert.equal(db.todoById('T-20260101-001')!.missing, false)
    db.close()
  })

  test('nextTodoId 按当天递增，与需求目录互不干扰', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\nA')
      makeTodo(d, 'T-20200101-009', '历史条目')
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.syncTodos()

    const first = db.nextTodoId()
    assert.match(first, /^T-\d{8}-001$/, '当天还没有条目就从 001 起')
    db.addTodo({ id: first, title: '占位', path: join(dir, '_todos', `${first}.md`) })
    assert.equal(db.nextTodoId(), first.replace(/001$/, '002'))
    // 待办不进项目/需求表，也不受项目扫描影响
    assert.equal(db.listTodos().length, 2)
    assert.equal(db.listIn('onex').length, 1)
    db.close()
  })

  test('ref 去重键可反查；未知状态与来源被拒绝', () => {
    const dir = fresh((d) => makeTodo(d, 'T-20260101-001', '带 ref 的待办'))
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.setTodoFields('T-20260101-001', { ref: 'om_x1' })
    assert.equal(db.todoByRef('om_x1')!.id, 'T-20260101-001')
    assert.equal(db.todoByRef('om_x2'), undefined)

    assert.throws(() => db.setTodoStatus('T-20260101-001', 'doing' as never), /Unknown status/)
    assert.throws(() => db.setTodoFields('T-20260101-001', { source: 'mail' }), /Unknown source/)
    assert.throws(() => db.setTodoStatus('T-不存在', 'done'), /Todo not found/)
    db.close()
  })

  test('★ 需求指针：可挂可清，反查只出这条需求的，同步不动它', () => {
    const dir = fresh((d) => {
      makeTodo(d, 'T-20260101-001', '挂需求的待办')
      makeTodo(d, 'T-20260101-002', '没挂的待办')
    })
    const db = new BoardDatabase(dir)
    db.syncTodos()
    assert.equal(db.todoById('T-20260101-001')!.requirementId, '', '新条目没挂需求')

    db.setTodoFields('T-20260101-001', { requirementId: 'req-alpha' })
    assert.equal(db.todoById('T-20260101-001')!.requirementId, 'req-alpha')
    assert.deepEqual(db.listTodos('req-alpha').map((t) => t.id), ['T-20260101-001'])
    assert.deepEqual(db.listTodos('req-beta'), [])
    assert.equal(db.listTodos().length, 2, '不带参数仍是全部')

    // md 被重写后再同步：标题跟着变，指针不动——与状态同一套规矩
    makeTodo(dir, 'T-20260101-001', '改过标题的待办')
    db.syncTodos()
    assert.equal(db.todoById('T-20260101-001')!.title, '改过标题的待办')
    assert.equal(db.todoById('T-20260101-001')!.requirementId, 'req-alpha')

    db.setTodoFields('T-20260101-001', { requirementId: '' })
    assert.equal(db.todoById('T-20260101-001')!.requirementId, '', '空串表示摘掉指针')
    db.close()
  })

  test('writeTodoDoc 写回 md 并同步标题摘要回库', () => {
    const dir = fresh((d) => makeTodo(d, 'T-20260101-001', '原标题', '原摘要'))
    const db = new BoardDatabase(dir)
    db.syncTodos()
    db.writeTodoDoc('T-20260101-001', '# 改过的标题\n\n## 摘要\n\n改过的摘要\n')
    const t = db.todoById('T-20260101-001')!
    assert.equal(t.title, '改过的标题')
    assert.equal(t.summary, '改过的摘要')
    db.close()
  })
})

// ------------------------------------------------------------ 数据层：读写

describe('数据层 · 状态读写', () => {
  let dir: string
  let db: BoardDatabase

  before(() => {
    dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\n甲需求内容')
      makeReq(d, 'onex', 'beta', '# beta\n\n## 需求\n\n乙需求内容')
      makeReq(d, 'personal', 'gamma', '# gamma\n\n## 需求\n\n丙需求内容')
    })
    db = new BoardDatabase(dir)
    db.syncProjects()
    // 显式指定项目，避免自动选择随夹具变化漂移
    db.setProject('onex')
  })

  after(() => db.close())

  test('setStatus 接受四个看板状态', () => {
    for (const s of ['澄清', '执行中', 'Review', '已完成'] as const) {
      db.setStatus('alpha', s)
      assert.equal(db.get('alpha')?.status, s)
    }
  })

  test('未知状态/优先级被拒绝', () => {
    assert.throws(() => db.setStatus('alpha', 'Done' as never), /Unknown status/)
    assert.throws(() => db.setStatus('alpha', '开发中' as never), /Unknown status/)
    assert.throws(() => db.setPriority('alpha', 'high' as never), /Unknown priority/)
  })

  test('setStatus/setPriority 会更新 updated 字段', () => {
    const before = db.get('alpha')?.updated
    db.setStatus('alpha', '执行中')
    assert.match(db.get('alpha')?.updated ?? '', /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(before !== undefined)
  })

  test('操作不存在的需求会报错', () => {
    assert.throws(() => db.setStatus('nope', '澄清'), /Requirement not found/)
    assert.throws(() => db.setPriority('nope', 'p0'), /Requirement not found/)
    assert.throws(() => db.rename('nope', 'x'), /Requirement not found/)
  })

  test('项目隔离：同名需求互不干扰', () => {
    makeReq(dir, 'personal', 'alpha', '# personal alpha\n\n## 需求\n\n另一个 alpha')
    db.syncProjects()
    db.setStatus('alpha', 'Review', 'onex')
    const inOnex = db.get('alpha', 'onex')
    const inPersonal = db.get('alpha', 'personal')
    assert.equal(inOnex?.status, 'Review')
    assert.notEqual(inPersonal?.status, 'Review')
    db.setProject('onex')
  })

  test('list 只返回当前项目', () => {
    db.setProject('onex')
    assert.ok(db.list().every((r) => r.project === 'onex'))
    db.setProject('personal')
    assert.ok(db.list().every((r) => r.project === 'personal'))
    db.setProject('onex')
  })

  test('search 限定当前项目且支持中文与多词 AND', () => {
    db.setProject('onex')
    assert.ok(db.search('甲需求').has('alpha'))
    assert.ok(db.search('乙需求').has('beta'))
    assert.equal(db.search('甲需求 乙需求').size, 0, '多词是 AND 语义')
    assert.equal(db.search('不存在的词xyz').size, 0)
  })

  test('context 返回需求与文档全文', () => {
    const ctx = db.context('alpha', 'onex')
    assert.ok(ctx)
    assert.equal(ctx.requirement.slug, 'alpha')
    assert.ok(Array.isArray(ctx.docs))
    assert.equal(db.context('nope', 'onex'), null)
  })

  test('tree 返回所有项目及其需求', () => {
    const tree = db.tree()
    const slugs = tree.map((t) => t.slug).sort()
    assert.ok(slugs.includes('onex') && slugs.includes('personal'))
    const onex = tree.find((t) => t.slug === 'onex')
    assert.ok(onex && onex.requirements.length >= 2)
  })
})

// ---------------------------------------------------------- 数据层：链接字段

describe('数据层 · 链接字段', () => {
  test('normalizeLinkList 校验协议并去重', () => {
    assert.deepEqual(normalizeLinkList(['https://a.com', 'https://a.com']), ['https://a.com'])
    assert.throws(() => normalizeLinkList(['ftp://a.com']), /http/)
    assert.throws(() => normalizeLinkList(['not-a-url']), /http/)
    assert.throws(() => normalizeLinkList('str' as never), /array/)
  })

  test('normalizeExtLinks 要求 detail 与 url 成对', () => {
    const ok = normalizeExtLinks([{ detail: '设计', url: 'https://a.com' }])
    assert.deepEqual(ok, [{ detail: '设计', url: 'https://a.com' }])
    assert.throws(() => normalizeExtLinks([{ detail: '缺链接' }]), /missing a url/)
    assert.throws(() => normalizeExtLinks([{ url: 'https://a.com' }]), /missing a detail/)
  })

  test('normalizeCodeLinks 收别名与老格式，按 url 去重', () => {
    assert.deepEqual(
      normalizeCodeLinks([
        'https://gitlab.com/mr/1',
        { label: '主流程', url: 'https://gitlab.com/mr/2' },
        { label: '重复的那条', url: 'https://gitlab.com/mr/1' },
      ]),
      [
        { label: '', url: 'https://gitlab.com/mr/1' },
        { label: '主流程', url: 'https://gitlab.com/mr/2' },
      ],
    )
    assert.throws(() => normalizeCodeLinks([{ label: 'x', url: 'ftp://a.com' }]), /http/)
    assert.throws(() => normalizeCodeLinks('str' as never), /array/)
  })

  test('setLinks 部分更新，未传的字段不动', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()

    db.setLinks('alpha', { feishuTaskLinks: ['https://feishu.cn/1'] })
    db.setLinks('alpha', { codeLinks: ['https://gitlab.com/mr/1'] })

    const req = db.get('alpha')
    assert.deepEqual(req?.feishuTaskLinks, ['https://feishu.cn/1'])
    assert.deepEqual(req?.codeLinks, [{ label: '', url: 'https://gitlab.com/mr/1' }])
    assert.deepEqual(req?.extLinks, [])
    db.close()
  })

  test('读库认老格式：字符串数组当成没别名的链接', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.close()

    const raw = new DatabaseSync(join(dir, 'easy-flow.db'))
    raw.exec(`update requirement set code_links = '["https://gitlab.com/mr/9"]'`)
    raw.close()

    const again = new BoardDatabase(dir)
    again.syncProjects()
    assert.deepEqual(again.get('alpha')?.codeLinks, [{ label: '', url: 'https://gitlab.com/mr/9' }])
    again.close()
  })

  test('新需求默认空链接数组', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    const req = db.get('alpha')
    assert.deepEqual(req?.feishuTaskLinks, [])
    assert.deepEqual(req?.codeLinks, [])
    assert.deepEqual(req?.extLinks, [])
    db.close()
  })
})

// ------------------------------------------------------ 渲染层：代码链接别名

describe('渲染层 · 代码链接别名', () => {
  test('显式别名优先', () => {
    assert.equal(codeLinkLabel({ label: '主流程', url: 'https://gitlab.com/mr/1' }), '主流程')
  })

  test('GitLab MR 推成 "<仓库> !<iid>"', () => {
    assert.equal(
      codeLinkLabel({
        label: '',
        url: 'http://git.dev.sh.ctripcorp.com/flight-onex/flight-onex-exchange-router/-/merge_requests/213',
      }),
      'flight-onex-exchange-router !213',
    )
  })

  test('GitHub PR 推成 "<仓库> #<iid>"', () => {
    assert.equal(codeLinkLabel({ label: '', url: 'https://github.com/owner/repo/pull/12' }), 'repo #12')
  })

  test('其余取路径末段，没有路径就用整条 URL', () => {
    assert.equal(codeLinkLabel({ label: '', url: 'https://example.com/a/b/' }), 'b')
    assert.equal(codeLinkLabel({ label: '', url: 'https://example.com' }), 'example.com')
  })
})

describe('渲染层 · 飞书任务别名', () => {
  test('去掉域名与详情页那段，只留认得出是哪条的路径', () => {
    assert.equal(
      feishuTaskLabel('https://project.feishu.cn/onex/story/detail/6712345678901234567'),
      'onex/story/6712345678901234567',
    )
  })

  test('查询串与结尾斜杠不影响', () => {
    assert.equal(feishuTaskLabel('https://project.feishu.cn/onex/story/detail/123?from=chat'), 'onex/story/123')
    assert.equal(feishuTaskLabel('https://project.feishu.cn/onex/story/detail/123/'), 'onex/story/123')
  })

  test('没有路径就退回整条 URL，不给空文案', () => {
    assert.equal(feishuTaskLabel('https://project.feishu.cn'), 'https://project.feishu.cn')
  })
})

describe('配置 · 面板快捷键', () => {
  test('writeConfig 合并写入：改快捷键不冲掉数据目录，反过来也一样', () => {
    const d = fresh(() => {})
    const file = join(d, 'config.json')
    const prev = process.env.EASY_FLOW_CONFIG
    process.env.EASY_FLOW_CONFIG = file
    try {
      writeConfig({ dataDir: join(d, 'data') })
      writeConfig({ panelShortcut: 'Command+Shift+K' })
      assert.equal(readConfig().panelShortcut, 'Command+Shift+K')
      assert.equal(readConfig().dataDir, join(d, 'data'), '写快捷键不能把数据目录冲掉')

      writeConfig({ dataDir: join(d, 'data2') })
      assert.equal(readConfig().panelShortcut, 'Command+Shift+K', '改数据目录也不能把快捷键冲掉')

      // 没配过就是空串，由主进程回落到默认
      writeConfig({ panelShortcut: '' })
      assert.equal(readConfig().panelShortcut, '')
    } finally {
      if (prev === undefined) delete process.env.EASY_FLOW_CONFIG
      else process.env.EASY_FLOW_CONFIG = prev
    }
  })
})

describe('渲染层 · 列表选中', () => {
  const KEYS = ['a', 'b', 'b|detail', 'c']

  test('选中的 key 还在就原样用', () => {
    assert.equal(resolveKey(KEYS, 'b|detail'), 'b|detail')
    assert.equal(resolveKey(KEYS, 'b'), 'b')
  })

  test('选中随父需求收起被删：退回父需求那一行，而不是跳回列表头', () => {
    // b 收起后动作行 'b|detail' 不在列表里了
    assert.equal(resolveKey(['a', 'b', 'c'], 'b|detail'), 'b')
  })

  test('父需求也没了（被过滤掉）就落到第一条；空列表给空串', () => {
    assert.equal(resolveKey(['a', 'c'], 'b|detail'), 'a')
    assert.equal(resolveKey(['a', 'c'], ''), 'a')
    assert.equal(resolveKey([], 'b'), '')
  })

  test('上下移动按当前列表走，到头不动', () => {
    assert.equal(moveKey(KEYS, 'a', 1), 'b')
    assert.equal(moveKey(KEYS, 'b', -1), 'a')
    assert.equal(moveKey(KEYS, 'c', 1), 'c', '最后一条再往下还是它')
    assert.equal(moveKey(KEYS, 'a', -1), 'a')
  })

  test('移动前先解析：选中的子行已随父收起时，从父行继续走', () => {
    assert.equal(moveKey(['a', 'b', 'c'], 'b|detail', 1), 'c')
    assert.equal(moveKey(['a', 'b', 'c'], 'b|detail', -1), 'a')
  })
})

describe('渲染层 · 时间', () => {
  test('parseStamp 认库里的 "yyyy-mm-dd HH:mm"，认不出给 0', () => {
    const t = parseStamp('2026-10-10 15:12')
    const d = new Date(t)
    assert.equal(d.getFullYear(), 2026)
    assert.equal(d.getMonth(), 9)
    assert.equal(d.getDate(), 10)
    assert.equal(d.getHours(), 15)
    assert.equal(parseStamp(''), 0)
    assert.equal(parseStamp('不是时间'), 0)
  })

  test('relTime 按天给相对说法', () => {
    const now = Date.now()
    assert.equal(relTime(now), '今天')
    assert.equal(relTime(now - 86400000), '昨天')
    assert.equal(relTime(now - 3 * 86400000), '3 天前')
    assert.equal(relTime(now - 60 * 86400000), '2 个月前')
  })
})

describe('渲染层 · 快捷键', () => {
  const ev = (key: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}) => ({
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  })

  test('键盘事件翻成 accelerator：mac 上 meta 是 Command', () => {
    assert.equal(acceleratorFromEvent(ev('e', { meta: true, shift: true }), 'darwin'), 'Command+Shift+E')
    assert.equal(acceleratorFromEvent(ev('e', { ctrl: true, shift: true }), 'darwin'), 'Control+Shift+E')
    assert.equal(acceleratorFromEvent(ev('e', { ctrl: true, shift: true }), 'win32'), 'Control+Shift+E')
    // 非 mac 的 meta 是 Super，不是 Command
    assert.equal(acceleratorFromEvent(ev('e', { meta: true }), 'win32'), 'Super+E')
  })

  test('具名键与功能键进白名单，其它键拒绝', () => {
    assert.equal(acceleratorFromEvent(ev(' ', { meta: true }), 'darwin'), 'Command+Space')
    assert.equal(acceleratorFromEvent(ev('ArrowUp', { meta: true }), 'darwin'), 'Command+Up')
    assert.equal(acceleratorFromEvent(ev('F5', { meta: true }), 'darwin'), 'Command+F5')
    assert.equal(acceleratorFromEvent(ev('F25', { meta: true }), 'darwin'), '')
    assert.equal(acceleratorFromEvent(ev('Dead', { meta: true }), 'darwin'), '')
  })

  test('没有 ⌘ / ⌃ / ⌥ 的组合不接受：只有 Shift 会吃掉日常打字', () => {
    assert.equal(acceleratorFromEvent(ev('e'), 'darwin'), '')
    assert.equal(acceleratorFromEvent(ev('e', { shift: true }), 'darwin'), '')
  })

  test('accelerator 显示成人看的写法', () => {
    assert.equal(formatAccelerator('CommandOrControl+Shift+E', 'darwin'), '⌘⇧E')
    assert.equal(formatAccelerator('CommandOrControl+Shift+E', 'win32'), 'Ctrl+Shift+E')
    assert.equal(formatAccelerator('Control+Alt+ArrowUp', 'darwin'), '⌃⌥↑')
    assert.equal(formatAccelerator('Control+Alt+ArrowUp', 'win32'), 'Ctrl+Alt+ArrowUp')
  })
})

// ------------------------------------------------------------ 渲染层：父子

describe('渲染层 · 子需求完成度', () => {
  const req = (slug: string, id: string, parentId: string, status: string): Requirement =>
    ({ slug, id, parentId, status }) as Requirement

  test('按父需求 id 归并，只数直接子需求', () => {
    const stats = childStatsOf([
      req('parent', 'req-p', '', '执行中'),
      req('parent/a', 'req-a', 'req-p', '已完成'),
      req('parent/b', 'req-b', 'req-p', 'Review'),
      req('parent/b/grand', 'req-g', 'req-b', '已完成'),
    ])
    // 孙需求算在中间那层头上，不越级加到 parent
    assert.deepEqual(stats.get('req-p'), { total: 2, done: 1 })
    assert.deepEqual(stats.get('req-b'), { total: 1, done: 1 })
  })

  test('没有子需求的需求不在表里，卡片据此决定收不收窄', () => {
    const stats = childStatsOf([req('alpha', 'req-a', '', '执行中')])
    assert.equal(stats.has('req-a'), false)
    assert.equal(stats.size, 0)
  })

  test('终态只有「已完成」算完成', () => {
    const stats = childStatsOf([
      req('parent', 'req-p', '', '执行中'),
      req('parent/a', 'req-a', 'req-p', 'Review'),
    ])
    assert.deepEqual(stats.get('req-p'), { total: 1, done: 0 })
  })
})

describe('渲染层 · 子需求清单', () => {
  const req = (slug: string, id: string, parentId: string, status: string): Requirement =>
    ({ slug, id, parentId, status }) as Requirement

  test('按父需求 id 归并出直接子需求，孙需求不越级', () => {
    const map = childrenOf([
      req('parent', 'req-p', '', '执行中'),
      req('parent/a', 'req-a', 'req-p', '已完成'),
      req('parent/b', 'req-b', 'req-p', 'Review'),
      req('parent/b/grand', 'req-g', 'req-b', '已完成'),
    ])
    assert.deepEqual(
      map.get('req-p')?.map((r) => r.slug),
      ['parent/b', 'parent/a'],
    )
    assert.deepEqual(
      map.get('req-b')?.map((r) => r.slug),
      ['parent/b/grand'],
    )
  })

  test('未完成的排前面，同档保持原顺序', () => {
    const map = childrenOf([
      req('parent/a', 'req-a', 'req-p', '已完成'),
      req('parent/b', 'req-b', 'req-p', '澄清'),
      req('parent/c', 'req-c', 'req-p', '已完成'),
      req('parent/d', 'req-d', 'req-p', '执行中'),
    ])
    assert.deepEqual(
      map.get('req-p')?.map((r) => r.slug),
      ['parent/b', 'parent/d', 'parent/a', 'parent/c'],
    )
  })

  test('没有子需求的需求不在表里', () => {
    const map = childrenOf([req('alpha', 'req-a', '', '执行中')])
    assert.equal(map.size, 0)
  })
})

// ------------------------------------------------------------ 数据层：项目

describe('数据层 · 项目与规范', () => {
  test('目录出现即项目出现，重复同步幂等', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()

    // 创建入口已移除：agent 直接建目录，扫描自然发现
    mkdirSync(join(dir, 'demo', 'first'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'AGENTS.md'), '# 规范', 'utf8')
    writeFileSync(join(dir, 'demo', 'first', 'AGENTS.md'), '<!-- agent 指令 -->\n', 'utf8')
    writeFileSync(join(dir, 'demo', 'first', 'requirement.md'), '# 第一个需求\n', 'utf8')

    db.syncProjects()
    db.setProject('demo')
    assert.equal(db.list().length, 1)
    assert.equal(db.list()[0].title, '第一个需求')

    const before = JSON.stringify(db.list())
    db.syncProjects()
    assert.equal(JSON.stringify(db.list()), before)
    db.close()
  })

  test('显示名取项目根 AGENTS.md 的 frontmatter，缺省用目录名', () => {
    const dir = fresh((d) => {
      mkdirSync(join(d, 'onex'), { recursive: true })
      mkdirSync(join(d, 'plain'), { recursive: true })
      writeFileSync(join(d, 'onex', 'AGENTS.md'), '---\nname: 机票辅营对接\n---\n\n# 规范', 'utf8')
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()

    assert.equal(db.listProjects().find((p) => p.slug === 'onex')!.name, '机票辅营对接')
    assert.equal(db.listProjects().find((p) => p.slug === 'plain')!.name, 'plain')

    // agent 改了 frontmatter，下一次同步就该生效
    writeFileSync(join(dir, 'onex', 'AGENTS.md'), '---\nname: 改过了\n---\n\n# 规范', 'utf8')
    db.syncProjects()
    assert.equal(db.listProjects().find((p) => p.slug === 'onex')!.name, '改过了')
    db.close()
  })

  test('目录不合规范只提示，不拦截任何操作', () => {
    const dir = fresh((d) => {
      mkdirSync(join(d, 'Demo_Project', 'scratch'), { recursive: true })
      mkdirSync(join(d, 'Demo_Project', '_inbox'), { recursive: true })
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()

    const p = db.listProjects()[0]
    assert.equal(p.slug, 'Demo_Project')
    assert.ok(
      p.issues.some((i) => /目录名/.test(i)),
      '大写/下划线应被提示',
    )
    assert.ok(p.issues.some((i) => /缺少项目规范/.test(i)))
    assert.ok(p.issues.some((i) => /scratch/.test(i)))
    assert.ok(
      !p.issues.some((i) => /_inbox/.test(i)),
      '_inbox 是约定的收纳处，不该报',
    )

    // 提示而已：仍能切换、仍在树里、scratch 也没变成需求
    db.setProject('Demo_Project')
    assert.equal(db.project, 'Demo_Project')
    assert.equal(db.tree().length, 1)
    assert.equal(db.list().length, 0)
    db.close()
  })

  test('首次同步生成模板，且不覆盖已有内容', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()

    const tpl = join(dir, '_templates')
    assert.ok(existsSync(join(tpl, 'project', 'AGENTS.md')))
    assert.ok(existsSync(join(tpl, 'requirement', 'AGENTS.md')))
    assert.ok(existsSync(join(tpl, 'requirement', 'requirement.md')))
    assert.ok(
      !db.listProjects().some((p) => p.slug === '_templates'),
      '模板目录不该被当成项目',
    )

    writeFileSync(join(tpl, 'requirement', 'AGENTS.md'), '# 自定义模板', 'utf8')
    db.syncProjects()
    assert.equal(readFileSync(join(tpl, 'requirement', 'AGENTS.md'), 'utf8'), '# 自定义模板')
    db.close()
  })

  test('复制需求模板建出的需求可被正常解析', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha')
      writeFileSync(join(d, 'onex', 'AGENTS.md'), '# 项目规范', 'utf8')
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()

    cpSync(join(dir, '_templates', 'requirement'), join(dir, 'onex', 'from-template'), {
      recursive: true,
    })
    const desc = join(dir, 'onex', 'from-template', 'requirement.md')
    // 占位文案本身会变，这里只认「H1 那一行」
    writeFileSync(desc, readFileSync(desc, 'utf8').replace(/^# .*$/m, '# 抄模板建的需求'), 'utf8')
    db.syncProjects()

    const r = db.list().find((x) => x.slug === 'from-template')!
    assert.equal(r.title, '抄模板建的需求')
    assert.equal(r.status, '澄清')
    assert.ok(r.summary.length > 0, '「需求」段应能被取成摘要')
    assert.deepEqual(r.repos, [], '空表格不该产生假仓库')
    assert.deepEqual(db.listProjects().find((p) => p.slug === 'onex')!.issues, [])
    db.close()
  })

  test('软链目录不算需求（worktree 里也会带需求文档）', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha')
      // 工位里的软链指向代码仓 worktree，而 worktree 里同样有这两份文件
      symlinkSync(join(d, 'onex', 'alpha'), join(d, 'onex', 'agg'), 'dir')
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()

    assert.equal(db.list().length, 1, '软链不该被当成第二个需求')
    assert.equal(db.list()[0].slug, 'alpha')
    db.close()
  })

  test('复制项目模板建出的项目就合规', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()

    cpSync(join(dir, '_templates', 'project'), join(dir, 'demo'), { recursive: true })
    db.syncProjects()

    const p = db.listProjects().find((x) => x.slug === 'demo')!
    assert.equal(p.name, 'demo', 'frontmatter 里 name 留空时退回目录名')
    assert.deepEqual(p.issues, [], '照模板建出来就应合规')

    writeFileSync(
      join(dir, 'demo', 'AGENTS.md'),
      '---\nname: 演示项目\n---\n\n# 项目规范\n',
      'utf8',
    )
    db.syncProjects()
    assert.equal(db.listProjects().find((x) => x.slug === 'demo')!.name, '演示项目')
    db.close()
  })

  test('deleteProject 只删记录时保留磁盘目录', () => {
    const dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha')
      makeReq(d, 'demo', 'x', '# x')
    })
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.deleteProject('demo')
    assert.ok(!db.listProjects().some((p) => p.slug === 'demo'))
    assert.ok(existsSync(join(dir, 'demo')), '磁盘目录应保留')
    db.close()
  })

  test('项目总规范读写', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()

    assert.equal(db.listProjects()[0].hasConvention, false)
    db.writeProjectConvention('onex', '# 项目规范\n\n约定内容')
    db.syncProjects()

    const p = db.listProjects().find((x) => x.slug === 'onex')!
    assert.equal(p.hasConvention, true)
    assert.match(p.convention ?? '', /约定内容/)
    assert.equal(readFileSync(join(dir, 'onex', 'AGENTS.md'), 'utf8'), '# 项目规范\n\n约定内容')
    db.close()
  })
})

// ---------------------------------------------------------------- 创建

describe('创建 · 目录与模板', () => {
  test('createProjectDir 建目录、写入显示名，同步后能认出项目', () => {
    const dir = fresh(() => {})
    const root = createProjectDir(dir, 'demo', '示例项目')
    assert.equal(root, join(dir, 'demo'))
    assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /^name: 示例项目$/m)
    assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /见 easy-flow skill/)

    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.equal(db.listProjects().find((p) => p.slug === 'demo')?.name, '示例项目')
    db.close()
  })

  test('createProjectDir 拒绝非法标识与已存在的目录', () => {
    const dir = fresh(() => {})
    assert.throws(() => createProjectDir(dir, 'Bad_Slug'), /lowercase letters/)
    createProjectDir(dir, 'demo')
    assert.throws(() => createProjectDir(dir, 'demo'), /already exists/)
  })

  test('createRequirementDir 写齐三份文件，id 落在 AGENTS.md', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const created = createRequirementDir(join(dir, 'onex'), 'cny-not-rmb', '币种改 CNY', '上游只认 CNY')
    // 身份 + 文件说明在 AGENTS.md，需求描述在 requirement.md，进展脚手架在 context.md
    assert.ok(existsSync(join(created.dir, 'context.md')))
    const agents = readFileSync(join(created.dir, 'AGENTS.md'), 'utf8')
    assert.match(agents, new RegExp(`^---\\nid: ${created.id}\\n---$`, 'm'))
    assert.match(agents, /requirement\.md/)
    assert.match(agents, /见 easy-flow skill/)
    const desc = readFileSync(join(created.dir, 'requirement.md'), 'utf8')
    assert.ok(!desc.includes('id:'))
    assert.match(desc, /^# 币种改 CNY$/m)
    assert.match(desc, /## 需求\n\n上游只认 CNY/)
    // 澄清阶段要求讲清验收边界，模板给它固定位置
    assert.match(desc, /## 验收/)
    assert.match(desc, /## 需求[\s\S]*## 验收[\s\S]*## 涉及仓库/)

    const db = new BoardDatabase(dir)
    db.syncProjects()
    const r = db.list().find((x) => x.slug === 'cny-not-rmb')!
    assert.equal(r.id, created.id)
    assert.equal(r.title, '币种改 CNY')
    assert.equal(r.summary, '上游只认 CNY')
    assert.equal(r.status, '澄清')
    assert.equal(db.byId(created.id)?.slug, 'cny-not-rmb')
    db.close()
  })

  test('createRequirementDir 拒绝非法标识与已存在的目录', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const root = join(dir, 'onex')
    assert.throws(() => createRequirementDir(root, '中文名', 'x'), /lowercase letters/)
    createRequirementDir(root, 'alpha', 'x')
    assert.throws(() => createRequirementDir(root, 'alpha', 'x'), /already exists/)
  })

  test('setRequirementId 只动 frontmatter，正文原样保留', () => {
    const dir = fresh(() => {})
    const reqDir = join(dir, 'onex', 'legacy')
    mkdirSync(reqDir, { recursive: true })
    writeFileSync(join(reqDir, 'AGENTS.md'), '<!-- 指令 -->\n', 'utf8')
    writeFileSync(join(reqDir, 'requirement.md'), '# 老需求\n\n## 需求\n\n正文不能动。\n', 'utf8')

    setRequirementId(reqDir, 'req-abc1234567')
    const after = readFileSync(join(reqDir, 'AGENTS.md'), 'utf8')
    assert.equal(after, '---\nid: req-abc1234567\n---\n\n<!-- 指令 -->\n')
    // requirement.md 一个字都不该动
    assert.equal(
      readFileSync(join(reqDir, 'requirement.md'), 'utf8'),
      '# 老需求\n\n## 需求\n\n正文不能动。\n',
    )

    // 再补一次：幂等，不叠加 frontmatter
    setRequirementId(reqDir, 'req-abc1234567')
    assert.equal(readFileSync(join(reqDir, 'AGENTS.md'), 'utf8'), after)
  })

  test('子需求与父需求一样入库：slug 带层级、parent_id 指向父需求，任意深度', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const root = join(dir, 'onex')
    const parent = createRequirementDir(root, 'parent', '父需求')
    const child = createRequirementDir(parent.dir, 'child', '子需求')
    const grand = createRequirementDir(child.dir, 'grand', '孙需求')
    assert.ok(existsSync(join(child.dir, 'requirement.md')))

    const db = new BoardDatabase(dir)
    db.syncProjects()
    // slug 就是相对项目根的路径：子需求形如 parent/child
    assert.deepEqual(
      db.list().map((r) => r.slug).sort(),
      ['parent', 'parent/child', 'parent/child/grand'],
    )
    const c = db.get('parent/child', 'onex')!
    assert.equal(c.parentId, parent.id)
    assert.equal(c.path, child.dir)
    assert.equal(c.status, '澄清')
    // 任意深度：孙需求的父是中间那层
    assert.equal(db.get('parent/child/grand', 'onex')!.parentId, child.id)
    // 按 id 反查对子需求同样成立
    assert.equal(db.byId(child.id)?.slug, 'parent/child')
    assert.equal(db.byId(grand.id)?.slug, 'parent/child/grand')
    // 父子两条查询
    assert.deepEqual(db.children(parent.id).map((r) => r.slug), ['parent/child'])
    assert.deepEqual(db.ancestors(c).map((r) => r.slug), ['parent'])
    assert.deepEqual(
      db.ancestors(db.get('parent/child/grand', 'onex')!).map((r) => r.slug),
      ['parent/child', 'parent'],
    )
    db.close()
  })

  test('子需求的状态与优先级独立维护，父需求不受影响', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const parent = createRequirementDir(join(dir, 'onex'), 'parent', '父需求')
    createRequirementDir(parent.dir, 'child', '子需求')

    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.setStatus('parent/child', '执行中', 'onex')
    db.setPriority('parent/child', 'p1', 'onex')
    assert.equal(db.get('parent/child', 'onex')!.status, '执行中')
    assert.equal(db.get('parent/child', 'onex')!.priority, 'p1')
    assert.equal(db.get('parent', 'onex')!.status, '澄清')
    // 同步是幂等的，也不会把子需求的状态刷掉
    db.syncProjects()
    assert.equal(db.get('parent/child', 'onex')!.status, '执行中')
    db.close()
  })

  test('子需求的文件不进父需求的文档索引', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const parent = createRequirementDir(join(dir, 'onex'), 'parent', '父需求')
    createRequirementDir(parent.dir, 'child', '子需求')

    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.deepEqual(
      db.get('parent', 'onex')?.docs.map((d) => d.name),
      ['context.md', 'requirement.md'],
    )
    db.close()
  })

  test('指令文件不进文档索引：嵌套的 AGENTS.md / CLAUDE.md 也不收', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const parent = createRequirementDir(join(dir, 'onex'), 'parent', '父需求')
    // 嵌套的施工目录：只有 AGENTS.md，不算需求目录，但它照样是指令文件
    const task = join(parent.dir, 'tasks', 'step-1')
    mkdirSync(task, { recursive: true })
    writeFileSync(join(task, 'AGENTS.md'), '<!-- 指令 -->\n', 'utf8')
    writeFileSync(join(task, 'CLAUDE.md'), '# 指令\n', 'utf8')
    writeFileSync(join(task, 'plan.md'), '# 计划\n', 'utf8')

    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.deepEqual(
      db.get('parent', 'onex')?.docs.map((d) => d.name),
      ['context.md', 'requirement.md', 'tasks/step-1/plan.md'],
    )
    db.close()
  })

  test('复制需求目录撞出重复 id 时同步不炸，重复的那个落进 missingIds', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const root = join(dir, 'onex')
    const alpha = createRequirementDir(root, 'alpha', '甲需求')
    cpSync(alpha.dir, join(root, 'alpha-copy'), { recursive: true })

    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.equal(db.get('alpha', 'onex')?.id, alpha.id)
    assert.equal(db.get('alpha-copy', 'onex')?.id, '')
    assert.deepEqual(db.missingIds().map((r) => r.slug), ['alpha-copy'])
    db.close()
  })
})

// ------------------------------------------------------------------ CLI

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(REPO_ROOT, 'server', 'cli.ts')

/**
 * Run a real CLI process. server/cli.ts is an entry script (importing it executes), so it
 * cannot be called in-process — spawn it as a subprocess, which is also how humans and
 * agents use it.
 */
function cli(
  configFile: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env, EASY_FLOW_CONFIG: configFile }
  // identity must come from the caller only; keep leftover env from the test shell out
  delete env.EASY_FLOW_PROJECT
  delete env.EASY_FLOW_REPO_ROOTS
  // 会话 id 同理：测试机自己可能就开在某个 agent 会话里，别让它替用例答话
  for (const name of ['CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID']) {
    delete env[name]
  }
  Object.assign(env, extraEnv)
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** One successful call; returns stdout */
function cliOk(configFile: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const r = cli(configFile, args, extraEnv)
  assert.equal(r.code, 0, `expected success: easy-flow ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}

/**
 * 当天待办 id。待办按本机日期编号（server/db.ts 的 localDay：人在哪儿，「今天」就是哪天），
 * 这里也必须按本机算——用 toISOString 取的是 UTC 日期，东八区后半夜（本地已跨天、UTC 还没）
 * 就取到昨天，整批用例跟着挂。
 */
function todayId(seq = '001'): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `T-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${seq}`
}

/** One failing call; returns the error text (stderr in text mode, usage included for usage errors) */
function cliFail(configFile: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const r = cli(configFile, args, extraEnv)
  assert.notEqual(r.code, 0, `expected failure: easy-flow ${args.join(' ')}\n${r.stdout}`)
  return r.stderr
}

// 与 TMP 同源：固定路径会让并行跑测试的两个工作区互删夹具
const GIT_TMP = `${TMP}-git`

/**
 * 造一个真仓库当夹具。worktree 至少要有一个 commit 才建得出来，
 * 所以这里连带写一次提交；git 身份用 -c 传，不依赖开发机的全局配置。
 */
function gitFixture(): { workspace: string; repo: string; repoName: string } {
  // 钩子进程可能还占着目录，删不干净就重试几次
  rmSync(GIT_TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  const workspace = join(GIT_TMP, 'workspace')
  const repoName = 'flight-onex-exchange-router'
  const repo = join(workspace, repoName)
  mkdirSync(repo, { recursive: true })
  const who = ['-c', 'user.name=test', '-c', 'user.email=test@test']
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  // 镜像真实仓库：身份文件与 CLAUDE.md 本就在 .gitignore 里
  writeFileSync(join(repo, '.gitignore'), 'AGENTS.md\nCLAUDE.md\n', 'utf8')
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf8')
  execFileSync('git', ['-C', repo, ...who, 'add', '-A'])
  execFileSync('git', ['-C', repo, ...who, 'commit', '-qm', 'init'])
  // macOS 的 /tmp 是软链，而 git 报的是真实路径（/private/tmp）：两边对齐才好断言
  return { workspace: realpathSync(workspace), repo: realpathSync(repo), repoName }
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args]).toString().trim()
}

describe('数据层 · worktree', () => {
  test('登记：path 是幂等键，id 与 created 不因重登而变', () => {
    const d = fresh(() => {
      makeReq(TMP, 'demo', 'alpha', '# alpha', { id: 'req-alpha' })
    })
    const db = new BoardDatabase(d)
    db.syncProjects()
    const req = db.get('alpha', 'demo')!

    const first = db.addWorktree({
      id: 'wt-0001',
      requirementId: req.id,
      short: 'router',
      repo: 'flight-onex-exchange-router',
      branch: 'feature-a',
      path: '/tmp/wt/a',
      main: '/tmp/repo/router',
    })
    assert.equal(first.created, first.updated)

    const again = db.addWorktree({
      id: 'wt-9999',
      requirementId: req.id,
      short: '',
      repo: 'other',
      branch: 'feature-b',
      path: '/tmp/wt/a',
      main: '/tmp/repo/other',
    })
    assert.equal(again.id, 'wt-0001')
    assert.equal(again.created, first.created)
    assert.equal(again.branch, 'feature-b')
    assert.equal(again.short, '')
    assert.equal(db.listWorktrees(req.id).length, 1)
    assert.equal(db.worktreeByPath('/tmp/wt/a')!.id, 'wt-0001')
    db.close()
  })

  test('目录消失标失联、回来即恢复，记录一直留着', () => {
    const d = fresh(() => {
      makeReq(TMP, 'demo', 'alpha', '# alpha', { id: 'req-alpha' })
    })
    const live = join(d, 'wt-live')
    mkdirSync(live, { recursive: true })
    const db = new BoardDatabase(d)
    db.syncProjects()
    const req = db.get('alpha', 'demo')!
    const base = { requirementId: req.id, repo: 'r', main: '/tmp/repo/r' }
    db.addWorktree({ ...base, id: 'wt-live', branch: 'b1', path: live })
    db.addWorktree({ ...base, id: 'wt-gone', branch: 'b2', path: join(d, 'wt-gone') })

    let sync = db.syncProjects()
    assert.deepEqual(sync.worktrees.missing, ['wt-gone'])
    assert.equal(db.worktreeById('wt-gone')!.missing, true)
    assert.equal(db.listWorktrees(req.id).length, 2)

    mkdirSync(join(d, 'wt-gone'), { recursive: true })
    sync = db.syncProjects()
    assert.deepEqual(sync.worktrees.restored, ['wt-gone'])
    assert.equal(db.worktreeById('wt-gone')!.missing, false)
    db.close()
  })

  test('删项目连带清掉它名下需求的 worktree 记录', () => {
    const d = fresh(() => {
      makeReq(TMP, 'demo', 'alpha', '# alpha', { id: 'req-alpha' })
      makeReq(TMP, 'other', 'beta', '# beta', { id: 'req-beta' })
    })
    const db = new BoardDatabase(d)
    db.syncProjects()
    const a = db.get('alpha', 'demo')!
    const b = db.get('beta', 'other')!
    db.addWorktree({ id: 'wt-a', requirementId: a.id, repo: 'r', branch: 'b', path: '/tmp/a', main: '/tmp/r' })
    db.addWorktree({ id: 'wt-b', requirementId: b.id, repo: 'r', branch: 'b', path: '/tmp/b', main: '/tmp/r' })

    db.deleteProject('demo')
    assert.equal(db.worktreeById('wt-a'), undefined)
    assert.equal(db.worktreeById('wt-b')!.id, 'wt-b')
    db.close()
  })
})

// ------------------------------------------------------------ 数据层：会话

describe('数据层 · 会话', () => {
  /** 造一条需求，返回它的 id */
  function seedReq(d: string, slug = 'alpha', project = 'demo'): string {
    makeReq(d, project, slug, `# ${slug}`, { id: `req-${slug}` })
    return `req-${slug}`
  }

  test('登记幂等：agent + 会话 id 是键，created 不变、字段刷新', () => {
    const d = fresh(() => seedReq(TMP))
    const db = new BoardDatabase(d)
    db.syncProjects()

    const first = db.addSession({
      requirementId: 'req-alpha',
      agent: 'codex',
      session: 'th-1',
      title: '看接口',
      cwd: '/tmp/a',
      link: 'codex://threads/th-1',
    })
    assert.equal(first.created, first.updated)

    const again = db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'th-1', title: '改了标题' })
    assert.equal(again.created, first.created, 'created 记的是第一次登记')
    assert.equal(again.title, '改了标题')
    assert.equal(again.cwd, '', '没传的字段按空刷新，不留旧值')
    assert.equal(db.listSessions('req-alpha').length, 1)
    db.close()
  })

  test('会话角色：缺省 dev，review 会话能单独认出来', () => {
    const d = fresh(() => seedReq(TMP))
    const db = new BoardDatabase(d)
    db.syncProjects()

    assert.equal(
      db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'th-dev' }).role,
      'dev',
      '开工登记的会话缺省是 dev',
    )
    assert.equal(
      db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'th-review', role: 'review' }).role,
      'review',
    )
    assert.deepEqual(
      db.listSessions('req-alpha').filter((s) => s.role === 'review').map((s) => s.session),
      ['th-review'],
      '复用 review 会话靠这一列认人',
    )

    // 同一个会话换角色登记是刷新，不会长出第二条
    assert.equal(
      db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'th-dev', role: 'review' }).role,
      'review',
    )
    assert.equal(db.listSessions('req-alpha').length, 2)

    assert.throws(
      () => db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'x', role: 'nope' as never }),
      /Unknown session role/,
    )
    db.close()
  })

  test('同一个会话改挂到别的需求：还是一条记录，跟着走', () => {
    const d = fresh(() => {
      seedReq(TMP, 'alpha')
      seedReq(TMP, 'beta')
    })
    const db = new BoardDatabase(d)
    db.syncProjects()
    db.addSession({ requirementId: 'req-alpha', agent: 'claude', session: 'local_x' })
    db.addSession({ requirementId: 'req-beta', agent: 'claude', session: 'local_x' })

    assert.deepEqual(db.listSessions('req-alpha'), [])
    assert.equal(db.listSessions('req-beta')[0].session, 'local_x')
    assert.equal(db.listSessions().length, 1)
    db.close()
  })

  test('listSessions 不传需求就是全部，最近更新的在前；removeSession 只删记录', () => {
    const d = fresh(() => {
      seedReq(TMP, 'alpha')
      seedReq(TMP, 'beta')
    })
    const db = new BoardDatabase(d)
    db.syncProjects()
    db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'a' })
    db.addSession({ requirementId: 'req-beta', agent: 'cursor', session: 'b' })
    assert.equal(db.listSessions().length, 2)

    assert.equal(db.removeSession('codex', 'a'), true)
    assert.equal(db.removeSession('codex', 'a'), false, '再删一次就没有了')
    assert.deepEqual(db.listSessions('req-alpha'), [])
    assert.equal(db.listSessions().length, 1)
    db.close()
  })

  test('未知 agent 与空会话 id 被拒', () => {
    const d = fresh(() => seedReq(TMP))
    const db = new BoardDatabase(d)
    db.syncProjects()
    assert.throws(
      () => db.addSession({ requirementId: 'req-alpha', agent: 'gemini' as never, session: 'x' }),
      /Unknown agent/,
    )
    assert.throws(() => db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: '  ' }), /cannot be empty/)
    db.close()
  })

  test('删项目连带清掉它名下需求的会话', () => {
    const d = fresh(() => {
      seedReq(TMP, 'alpha')
      seedReq(TMP, 'beta', 'other')
    })
    const db = new BoardDatabase(d)
    db.syncProjects()
    db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'a' })
    db.addSession({ requirementId: 'req-beta', agent: 'codex', session: 'b' })

    db.deleteProject('demo')
    assert.equal(db.listSessions('req-alpha').length, 0)
    assert.equal(db.listSessions('req-beta').length, 1)
    db.close()
  })
})

describe('CLI 层', () => {
  const base = `${TMP}-cli`
  const dataDir = join(base, 'data')
  const configFile = join(base, 'config.json')

  function scaffold(): string {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify({ dataDir }), 'utf8')
    return configFile
  }

  test('命令面：建项目与需求，缺上下文时报可读错误', () => {
    scaffold()
    assert.match(cliOk(configFile, ['project', 'new', 'demo', '--name', '示例项目']), /已创建项目「示例项目」/)
    assert.match(
      cliOk(configFile, [
        'req',
        'new',
        '支持 1A 重试',
        '--project',
        'demo',
        '--slug',
        'seat-retry',
        '--summary',
        '失败重试一次',
      ]),
      /需求 id：req-/,
    )
    // --project is required (or --parent); missing both is caught as a usage error
    const missing = cli(configFile, ['req', 'new', '没有项目上下文'])
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /Pass one of --project \/ --parent/)
    // root help lists the command groups; group help lists each subcommand
    const help = cliOk(configFile, ['--help'])
    for (const c of ['context', 'dir', 'project new', 'req new|set|link', 'wt new|rm', 'todo new|set|list']) {
      assert.ok(help.includes(c), `expected help to list ${c}:\n${help}`)
    }
    const reqHelp = cliOk(configFile, ['req', '--help'])
    for (const c of ['req new', 'req set', 'req link', 'req session']) assert.ok(reqHelp.includes(c), reqHelp)
    assert.ok(cliOk(configFile, ['req', 'session', 'review', '--help']).includes('--handoff'), 'review 的用法要能看到 --handoff')
    const wtHelp = cliOk(configFile, ['wt', '--help'])
    for (const c of ['wt new', 'wt rm']) assert.ok(wtHelp.includes(c), wtHelp)
    const todoHelp = cliOk(configFile, ['todo', '--help'])
    for (const c of ['todo new', 'todo set', 'todo list', 'todo show', 'todo import']) {
      assert.ok(todoHelp.includes(c), todoHelp)
    }

    const db = new BoardDatabase(dataDir)
    const r = db.get('seat-retry', 'demo')!
    assert.equal(r.title, '支持 1A 重试')
    assert.equal(r.status, '澄清')
    assert.match(r.id, /^req-/)
    assert.equal(db.listProjects().find((p) => p.slug === 'demo')?.name, '示例项目')
    db.close()
  })

  test('dir：报数据目录，只读——不开库也不补模板', () => {
    scaffold()
    assert.match(cliOk(configFile, ['dir']), new RegExp(`数据目录：${dataDir}`))
    const data = JSON.parse(cliOk(configFile, ['dir', '--json']))
    assert.equal(data.dataDir, dataDir)
    assert.equal(data.configPath, configFile)
    assert.equal(data.activeProject, '')
    // 只读的证据：数据目录还是空的（开库会建 easy-flow.db，sync 会补 _templates）
    assert.deepEqual(readdirSync(dataDir), [])
  })

  test('req new --parent：子需求建在父需求下，--project 与 --parent 互斥', () => {
    scaffold()
    cliOk(configFile, ['project', 'new', 'demo'])
    const parent = JSON.parse(
      cliOk(configFile, ['req', 'new', '父需求', '--project', 'demo', '--slug', 'alpha', '--json']),
    )
    const sub = JSON.parse(cliOk(configFile, ['req', 'new', '子需求', '--parent', parent.id, '--slug', 'sub', '--json']))
    assert.equal(sub.parent, parent.id)
    assert.match(sub.dir, /alpha\/sub$/)
    assert.equal(existsSync(join(sub.dir, 'requirement.md')), true)

    const both = cli(configFile, ['req', 'new', '两个都给', '--project', 'demo', '--parent', parent.id])
    assert.equal(both.code, 2)
    assert.match(both.stderr, /not both/)
  })

  test('req new 拦掉等于目录名的标题：那是把目录名当标题写，等于没说做什么', () => {
    scaffold()
    cliOk(configFile, ['project', 'new', 'demo'])

    const bad = cli(configFile, ['req', 'new', 'tf-meal-migration', '--project', 'demo'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /repeats the directory name/)
    // 拒绝发生在落盘之前：项目目录里还是只有它自己的 AGENTS.md
    assert.deepEqual(readdirSync(join(dataDir, 'demo')), ['AGENTS.md'])

    // 说清「在做什么」就放行，目录名照旧可以是个 slug
    const ok = JSON.parse(
      cliOk(configFile, ['req', 'new', 'TF 餐食迁移到新链路', '--project', 'demo', '--slug', 'tf-meal-migration', '--json']),
    )
    assert.equal(ok.slug, 'tf-meal-migration')

    // 子需求走同一套校验
    const sub = cli(configFile, ['req', 'new', 'tf-meal-migration', '--parent', ok.id])
    assert.equal(sub.code, 2)
    assert.match(sub.stderr, /repeats the directory name/)
  })

  test('--json：成功打数据可串联，失败也是 JSON 且退出码语义分明', () => {
    scaffold()
    cliOk(configFile, ['project', 'new', 'demo'])
    const made = JSON.parse(
      cliOk(configFile, ['req', 'new', '甲需求', '--project', 'demo', '--slug', 'alpha', '--json']),
    )
    assert.match(made.id, /^req-/)

    const moved = JSON.parse(cliOk(configFile, ['req', 'set', made.id, '--status', '执行中', '--json']))
    assert.equal(moved.status, '执行中')

    // runtime error: JSON on stdout, exit code 1
    const failed = cli(configFile, ['context', 'req-nope', '--json'])
    assert.equal(failed.code, 1)
    assert.match(JSON.parse(failed.stdout).error, /Requirement not found/)

    // usage error: JSON too, exit code 2
    const usage = cli(configFile, ['context', '--json'])
    assert.equal(usage.code, 2)
    assert.match(JSON.parse(usage.stdout).error, /Missing id/)
  })

  test('context 只按 id 反查：必须显式传，缺 id 报错', () => {
    scaffold()
    createProjectDir(dataDir, 'demo', '示例项目')
    writeFileSync(
      join(dataDir, 'demo', 'AGENTS.md'),
      '---\nname: 示例项目\n---\n\n# 项目规范\n\n先查 CK 再改代码。',
      'utf8',
    )
    const created = createRequirementDir(join(dataDir, 'demo'), 'csd-price', 'CSD 接 TF 标准价', '查价改走 TF')
    writeFileSync(join(created.dir, 'context.md'), '跟 supply 对了，TF 报价要除税。', 'utf8')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const byArg = cliOk(configFile, ['context', created.id])
    assert.match(byArg, new RegExp(`需求 id：${created.id}`))
    assert.match(byArg, /项目：demo（示例项目）/)
    assert.match(byArg, /需求：CSD 接 TF 标准价（csd-price）/)
    assert.match(byArg, /状态：澄清/)
    assert.match(byArg, /先查 CK 再改代码/)
    assert.match(byArg, /跟 supply 对了/)

    const noId = cli(configFile, ['context'])
    assert.equal(noId.code, 2)
    assert.match(noId.stderr, /Missing id/)

    assert.match(cliFail(configFile, ['context', 'req-nope']), /Requirement not found: req-nope/)
  })

  test('wt new：目录、身份文件、软链、exclude、落库一次做完', () => {
  test('子需求入库、能按 id 反查，取上下文时能看到父链与子需求', () => {
    scaffold()
    cliOk(configFile, ['project', 'new', 'demo'])
    const parent = JSON.parse(
      cliOk(configFile, [
        'req', 'new', '接真图', '--project', 'demo', '--slug', 'seatmap', '--summary', '先灰度 5%', '--json',
      ]),
    )
    const sub = JSON.parse(
      cliOk(configFile, ['req', 'new', '网关改造', '--parent', parent.id, '--slug', 'gateway', '--json']),
    )

    // 子需求与父需求一样在库里：slug 带层级、parent_id 指向父需求
    const db = new BoardDatabase(dataDir)
    db.syncProjects()
    const child = db.byId(sub.id)!
    assert.equal(child.slug, 'seatmap/gateway')
    assert.equal(child.parentId, parent.id)
    assert.equal(child.status, '澄清')
    db.close()

    // 子需求：带出上层需求与父需求描述
    const childCtx = cliOk(configFile, ['context', sub.id])
    assert.match(childCtx, /## 上层需求（从近到远）/)
    assert.match(childCtx, /- req-[0-9a-f]+ {2}seatmap {2}接真图/)
    assert.match(childCtx, /## 父需求描述/)
    assert.match(childCtx, /先灰度 5%/)

    // 父需求：列出名下子需求，每行带状态——接手父需求时先看「这串活还剩几块」
    const parentCtx = cliOk(configFile, ['context', parent.id])
    assert.match(parentCtx, /## 子需求（1）/)
    assert.match(parentCtx, /seatmap\/gateway {2}网关改造 {2}澄清/)
    assert.doesNotMatch(parentCtx, /已全部完成/)

    // 子需求全完成就点一句收尾；父需求自己已是终态时不再点
    cliOk(configFile, ['req', 'set', sub.id, '--status', '已完成'])
    const doneCtx = cliOk(configFile, ['context', parent.id])
    assert.match(doneCtx, /seatmap\/gateway {2}网关改造 {2}已完成/)
    assert.match(
      doneCtx,
      new RegExp(`子需求已全部完成——这条需求自己没有别的活就一并收尾：easy-flow req set ${parent.id} --status 已完成`),
    )
    cliOk(configFile, ['req', 'set', parent.id, '--status', '已完成'])
    assert.doesNotMatch(cliOk(configFile, ['context', parent.id]), /已全部完成/)
  })

    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo', '示例项目')
    const created = createRequirementDir(join(dataDir, 'demo'), 'seatmap-truemap', '接真图数据源', '新增 TRUEMAP')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const args = ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-truemap', '--short', 'router']
    const res = cliOk(configFile, args, env)
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(res)?.[1]
    assert.ok(id, res)

    const wtPath = join(workspace, `${repoName}.feature-truemap`)
    assert.equal(sh(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-truemap')
    assert.match(readFileSync(join(wtPath, 'AGENTS.md'), 'utf8'), new RegExp(`id: ${id}`))
    assert.match(readFileSync(join(wtPath, 'AGENTS.md'), 'utf8'), /见 easy-flow skill/)
    assert.equal(
      readFileSync(join(wtPath, 'requirement.md'), 'utf8'),
      readFileSync(join(created.dir, 'requirement.md'), 'utf8'),
    )
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/requirement\.md$/m)
    // 设计目录也挂上了：工作区里 design/ 是软链，指向需求目录的 docs/<短名>/
    const design = join(wtPath, 'design')
    assert.equal(lstatSync(design).isSymbolicLink(), true)
    assert.equal(readlinkSync(design), join(created.dir, 'docs', 'router'))
    // 产物都不该脏了 git status
    assert.equal(sh(wtPath, 'status', '--porcelain'), '')

    // 幂等：同参数再来一次，还是同一个 wt，exclude 不重复追加
    const again = cliOk(configFile, args, env)
    assert.equal(/worktree id：(wt-[0-9a-f]+)/.exec(again)?.[1], id)
    assert.equal(
      readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() === '/requirement.md').length,
      1,
    )

    const db = new BoardDatabase(dataDir)
    const row = db.worktreeById(id!)!
    assert.equal(row.requirementId, created.id)
    assert.equal(row.repo, repoName)
    assert.equal(row.short, 'router')
    assert.equal(row.path, wtPath)
    assert.equal(row.main, repo)
    assert.equal(db.listWorktrees(created.id).length, 1)
    db.close()
  })

  test('wt new 拒绝：分支在别处检出、路径被占、分支名非法', () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const call = (branch: string) =>
      cli(configFile, ['wt', 'new', created.id, '--repo', repoName, '--branch', branch], env)

    // 手工在别的路径建一个，占住分支
    const who = ['-c', 'user.name=test', '-c', 'user.email=test@test']
    execFileSync('git', ['-C', repo, ...who, 'worktree', 'add', '-q', join(workspace, 'manual'), '-b', 'feature-taken'])
    const taken = call('feature-taken')
    assert.notEqual(taken.code, 0)
    assert.match(taken.stderr, /already checked out at .*manual/)

    // 目标路径被普通目录占着
    mkdirSync(join(workspace, `${repoName}.feature-blocked`), { recursive: true })
    const blocked = call('feature-blocked')
    assert.notEqual(blocked.code, 0)
    assert.match(blocked.stderr, /is occupied/)

    // 非法分支名在预检就挡下，不留任何东西
    const bad = call('feature bad')
    assert.notEqual(bad.code, 0)
    assert.match(bad.stderr, /check-ref-format/)
    assert.equal(existsSync(join(workspace, `${repoName}.feature bad`)), false)

    // 走到 git 自己的失败：报错要带 fatal 那句，而不是 stderr 的进度行
    const badBase = cliFail(
      configFile,
      ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-new', '--base', 'no-such-ref'],
      env,
    )
    assert.match(badBase, /invalid reference/)
    // git 自己什么都没建出来
    assert.equal(existsSync(join(workspace, `${repoName}.feature-new`)), false)
    assert.equal(sh(repo, 'branch', '--list', 'feature-new'), '')
  })

  test('同一条分支被另一个需求再要一次：报错，且不动那个 worktree', () => {
    scaffold()
    const { workspace, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const alpha = createRequirementDir(join(dataDir, 'demo'), 'alpha', '甲需求', '摘要')
    const beta = createRequirementDir(join(dataDir, 'demo'), 'beta', '乙需求', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    cliOk(configFile, ['wt', 'new', alpha.id, '--repo', repoName, '--branch', 'feature-shared'], env)
    const wtPath = join(workspace, `${repoName}.feature-shared`)
    writeFileSync(join(wtPath, 'README.md'), 'work in progress\n')

    const second = cliFail(configFile, ['wt', 'new', beta.id, '--repo', repoName, '--branch', 'feature-shared'], env)
    // 兜底的是「软链不覆盖」，不是归属预检——正常不会走到这里，走到了也不能动别人的目录
    assert.match(second, /already points at/)

    // 甲的目录、分支与未提交改动一样不少
    assert.equal(existsSync(wtPath), true)
    assert.equal(readFileSync(join(wtPath, 'README.md'), 'utf8'), 'work in progress\n')
    assert.equal(sh(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-shared')

    const db = new BoardDatabase(dataDir)
    assert.equal(db.listWorktrees(alpha.id).length, 1)
    assert.equal(db.listWorktrees(beta.id).length, 0)
    db.close()
  })

  test('重复认领撞上不一致的软链：报错，但不回滚，目录与未提交改动原样', () => {
    scaffold()
    const { workspace, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const args = ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-own']
    cliOk(configFile, args, env)
    const wtPath = join(workspace, `${repoName}.feature-own`)
    writeFileSync(join(wtPath, 'README.md'), 'half done\n')

    // 把软链指到别处，制造一个「认领走到一半失败」的现场
    rmSync(join(wtPath, 'requirement.md'))
    symlinkSync(join(wtPath, 'README.md'), join(wtPath, 'requirement.md'))

    assert.match(cliFail(configFile, args, env), /already points at/)

    // 认领失败不回滚，更不该丢未提交改动
    assert.equal(existsSync(wtPath), true)
    assert.equal(readFileSync(join(wtPath, 'README.md'), 'utf8'), 'half done\n')
    assert.equal(sh(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-own')
    const db = new BoardDatabase(dataDir)
    assert.equal(db.listWorktrees(created.id).length, 1)
    db.close()
  })

  test('认领已有 worktree：不覆盖仓库自己的 AGENTS.md，并说明 id 只在库里', () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const wtPath = join(workspace, `${repoName}.feature-owned`)
    const who = ['-c', 'user.name=test', '-c', 'user.email=test@test']
    execFileSync('git', ['-C', repo, ...who, 'worktree', 'add', '-q', wtPath, '-b', 'feature-owned'])
    writeFileSync(join(wtPath, 'AGENTS.md'), '仓库自己的指令，别动\n')

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const res = cliOk(configFile, ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-owned'], env)
    assert.match(res, /本就存在/)
    assert.match(res, /没落进文件/)
    assert.equal(readFileSync(join(wtPath, 'AGENTS.md'), 'utf8'), '仓库自己的指令，别动\n')
    // 软链与 exclude 照补
    assert.equal(
      readFileSync(join(wtPath, 'requirement.md'), 'utf8'),
      readFileSync(join(created.dir, 'requirement.md'), 'utf8'),
    )
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/requirement\.md$/m)

    const id = /worktree id：(wt-[0-9a-f]+)/.exec(res)![1]
    const db = new BoardDatabase(dataDir)
    assert.equal(db.worktreeById(id)!.path, wtPath)
    db.close()
  })

  test('git 登记被手工删掉后，wt rm 仍能清干净', () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const made = cliOk(configFile, ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-prune'], env)
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(made)![1]
    const wtPath = join(workspace, `${repoName}.feature-prune`)

    // 模拟别处 prune 过：git 不再认它，目录还在
    rmSync(join(repo, '.git', 'worktrees', basename(wtPath)), { recursive: true, force: true })

    // 这种目录问不出 git status，所以必须显式 force
    assert.match(cliFail(configFile, ['wt', 'rm', id]), /cleanliness cannot be judged/)

    cliOk(configFile, ['wt', 'rm', id, '--force'])
    assert.equal(existsSync(wtPath), false)
    const db = new BoardDatabase(dataDir)
    assert.equal(db.worktreeById(id), undefined)
    db.close()
  })

  test('wt rm：脏工作区要 force，分支永远保留', () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const made = cliOk(configFile, ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-x'], env)
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(made)![1]
    const wtPath = join(workspace, `${repoName}.feature-x`)

    writeFileSync(join(wtPath, 'README.md'), 'changed\n')
    assert.match(cliFail(configFile, ['wt', 'rm', id]), /uncommitted changes/)

    const forced = cliOk(configFile, ['wt', 'rm', id, '--force'])
    assert.match(forced, /丢弃了 1 处未提交改动/)
    assert.match(forced, /分支 feature-x 已保留/)
    assert.equal(existsSync(wtPath), false)
    assert.equal(sh(repo, 'branch', '--list', 'feature-x'), 'feature-x')

    const db = new BoardDatabase(dataDir)
    assert.equal(db.worktreeById(id), undefined)
    db.close()
  })

  test('context 多态：wt- 拿到工作区与需求，裸值当项目', () => {
    scaffold()
    const { workspace, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo', '示例项目')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '接真图', '新增 TRUEMAP')
    writeFileSync(join(created.dir, 'context.md'), '跟 supply 对过：灰度按航司放。', 'utf8')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const made = cliOk(
      configFile,
      ['wt', 'new', created.id, '--repo', repoName, '--branch', 'feature-x', '--short', 'router'],
      env,
    )
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(made)![1]

    const byWt = cliOk(configFile, ['context', id], env)
    assert.match(byWt, new RegExp(`worktree id：${id}`))
    assert.match(byWt, /分支：feature-x/)
    assert.match(byWt, new RegExp(`需求 id：${created.id}`))
    assert.match(byWt, /新增 TRUEMAP/)
    assert.match(byWt, /灰度按航司放/)
    // 会话挂在需求上，工作区视图里也列出来，并标出就在这个目录里干活的那条
    const wtPath = join(workspace, `${repoName}.feature-x`)
    cliOk(
      configFile,
      ['req', 'session', 'add', created.id, '--agent', 'codex', '--id', 'th-here', '--cwd', wtPath],
      env,
    )
    cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'codex', '--id', 'th-elsewhere'], env)
    const wtCtx = cliOk(configFile, ['context', id], env)
    assert.match(wtCtx, /## 会话（2）/)
    assert.match(wtCtx, /th-here（本工作区）/)
    assert.match(wtCtx, /th-elsewhere {2}\S/)

    const byReq = cliOk(configFile, ['context', created.id], env)
    assert.match(byReq, /## worktree（1）/)
    assert.match(byReq, new RegExp(id))

    const byProject = cliOk(configFile, ['context', 'demo'], env)
    assert.match(byProject, /项目：示例项目（demo）/)
    assert.match(byProject, new RegExp(`${created.id}.*1 个 worktree`))

    assert.match(cliFail(configFile, ['context', 'nope'], env), /Known projects/)
  })

  test('req set 与 req link：按 id 改，链接只增不删', () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const moved = cliOk(configFile, ['req', 'set', created.id, '--status', '执行中', '--priority', 'p1'])
    assert.match(moved, /状态：执行中 · 优先级：p1/)

    const links = cliOk(configFile, [
      'req',
      'link',
      created.id,
      '--mr',
      'https://gitlab.example.com/mr/1',
      '--ext',
      '设计稿=https://example.com/design',
    ])
    assert.match(links, /代码链接（1）/)
    assert.match(links, /扩展链接（1）：设计稿/)

    assert.match(cliFail(configFile, ['req', 'link', created.id, '--mr', 'ftp://x']), /http\(s\)/)

    // 只增不删：再追加一条，原来那条与扩展链接都还在
    const more = cliOk(configFile, [
      'req',
      'link',
      created.id,
      '--feishu',
      'https://project.feishu.cn/x7mm65/story/detail/1',
    ])
    assert.match(more, /飞书任务（1）/)
    assert.match(more, /代码链接（1）/)
    assert.match(more, /扩展链接（1）/)

    // 别名：--mr "<别名>=<url>"；再传同一条链接但没给别名，旧别名留着
    assert.match(
      cliOk(configFile, ['req', 'link', created.id, '--mr', '主流程=https://gitlab.example.com/mr/2']),
      /代码链接（2）：https:\/\/gitlab\.example\.com\/mr\/1、主流程 https:\/\/gitlab\.example\.com\/mr\/2/,
    )
    assert.match(
      cliOk(configFile, ['req', 'link', created.id, '--mr', 'https://gitlab.example.com/mr/2']),
      /主流程 https:\/\/gitlab\.example\.com\/mr\/2/,
    )
    // 带 query 的纯 URL 不会被当成别名写法拆开
    assert.match(
      cliOk(configFile, ['req', 'link', created.id, '--mr', 'https://gitlab.example.com/mr/3?tab=notes']),
      /代码链接（3）/,
    )
    assert.match(
      cliFail(configFile, ['req', 'link', created.id, '--mr', '别名字段缺链接']),
      /expects a url or/,
    )

    assert.match(cliFail(configFile, ['req', 'set', created.id]), /Pass at least one of --status/)

    const db = new BoardDatabase(dataDir)
    const r = db.byId(created.id)!
    assert.equal(r.status, '执行中')
    assert.equal(r.priority, 'p1')
    assert.deepEqual(r.codeLinks, [
      { label: '', url: 'https://gitlab.example.com/mr/1' },
      { label: '主流程', url: 'https://gitlab.example.com/mr/2' },
      { label: '', url: 'https://gitlab.example.com/mr/3?tab=notes' },
    ])
    assert.deepEqual(r.feishuTaskLinks, ['https://project.feishu.cn/x7mm65/story/detail/1'])
    assert.deepEqual(r.extLinks, [{ detail: '设计稿', url: 'https://example.com/design' }])
    db.close()
  })

  test('子需求全完成时提一句父需求，但不动它的状态', () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const parent = createRequirementDir(join(dataDir, 'demo'), 'parent', '父需求')
    const a = createRequirementDir(parent.dir, 'a', '子需求 A')
    const b = createRequirementDir(parent.dir, 'b', '子需求 B')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    // 还剩一个没完成：不提示
    assert.doesNotMatch(cliOk(configFile, ['req', 'set', a.id, '--status', '已完成']), /已全部完成/)
    assert.match(cliOk(configFile, ['req', 'set', b.id, '--status', 'Review']), /状态：Review/)

    // 最后一个也完成：提示指向父需求，并给出收尾命令
    const last = cliOk(configFile, ['req', 'set', b.id, '--status', '已完成'])
    assert.match(last, /父需求「父需求」的 2 个子需求已全部完成/)
    assert.match(last, new RegExp(`easy-flow req set ${parent.id} --status 已完成`))

    // 提示只是提示：父需求的状态一个字没动
    const db = new BoardDatabase(dataDir)
    assert.equal(db.byId(parent.id)!.status, '澄清')
    db.close()
  })

  test('req session add：按 agent 取环境变量里的会话 id，并按 agent 推导 deeplink', () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    // claude 的 desktop（Code 标签页）会话：id 在 CLAUDE_CODE_HOST_SESSION_ID，能推出 deeplink
    const claude = cliOk(
      configFile,
      ['req', 'session', 'add', created.id, '--agent', 'claude', '--title', '实现会话登记'],
      { CLAUDE_CODE_HOST_SESSION_ID: 'local_31c66ec4' },
    )
    assert.match(claude, /已登记会话到需求「标题」/)
    assert.match(claude, /claude:\/\/claude\.ai\/epitaxy\/local_31c66ec4/)

    const codex = cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'codex'], {
      CODEX_THREAD_ID: 'th-9',
    })
    assert.match(codex, /codex:\/\/threads\/th-9/)

    // cursor 没有会话级 deeplink：登记得下，但要说明白
    assert.match(
      cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'cursor'], {
        CURSOR_CONVERSATION_ID: 'conv-1',
      }),
      /没有会话级 deeplink/,
    )

    // 程小帮：会话 id 在 CHENGXIAOBANG_SESSION_ID；链接当前至少能聚焦窗口
    const cxb = cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'chengxiaobang'], {
      CHENGXIAOBANG_SESSION_ID: 's_abc123def456',
    })
    assert.match(cxb, /chengxiaobang:\/\/session\/s_abc123def456/)
    // 终端里的 claude 会话是裸 uuid：能登记，但没有 deeplink
    cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'claude'], {
      CLAUDE_CODE_SESSION_ID: '87a7b66c',
    })

    const db = new BoardDatabase(dataDir)
    const byKey = Object.fromEntries(db.listSessions(created.id).map((s) => [`${s.agent}:${s.session}`, s]))
    assert.equal(Object.keys(byKey).length, 5)
    assert.equal(byKey['claude:local_31c66ec4'].title, '实现会话登记')
    assert.equal(byKey['claude:local_31c66ec4'].link, 'claude://claude.ai/epitaxy/local_31c66ec4')
    assert.equal(byKey['codex:th-9'].link, 'codex://threads/th-9')
    assert.equal(byKey['cursor:conv-1'].link, '')
    assert.equal(byKey['chengxiaobang:s_abc123def456'].link, 'chengxiaobang://session/s_abc123def456')
    assert.equal(byKey['claude:87a7b66c'].link, '')
    // --cwd 缺省是命令跑在哪儿
    assert.equal(byKey['codex:th-9'].cwd, resolve(REPO_ROOT))
    db.close()
  })

  test('req session review：需求名下没有工作区就报错，不去碰 codex', () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    // 没有工作区时在起 app-server 之前就拦下来：报错要指出下一步，而不是建个空 project
    const err = cliFail(configFile, ['req', 'session', 'review', created.id])
    assert.match(err, /没有工作区/)
    assert.match(err, /wt new/)
  })

  test('req session：缺会话 id、未知 agent、重复登记', () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    // 环境变量一个都没设又不给 --id：点名缺哪个变量，不静默写空
    const missing = cli(configFile, ['req', 'session', 'add', created.id, '--agent', 'codex'])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /CODEX_THREAD_ID/)

    assert.match(
      cliFail(configFile, ['req', 'session', 'add', created.id, '--agent', 'gemini', '--id', 'x']),
      /Unknown agent/,
    )

    cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'codex', '--id', 'th-1', '--title', '第一版'])
    cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'codex', '--id', 'th-1', '--title', '第二版'])
    const db = new BoardDatabase(dataDir)
    const rows = db.listSessions(created.id)
    assert.equal(rows.length, 1, '同一会话重复登记不长第二条')
    assert.equal(rows[0].title, '第二版')
    db.close()
  })

  test('req session ls / rm：按需求列、按需求分组，context 里带出会话', () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    assert.match(cliOk(configFile, ['req', 'session', 'ls', created.id]), /还没有登记会话/)
    cliOk(configFile, ['req', 'session', 'add', created.id, '--agent', 'codex', '--id', 'th-1', '--title', '看接口'])

    assert.match(cliOk(configFile, ['req', 'session', 'ls', created.id]), /codex {2}th-1 {2}看接口/)
    assert.match(cliOk(configFile, ['req', 'session', 'ls']), /## alpha（req-[0-9a-f]+）/)

    const ctx = cliOk(configFile, ['context', created.id])
    assert.match(ctx, /## 会话（1）/)
    assert.match(ctx, /codex:\/\/threads\/th-1/)
    // 脚本要的那份在 --json 里
    assert.equal(JSON.parse(cliOk(configFile, ['context', created.id, '--json'])).sessions.length, 1)

    assert.match(
      cliFail(configFile, ['req', 'session', 'rm', created.id, '--agent', 'codex', '--id', 'th-9']),
      /Session not found/,
    )
    assert.match(cliOk(configFile, ['req', 'session', 'rm', created.id, '--agent', 'codex', '--id', 'th-1']), /已从需求/)
    assert.equal(JSON.parse(cliOk(configFile, ['context', created.id, '--json'])).sessions.length, 0)
  })

  // only commands that really use the db open it; --help / --version must not create a data dir
  test('--help / --version 不开库', () => {
    scaffold()
    const never = join(base, 'never-used')
    writeFileSync(configFile, JSON.stringify({ dataDir: never }), 'utf8')
    cliOk(configFile, ['--help'])
    cliOk(configFile, ['--version'])
    cliOk(configFile, ['req', 'new', '--help'])
    assert.equal(existsSync(never), false)
  })

  test('todo new 落 md 与库，--json 给全字段', () => {
    scaffold()
    const text = cliOk(configFile, [
      'todo', 'new', '统计 MU 退票失败原因分布',
      '--source', 'chat',
      '--session', 'codex://threads/abc',
      '--from', 'groos',
      '--chat', 'MU 出票监控',
      '--ref', 'abc#1',
      '--link', 'https://example.com/thread',
      '--at', '2026-09-29 10:44',
      '--summary', '动作：按错误码统计。完成标准：给出占比。',
    ])
    assert.match(text, /已记一条待办/)
    assert.match(text, /待办 id：T-\d{8}-001/)

    const json = JSON.parse(
      cliOk(configFile, ['todo', 'new', '第二条', '--source', 'manual', '--json']),
    )
    assert.match(json.id, /^T-\d{8}-002$/)
    assert.equal(json.status, 'todo')

    const db = new BoardDatabase(dataDir)
    db.syncTodos()
    const t = db.todoById(todayId())!
    assert.equal(t.title, '统计 MU 退票失败原因分布')
    assert.equal(t.source, 'chat')
    assert.equal(t.session, 'codex://threads/abc')
    assert.equal(t.origin, 'groos')
    assert.equal(t.chat, 'MU 出票监控')
    assert.equal(t.ref, 'abc#1')
    assert.equal(t.link, 'https://example.com/thread')
    assert.equal(t.happened, '2026-09-29 10:44')
    assert.equal(t.summary, '动作：按错误码统计。完成标准：给出占比。')
    // 内容落在 _todos/<id>.md，标题取 H1、摘要取「摘要」段
    const md = readFileSync(t.path, 'utf8')
    assert.match(md, /^# 统计 MU 退票失败原因分布$/m)
    assert.match(md, /## 摘要/)
    assert.ok(md.startsWith('# '), '正文直接以 H1 开头，不塞说明性注释')
    db.close()
  })

  test('todo new 拒绝重复 ref、未知枚举与非 http 链接', () => {
    scaffold()
    cliOk(configFile, ['todo', 'new', '第一条', '--source', 'manual', '--ref', 'dup-1'])
    const dup = cli(configFile, ['todo', 'new', '重复的', '--source', 'manual', '--ref', 'dup-1'])
    assert.equal(dup.code, 1)
    assert.match(dup.stderr, /Ref already used by T-\d{8}-001/)

    const badSource = cli(configFile, ['todo', 'new', 'x', '--source', 'mail'])
    assert.equal(badSource.code, 1)
    assert.match(badSource.stderr, /Unknown source: mail/)

    const badStatus = cli(configFile, ['todo', 'new', 'x', '--status', 'doing'])
    assert.equal(badStatus.code, 1)
    assert.match(badStatus.stderr, /Unknown status: doing/)

    const badLink = cli(configFile, ['todo', 'new', 'x', '--link', 'ftp://x'])
    assert.equal(badLink.code, 1)
    assert.match(badLink.stderr, /must start with http/)
  })

  test('todo set：状态只改库，标题与摘要改 md', () => {
    scaffold()
    cliOk(configFile, ['todo', 'new', '原标题', '--source', 'manual', '--summary', '原摘要'])
    const id = todayId()

    assert.match(cliOk(configFile, ['todo', 'set', id, '--status', 'in_progress']), /状态：in_progress/)

    const db = new BoardDatabase(dataDir)
    db.syncTodos()
    assert.equal(db.todoById(id)!.status, 'in_progress')
    // 手改 md 的标题与摘要后再同步，库跟着走；状态不受影响
    const file = db.todoById(id)!.path
    writeFileSync(file, '# 手改的标题\n\n## 摘要\n\n手改的摘要\n\n## 进度\n\n- 做了一半\n', 'utf8')
    db.syncTodos()
    assert.equal(db.todoById(id)!.title, '手改的标题')
    assert.equal(db.todoById(id)!.summary, '手改的摘要')
    assert.equal(db.todoById(id)!.status, 'in_progress')
    db.close()

    // --summary 改的是 md 的「摘要」段，进度段原样保留
    cliOk(configFile, ['todo', 'set', id, '--title', '新标题', '--summary', '新摘要'])
    const md = readFileSync(file, 'utf8')
    assert.match(md, /^# 新标题$/m)
    assert.match(md, /新摘要/)
    assert.match(md, /- 做了一半/, '进度段不该被摘要的改写抹掉')

    const none = cli(configFile, ['todo', 'set', id])
    assert.equal(none.code, 2, '一个字段都不传是用法错误')
    assert.match(none.stderr, /Pass at least one field/)

    const missing = cli(configFile, ['todo', 'set', 'T-不存在', '--status', 'done'])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /Todo not found/)
  })

  test('todo list 默认只列未完成的，--all 连已完成一起列', () => {
    scaffold()
    cliOk(configFile, ['todo', 'new', '还开着的', '--source', 'manual'])
    cliOk(configFile, ['todo', 'new', '干完了的', '--source', 'manual'])
    cliOk(configFile, ['todo', 'set', todayId('002'), '--status', 'done'])

    const open = cliOk(configFile, ['todo', 'list'])
    assert.match(open, /未完成的待办（1）/)
    assert.match(open, /还开着的/)
    assert.ok(!open.includes('干完了的'), '默认不列已完成')
    assert.match(open, /已完成\/已取消 1 条/)

    const all = cliOk(configFile, ['todo', 'list', '--all'])
    assert.match(all, /全部待办（2）/)
    assert.match(all, /干完了的/)

    const byStatus = cliOk(configFile, ['todo', 'list', '--status', 'done'])
    assert.match(byStatus, /状态 done（1）/)
    assert.match(byStatus, /干完了的/)

    const bad = cli(configFile, ['todo', 'list', '--status', 'doing'])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /Unknown status/)
  })

  test('todo set --req 挂需求，todo list --req 反查', () => {
    scaffold()
    cliOk(configFile, ['project', 'new', 'demo', '--name', '示例项目'])
    const created = cliOk(configFile, [
      'req', 'new', '支持 1A 重试', '--project', 'demo', '--slug', 'seat-retry',
    ])
    const reqId = /需求 id：(req-\w+)/.exec(created)![1]

    cliOk(configFile, ['todo', 'new', '挂上去的待办', '--source', 'manual'])
    cliOk(configFile, ['todo', 'new', '没挂的待办', '--source', 'manual'])
    const id = todayId()

    cliOk(configFile, ['todo', 'set', id, '--req', reqId])
    assert.match(cliOk(configFile, ['todo', 'show', id]), new RegExp(`需求：${reqId}`))
    const linked = cliOk(configFile, ['todo', 'list', '--req', reqId])
    assert.match(linked, new RegExp(`需求 ${reqId} 的未完成的待办（1）`))
    assert.match(linked, /挂上去的待办/)
    assert.ok(!linked.includes('没挂的待办'))
    assert.equal(JSON.parse(cliOk(configFile, ['todo', 'list', '--req', reqId, '--json'])).total, 1)

    // 需求 id 写错当场报错，不留一个永远查不到东西的指针
    const badReq = cli(configFile, ['todo', 'set', id, '--req', 'req-nope'])
    assert.equal(badReq.code, 1)
    assert.match(badReq.stderr, /Requirement not found: req-nope/)
    assert.match(cli(configFile, ['todo', 'list', '--req', 'req-nope']).stderr, /Requirement not found/)

    // 空串摘掉指针
    cliOk(configFile, ['todo', 'set', id, '--req', ''])
    assert.match(cliOk(configFile, ['todo', 'list', '--req', reqId]), /（无）/)
  })

  test('todo show 打出元数据、md 路径与全文', () => {
    scaffold()
    cliOk(configFile, ['todo', 'new', '要看的待办', '--source', 'agent', '--session', 'codex://threads/z', '--summary', '动作：看它'])
    const text = cliOk(configFile, ['todo', 'show', todayId()])
    assert.match(text, /待办：要看的待办/)
    assert.match(text, /状态：todo/)
    assert.match(text, /会话：codex:\/\/threads\/z/)
    assert.match(text, /## 内容（.*_todos\/T-\d{8}-001\.md）/)
    assert.match(text, /动作：看它/)

    const missing = cli(configFile, ['todo', 'show', 'T-不存在'])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /Todo not found/)
  })

  test('todo import：只搬未完成的，保留原 id 与时间线，重复跑安全', () => {
    scaffold()
    const legacy = join(base, 'legacy')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, '2026-09-29.md'),
      `# 2026-09-29

### T-20260929-001 | todo
- title: 还开着的旧任务
- source: chat
- session: codex://threads/old
- from: groos
- chat: 某个会话
- ref: old#1
- link: https://example.com/a
- at: 2026-09-29 10:44
- summary: 动作：接着做。完成标准：给出结论。
- updated: 2026-09-29 10:44

### T-20260929-002 | done
- title: 早就干完了
- source: manual
- updated: 2026-09-29 12:00

### T-20260929-003 | cancelled
- title: 取消了
- source: manual
- updated: 2026-09-29 12:30
`,
      'utf8',
    )

    const dry = cliOk(configFile, ['todo', 'import', legacy, '--dry-run'])
    assert.match(dry, /将迁移 1 条未完成的待办/)
    assert.equal(existsSync(join(dataDir, '_todos')), false, '--dry-run 不落盘')

    const first = cliOk(configFile, ['todo', 'import', legacy])
    assert.match(first, /已迁移 1 条未完成的待办/)
    assert.match(first, /id：T-20260929-001/)
    assert.match(first, /已完成\/已取消 2 条留在原处不动/)

    const db = new BoardDatabase(dataDir)
    db.syncTodos()
    const t = db.todoById('T-20260929-001')!
    assert.equal(t.title, '还开着的旧任务')
    assert.equal(t.source, 'chat')
    assert.equal(t.session, 'codex://threads/old')
    assert.equal(t.ref, 'old#1')
    assert.equal(t.updated, '2026-09-29 10:44', '原时间线要保住，不能都挤在刚刚')
    assert.equal(db.todoById('T-20260929-002'), undefined, '已完成的不搬')
    assert.equal(db.todoById('T-20260929-003'), undefined, '已取消的也不搬')
    db.close()

    const again = cliOk(configFile, ['todo', 'import', legacy])
    assert.match(again, /已迁移 0 条未完成的待办/)
    assert.match(again, /已存在跳过 1 条/)
  })
})

// ---------------------------------------------------------------- HTTP 层

describe('HTTP 层', () => {
  let dir: string
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string

  before(async () => {
    dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\n甲需求内容', {
        id: 'req-alpha',
      })
      makeReq(d, 'onex', 'beta', '# beta\n\n## 需求\n\n乙需求内容')
    })
    app = createBoardApp({ dataDir: dir })
    server = createServer((req, res) => void app.handle(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    app.close()
  })

  const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<any>
  const post = async (p: string, body: unknown) =>
    (await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json() as Promise<any>

  test('GET /api/health', async () => {
    const r = await get('/api/health')
    assert.equal(r.ok, true)
    assert.equal(r.dataDir, dir)
  })

  test('GET /api/requirements 返回完整契约', async () => {
    const r = await get('/api/requirements')
    assert.ok(Array.isArray(r.requirements))
    assert.deepEqual(r.statuses, ['澄清', '执行中', 'Review', '已完成'])
    assert.deepEqual(r.priorities, ['p0', 'p1', 'p2', 'p3'])
    assert.equal(r.project, 'onex')
  })

  test('★ 读取不重扫目录：新增的需求要等一次同步才上板', async () => {
    // 单独一个数据目录与 app：共享的那个跑了别的用例，而这里的断言要求「读到的是上次同步的库」
    const dir2 = join(tmpdir(), `easy-flow-test-noscan-${process.pid}`)
    rmSync(dir2, { recursive: true, force: true })
    makeReq(dir2, 'onex', 'alpha', '# alpha\n\n## 需求\n\n甲需求内容')
    const app2 = createBoardApp({ dataDir: dir2 })
    const server2 = createServer((rq, rs) => void app2.handle(rq, rs))
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r))
    const addr = server2.address()
    const base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    const read = async () => (await fetch(`${base2}/api/requirements`)).json() as any

    try {
      makeReq(dir2, 'onex', 'beta', '# beta\n\n## 需求\n\n乙需求内容')
      const before = await read()
      assert.ok(!before.requirements.some((r: any) => r.slug === 'beta'))
      assert.deepEqual(before.sync.added, [], '读接口不该顺带扫目录')

      const synced = (await (
        await fetch(`${base2}/api/settings/resync`, { method: 'POST' })
      ).json()) as any
      assert.ok(synced.sync.added.includes('onex/beta'))

      const after = await read()
      assert.ok(after.requirements.some((r: any) => r.slug === 'beta'))
    } finally {
      await new Promise<void>((r) => server2.close(() => r()))
      app2.close()
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  test('GET /api/tree 返回项目树', async () => {
    const r = await get('/api/tree')
    assert.ok(Array.isArray(r.tree))
    const onex = r.tree.find((p: any) => p.slug === 'onex')
    assert.ok(onex && Array.isArray(onex.requirements))
  })

  test('GET /api/todos 返回待办与枚举，且读取前会同步 md', async () => {
    makeTodo(dir, 'T-20260101-001', '看板上的待办', '动作：验证契约。')
    const r = await get('/api/todos')
    assert.deepEqual(r.statuses, ['todo', 'in_progress', 'done', 'cancelled'])
    assert.deepEqual(r.sources, ['feishu', 'chat', 'agent', 'manual'])
    assert.deepEqual(r.sync.added, ['T-20260101-001'])
    const t = r.todos.find((x: any) => x.id === 'T-20260101-001')
    assert.equal(t.title, '看板上的待办')
    assert.equal(t.summary, '动作：验证契约。')
    assert.equal(t.status, 'todo')
  })

  test('POST /api/todos/update 改状态并落库，未知状态被拒', async () => {
    const r = await post('/api/todos/update', { id: 'T-20260101-001', status: 'in_progress' })
    assert.equal(r.status, 'in_progress')
    const list = await get('/api/todos')
    assert.equal(list.todos.find((x: any) => x.id === 'T-20260101-001').status, 'in_progress')

    assert.match((await post('/api/todos/update', { id: 'T-20260101-001', status: 'doing' })).error, /Unknown status/)
    assert.match((await post('/api/todos/update', { id: 'T-不存在', status: 'done' })).error, /Todo not found/)
  })

  test('待办文档读写往返', async () => {
    const before = await get('/api/todos/doc?id=T-20260101-001')
    assert.match(before.content, /动作：验证契约。/)
    assert.match(before.path, /_todos\/T-20260101-001\.md$/)

    const saved = await post('/api/todos/doc', {
      id: 'T-20260101-001',
      content: '# 改过的标题\n\n## 摘要\n\n改过的摘要\n\n## 进度\n\n- 走了一步\n',
    })
    assert.ok(saved.bytes > 0)
    // 写完顺手同步：标题与摘要跟着回库
    const list = await get('/api/todos')
    const t = list.todos.find((x: any) => x.id === 'T-20260101-001')
    assert.equal(t.title, '改过的标题')
    assert.equal(t.summary, '改过的摘要')

    assert.match((await get('/api/todos/doc?id=T-不存在')).error, /Todo not found/)
  })

  test('POST /api/move 改状态并落库', async () => {
    const r = await post('/api/move', { slug: 'alpha', status: 'Review' })
    assert.equal(r.status, 'Review')
    const list = await get('/api/requirements')
    assert.equal(list.requirements.find((x: any) => x.slug === 'alpha').status, 'Review')
  })

  test('POST /api/move 拒绝未知列', async () => {
    const r = await post('/api/move', { slug: 'alpha', status: 'Done' })
    assert.match(r.error, /Unknown status/)
  })

  test('POST /api/update 支持改状态与优先级', async () => {
    const r = await post('/api/update', { slug: 'alpha', status: 'Review', priority: 'p1' })
    assert.equal(r.status, 'Review')
    assert.equal(r.priority, 'p1')
  })

  test('POST /api/update 拒绝非法枚举', async () => {
    assert.match((await post('/api/update', { slug: 'alpha', status: '开发中' })).error, /Unknown status/)
    assert.match((await post('/api/update', { slug: 'alpha', priority: 'high' })).error, /Unknown priority/)
  })

  test('GET /api/search 返回命中的完整需求对象', async () => {
    const r = await get('/api/search?q=' + encodeURIComponent('甲需求'))
    assert.ok(r.requirements.some((x: any) => x.slug === 'alpha'))
  })

  test('GET /api/context 返回需求与原文', async () => {
    const r = await get('/api/context?slug=alpha')
    assert.equal(r.requirement.slug, 'alpha')
    assert.match(r.requirementMd, /甲需求内容/)
  })

  test('/api/context 带上该需求的工作区', async () => {
    const empty = await get('/api/context?slug=beta')
    assert.deepEqual(empty.worktrees, [])

    app.db.addWorktree({
      id: 'wt-ctx',
      requirementId: 'req-alpha',
      short: 'router',
      repo: 'flight-onex-exchange-router',
      branch: 'feature-x',
      path: join(dir, '不存在的目录'),
      main: join(dir, 'repo'),
    })

    const r = await get('/api/context?slug=alpha')
    assert.equal(r.worktrees.length, 1)
    assert.equal(r.worktrees[0].id, 'wt-ctx')
    assert.equal(r.worktrees[0].short, 'router')
    assert.equal(r.worktrees[0].branch, 'feature-x')
    // 归属只存在库里：记在 alpha 名下，beta 就查不到
    assert.deepEqual((await get('/api/context?slug=beta')).worktrees, [])
  })

  test('/api/context 带上该需求的会话', async () => {
    assert.deepEqual((await get('/api/context?slug=beta')).sessions, [])

    app.db.addSession({
      requirementId: 'req-alpha',
      agent: 'codex',
      session: 'th-ctx',
      title: '看接口',
      link: 'codex://threads/th-ctx',
    })

    const r = await get('/api/context?slug=alpha')
    assert.equal(r.sessions.length, 1)
    assert.equal(r.sessions[0].agent, 'codex')
    assert.equal(r.sessions[0].title, '看接口')
    assert.equal(r.sessions[0].link, 'codex://threads/th-ctx')
    // 归属只存在库里：记在 alpha 名下，beta 就查不到
    assert.deepEqual((await get('/api/context?slug=beta')).sessions, [])
  })

  test('GET /api/sessions 返回全部会话，带需求归属', async () => {
    const r = await get('/api/sessions')
    const one = r.sessions.find((s: any) => s.session === 'th-ctx')
    assert.equal(one.requirementId, 'req-alpha')
    assert.equal(one.agent, 'codex')
    assert.equal(one.link, 'codex://threads/th-ctx')
  })

  test('会话都带实时状态——把读口摘掉这条就会红', async () => {
    for (const path of ['/api/sessions', '/api/context?slug=alpha']) {
      const r = await get(path)
      const list = r.sessions.filter((s: any) => s.session === 'th-ctx')
      assert.equal(list.length, 1, `${path} 该带出这条会话`)
      // 状态是读 agent 应用落盘文件得来的；测试机上读不到就落到 unknown，但字段必须在
      assert.equal(typeof list[0].status?.state, 'string', `${path} 的会话该带 status`)
    }
  })

  test('POST /api/sessions/clicked 把这条会话写成静止，下一个 hook 事件直接覆盖', async () => {
    assert.deepEqual(await post('/api/sessions/clicked', { agent: 'codex', session: 'th-ctx' }), { ok: true })
    const clicked = (await get('/api/sessions')).sessions.find((s: any) => s.session === 'th-ctx')
    assert.equal(clicked.status.state, 'idle')

    // 与 hook 事件共用同一张表：同一个 session_id 的事件一到就覆盖掉
    await post('/api/hook', { hook_event_name: 'PreToolUse', session_id: 'th-ctx', agent: 'codex' })
    const after = (await get('/api/sessions')).sessions.find((s: any) => s.session === 'th-ctx')
    assert.equal(after.status.state, 'working')
  })

  test('/api/context 带上该需求的关联待办', async () => {
    assert.deepEqual((await get('/api/context?slug=beta')).todos, [])

    makeTodo(dir, 'T-20260201-001', '挂在 alpha 下的待办')
    await get('/api/todos') // 读取时同步，md 才进库
    app.db.setTodoFields('T-20260201-001', { requirementId: 'req-alpha' })

    const r = await get('/api/context?slug=alpha')
    assert.equal(r.todos.length, 1)
    assert.equal(r.todos[0].id, 'T-20260201-001')
    assert.equal(r.todos[0].requirementId, 'req-alpha')
    // 指针只存在 todo 一侧：挂给 alpha 的，beta 就查不到
    assert.deepEqual((await get('/api/context?slug=beta')).todos, [])
  })

  test('GET /api/requirement 按 id 取单条', async () => {
    const r = await get('/api/requirement?id=req-alpha')
    assert.equal(r.slug, 'alpha')
    assert.match((await get('/api/requirement?id=req-nope')).error, /Requirement not found/)
  })

  test('POST /api/worktree/open 只认库里的记录，目录不在就报错', async () => {
    const unknown = await post('/api/worktree/open', { id: 'wt-nope' })
    assert.match(unknown.error, /Worktree not found/)
    // 上一条用例登记的路径本来就不存在：不该真去 open，而是报出来
    const gone = await post('/api/worktree/open', { id: 'wt-ctx' })
    assert.match(gone.error, /Directory no longer exists/)
  })

  test('文档读写往返', async () => {
    const saved = await post('/api/doc', {
      slug: 'alpha',
      name: 'docs/note.md',
      content: '# 笔记\n\n内容',
    })
    assert.equal(saved.bytes > 0, true)
    const got = await get('/api/doc?slug=alpha&name=' + encodeURIComponent('docs/note.md'))
    assert.equal(got.content, '# 笔记\n\n内容')
  })

  test('★ 文档接口拒绝路径越界', async () => {
    const up = await get('/api/doc?slug=alpha&name=' + encodeURIComponent('../../etc/hosts'))
    assert.match(up.error, /escapes the root|Unsupported/)
    const abs = await get('/api/doc?slug=alpha&name=' + encodeURIComponent('/etc/hosts'))
    assert.match(abs.error, /Absolute paths|Unsupported/)
    const traverse = await get(
      '/api/doc?slug=alpha&name=' + encodeURIComponent('../../../package.json'),
    )
    assert.match(traverse.error, /escapes the root|Unsupported/)
  })

  test('文档接口拒绝非文本类型', async () => {
    const r = await get('/api/doc?slug=alpha&name=shell.sh')
    assert.match(r.error, /Unsupported file type/)
  })

  test('项目接口：列表 / 切 / 删', async () => {
    // 创建入口已移除：目录是事实源，扫描发现（GET /api/tree 会触发一次同步）
    mkdirSync(join(dir, 'demo'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'AGENTS.md'), '# 演示项目\n', 'utf8')
    await get('/api/tree')

    const listed = await get('/api/projects')
    assert.ok(listed.projects.some((p: any) => p.slug === 'demo'))

    const switched = await post('/api/projects/active', { slug: 'demo' })
    assert.equal(switched.active, 'demo')
    const empty = await get('/api/requirements')
    assert.equal(empty.requirements.length, 0)

    await post('/api/projects/active', { slug: 'onex' })
    const back = await get('/api/requirements')
    assert.ok(back.requirements.length >= 2)

    const del = await post('/api/projects/delete', { slug: 'demo', removeFiles: true })
    assert.equal(del.ok, true)
  })

  test('创建接口已移除', async () => {
    const r = await post('/api/projects', { slug: 'x', name: 'y' })
    assert.equal(r.error, 'not found')
  })

  test('/api/requirements 带上项目显示名', async () => {
    const r = await get('/api/requirements')
    assert.equal(r.project, 'onex')
    assert.equal(r.projectName, 'onex', '项目没有带 name 的 frontmatter 时退回目录名')
  })

  test('不能删除当前项目', async () => {
    const r = await post('/api/projects/delete', { slug: 'onex', removeFiles: false })
    assert.match(r.error, /currently in use/)
  })

  test('项目总规范读写', async () => {
    await post('/api/projects/convention', { project: 'onex', content: '# 规范\n\n约定' })
    const got = await get('/api/projects/convention?project=onex')
    assert.match(got.content, /约定/)
  })

  test('未知路由返回 404', async () => {
    const res = await fetch(`${base}/api/nope`)
    assert.equal(res.status, 404)
  })

  test('不存在的 slug 返回可读错误', async () => {
    const r = await get('/api/context?slug=nope')
    assert.match(r.error, /Requirement not found/)
  })

  // ---------------------------------------------------------- hook 入口

  test('POST /api/hook 收到事件后，会话状态跟着细粒度活动走', async () => {
    app.db.addSession({ requirementId: 'req-alpha', agent: 'claude', session: 'local-http', title: '收事件' })
    const cwd = join(dir, 'onex')
    const first = await post('/api/hook', {
      hook_event_name: 'PreToolUse',
      session_id: 'local-http',
      cwd,
      tool_name: 'Bash',
    })
    assert.equal(first.ok, true)
    const working = (await get('/api/sessions')).sessions.find((s: any) => s.session === 'local-http')
    assert.equal(working.status.state, 'working')

    await post('/api/hook', { hook_event_name: 'PostToolUse', session_id: 'local-http', cwd, tool_name: 'Bash' })
    const thinking = (await get('/api/sessions')).sessions.find((s: any) => s.session === 'local-http')
    assert.equal(thinking.status.state, 'thinking', '同一 turn 内从「干活」切到「思考」')

    await post('/api/hook', { hook_event_name: 'Stop', session_id: 'local-http', cwd })
    const done = (await get('/api/sessions')).sessions.find((s: any) => s.session === 'local-http')
    assert.equal(done.status.state, 'done')
  })

  test('POST /api/hook 认不出的 / 坏报文都吞掉，永远回 200', async () => {
    const unknown = await post('/api/hook', { hook_event_name: 'TeammateIdle', session_id: 'local-http' })
    assert.equal(unknown.ok, true)
    const raw = await fetch(`${base}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '写到一半',
    })
    assert.equal(raw.status, 200)
    assert.equal(((await raw.json()) as { ok?: boolean }).ok, true, '解析失败也当收到，不呛回 agent')
  })

  // read the install plan only; /api/skill/install is not tested — it would touch the real user environment
  test('GET /api/skill 返回 CLI 与 skill 的安装计划', async () => {
    const r = await get('/api/skill')
    assert.match(r.source, /skill$/)
    assert.match(r.cli, /server\/cli\.ts$/)
    assert.ok(r.shim.path.endsWith('/.local/bin/easy-flow'))
    assert.deepEqual(
      r.agents.map((a: { id: string }) => a.id),
      ['claude', 'cursor', 'codex'],
    )
    for (const a of r.agents) {
      assert.equal(typeof a.linked, 'boolean')
      assert.ok(a.dir.startsWith('/'))
    }
    assert.deepEqual(
      r.legacyMcp.map((m: { id: string }) => m.id),
      ['claude', 'codex'],
    )
  })
})

// ------------------------------------------------------------------ 导图

describe('导图：建树', () => {
  const req = (slug: string, title = slug, status = '澄清'): Requirement => ({
    slug,
    project: 'p',
    id: `req-${slug}`,
    parentId: '',
    title,
    status,
    priority: '',
    summary: '',
    repos: [],
    links: '',
    feishuTaskLinks: [],
    codeLinks: [],
    extLinks: [],
    docs: [],
    path: `/tmp/${slug}`,
    mtime: 0,
    updated: '',
  })

  test('扁平需求直接挂在根下，顺序保持', () => {
    const tree = buildTree([req('a'), req('b'), req('c')])
    assert.deepEqual(
      tree.map((n) => n.req.slug),
      ['a', 'b', 'c'],
    )
    assert.deepEqual(tree[0].children, [])
    assert.equal(tree[0].depth, 1)
  })

  test('slug 里的层级建出嵌套，深度逐层加一', () => {
    const tree = buildTree([req('alpha'), req('alpha/gateway'), req('alpha/gateway/adapter')])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].children[0].req.slug, 'alpha/gateway')
    assert.equal(tree[0].children[0].depth, 2)
    assert.equal(tree[0].children[0].children[0].depth, 3)
  })

  test('中间层不是需求时，挂到最近的存在祖先', () => {
    const tree = buildTree([req('alpha'), req('alpha/gateway/adapter')])
    assert.equal(tree.length, 1)
    assert.deepEqual(
      tree[0].children.map((n) => n.req.slug),
      ['alpha/gateway/adapter'],
    )
    assert.equal(tree[0].children[0].depth, 2)
  })

  test('一个祖先都不存在时当顶层', () => {
    const tree = buildTree([req('a/b/c')])
    assert.deepEqual(
      tree.map((n) => n.req.slug),
      ['a/b/c'],
    )
    assert.equal(tree[0].depth, 1)
  })

  test('子需求先于父需求出现也认得亲', () => {
    const tree = buildTree([req('alpha/gateway'), req('alpha')])
    assert.deepEqual(
      tree.map((n) => n.req.slug),
      ['alpha'],
    )
    assert.deepEqual(
      tree[0].children.map((n) => n.req.slug),
      ['alpha/gateway'],
    )
  })
})

describe('导图：布局', () => {
  const req = (slug: string, title = slug): Requirement => ({
    slug,
    project: 'p',
    id: `req-${slug}`,
    parentId: '',
    title,
    status: '澄清',
    priority: '',
    summary: '',
    repos: [],
    links: '',
    feishuTaskLinks: [],
    codeLinks: [],
    extLinks: [],
    docs: [],
    path: `/tmp/${slug}`,
    mtime: 0,
    updated: '',
  })

  const find = (l: ReturnType<typeof layoutTree>, slug: string) =>
    l.nodes.find((n) => n.req.slug === slug)!

  test('顶层需求分列根两侧：前一半在左、其余在右', () => {
    const l = layoutTree(buildTree([req('a'), req('b'), req('c')]))
    assert.equal(find(l, 'a').side, 'left')
    assert.equal(find(l, 'b').side, 'left')
    assert.equal(find(l, 'c').side, 'right')
  })

  test('只有一条需求时放右侧', () => {
    const l = layoutTree(buildTree([req('a')]))
    assert.equal(find(l, 'a').side, 'right')
  })

  test('左节点整体在根的左边，右节点整体在根的右边', () => {
    const l = layoutTree(buildTree([req('a'), req('a/x'), req('b'), req('c'), req('c/x')]))
    for (const n of l.nodes) {
      if (n.side === 'left') assert.ok(n.x + n.width <= l.root.x, `${n.req.slug} 应在根左侧`)
      else assert.ok(n.x >= l.root.x + l.root.width, `${n.req.slug} 应在根右侧`)
    }
  })

  test('同一侧同一层的节点竖直方向不重叠', () => {
    const l = layoutTree(
      buildTree([
        req('a'), req('a/x'), req('a/y'),
        req('b'), req('c'), req('d'),
        req('d/x'), req('e'), req('e/x'),
      ]),
    )
    for (const side of ['left', 'right'] as const) {
      const depths = new Set(l.nodes.filter((n) => n.side === side).map((n) => n.depth))
      for (const depth of depths) {
        const list = l.nodes
          .filter((n) => n.side === side && n.depth === depth)
          .sort((p, q) => p.y - q.y)
        for (let i = 1; i < list.length; i++) {
          assert.ok(
            list[i].y >= list[i - 1].y + list[i - 1].height,
            `${side} 侧第 ${depth} 层：${list[i].req.slug} 与 ${list[i - 1].req.slug} 重叠`,
          )
        }
      }
    }
  })

  test('父节点落在子节点跨度的中心', () => {
    const l = layoutTree(buildTree([req('a'), req('a/x'), req('a/y')]))
    const a = find(l, 'a')
    assert.equal(a.y, (find(l, 'a/x').y + find(l, 'a/y').y) / 2)
  })

  test('每个节点都连到父节点，顶层连到根', () => {
    const l = layoutTree(buildTree([req('a'), req('a/x')]))
    assert.deepEqual(l.edges.map((e) => e.id).sort(), ['a', 'a/x'])
  })

  test('搜索只留命中节点与它的祖先链', () => {
    const l = layoutTree(buildTree([req('a'), req('a/x'), req('b')]), {
      hits: new Set(['a/x']),
    })
    assert.deepEqual(l.nodes.map((n) => n.req.slug).sort(), ['a', 'a/x'])
  })

  test('收起的节点不铺开子需求，并记下藏了几个', () => {
    const l = layoutTree(buildTree([req('a'), req('a/x'), req('a/y')]), {
      collapsed: new Set(['a']),
    })
    assert.deepEqual(l.nodes.map((n) => n.req.slug), ['a'])
    assert.equal(find(l, 'a').hidden, 2)
    assert.equal(find(l, 'a').collapsible, true)
  })

  test('搜索时忽略收起——搜了就该看见命中在哪', () => {
    const l = layoutTree(buildTree([req('a'), req('a/x')]), {
      collapsed: new Set(['a']),
      hits: new Set(['a/x']),
    })
    assert.deepEqual(l.nodes.map((n) => n.req.slug).sort(), ['a', 'a/x'])
  })

  test('没有需求时只有根', () => {
    const l = layoutTree([])
    assert.deepEqual(l.nodes, [])
    assert.equal(l.edges.length, 0)
    assert.equal(l.root.width, 148)
    assert.ok(l.width > 0 && l.height > 0)
  })

  test('节点宽度按字数估，并夹在 132 到 240 之间', () => {
    assert.equal(nodeWidth('短'), 132)
    assert.equal(nodeWidth('这是一个特别特别长的需求标题用来测试上限'), 240)
    const mid = nodeWidth('中等长度的标题大概这样')
    assert.ok(mid > 132 && mid < 240, `期望落在区间内，实际 ${mid}`)
  })
})

// ---------------------------------------------- 会话状态：读 agent 应用的落盘文件

describe('会话状态', () => {
  /** 假装的用户主目录。各处外部数据都从这儿派生，测试不碰真机上的东西 */
  const HOME = join(TMP, 'agent-home')
  const roots = {
    appSupport: join(HOME, 'Library', 'Application Support'),
    claudeHome: join(HOME, '.claude'),
    codexHome: join(HOME, '.codex'),
    chengxiaobangHome: join(HOME, '.chengxiaobang'),
  }

  const { store: suiteStore, sources: suiteSources } = newState()

  before(() => rmSync(HOME, { recursive: true, force: true }))

  /** 桌面应用的会话记录。写在第三方 provider 那套目录下——本机在用的就是它 */
  function claudeRecord(sessionId: string, rec: Record<string, unknown>): void {
    const dir = join(roots.appSupport, 'Claude-3p', 'claude-code-sessions', 'acct', 'org')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ sessionId, ...rec }), 'utf8')
  }

  /** 活着的 CLI 进程才会写这个文件，进程一退就没了。pid 用测试进程自己——它一定活着 */
  function claudeLive(hostSessionId: string, status: string, pid: number | null = process.pid): void {
    const dir = join(roots.claudeHome, 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${hostSessionId}.json`), JSON.stringify({ hostSessionId, status, pid }), 'utf8')
  }

  /**
   * codex 的 rollout jsonl：写进「今天」那层日期目录（兜底只扫近几天），文件名末尾是 thread id。
   * 一行一个事件、末尾带换行——写全了才算完整。
   */
  function codexRollout(id: string, lines: string[]): string {
    const dir = sessionDirFor(roots.codexHome, new Date())
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-14T10-00-00-${id}.jsonl`)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    return file
  }

  /** 一条 rollout 事件行，形状照本机实测的顶层 { timestamp, type, payload } */
  function evLine(type: string, payload: Record<string, unknown> | null = null, at = Date.now()): string {
    return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload })
  }

  /** codex 的官方未读集合：不在这里面的 thread 就是看过了 */
  function codexUnreadState(unreadIds: string[]): void {
    mkdirSync(roots.codexHome, { recursive: true })
    writeFileSync(
      join(roots.codexHome, '.codex-global-state.json'),
      JSON.stringify({ 'electron-thread-read-state-v1': { unreadByIdentity: { id1: { host1: unreadIds } } } }),
      'utf8',
    )
  }

  /** 桌面应用的未读集合 */
  function statusOf(agent: string, session: string): SessionStatus {
    const one = [{ agent, session }]
    pullStatuses(one, suiteStore, suiteSources, roots)
    return readObservations(one, suiteStore)[0].status
  }

  test('桌面会话：CLI 进程在跑就是 running', () => {
    claudeRecord('local_busy', { lastActivityAt: Date.now() })
    claudeLive('local_busy', 'busy')
    assert.equal(statusOf('claude', 'local_busy').state, 'working')
  })

  test('桌面会话：进程没了但文件残留 busy，不能一直当在跑', () => {
    // 进程被 kill -9 时文件会留下；running 不受已读影响，判错就是角标永远消不掉
    const dead = 999_999
    claudeRecord('local_zombie', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'z1',
      lastAssistantUuid: 'z1',
      postTurnSummary: { status_category: 'review_ready' },
    })
    claudeLive('local_zombie', 'busy', dead)
    assert.equal(statusOf('claude', 'local_zombie').state, 'done', 'pid 不在就该退回记录里的结论')
  })

  test('桌面会话：进程 idle 时让位给记录里的结论', () => {
    claudeRecord('local_idle', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'i1',
      lastAssistantUuid: 'i1',
      postTurnSummary: { status_category: 'blocked', needs_action: '接着做吗？' },
    })
    claudeLive('local_idle', 'idle')
    assert.equal(statusOf('claude', 'local_idle').state, 'blocked')
  })

  test('observedAt 是这条状态的时刻（ms）；记录里说不出时刻就记 0', () => {
    const now = Date.now()
    claudeRecord('local_at', {
      lastActivityAt: now,
      postTurnSummaryFor: 'a0',
      lastAssistantUuid: 'a0',
      postTurnSummary: { status_category: 'completed' },
    })
    assert.equal(statusOf('claude', 'local_at').observedAt, now)
    claudeRecord('local_no_at', {
      postTurnSummaryFor: 'a00',
      lastAssistantUuid: 'a00',
      postTurnSummary: { status_category: 'completed' },
    })
    assert.equal(statusOf('claude', 'local_no_at').observedAt, 0)
  })

  test('桌面会话：结论 blocked 时连要人回答的那句话一起带出来', () => {
    claudeRecord('local_blocked', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'a1',
      lastAssistantUuid: 'a1',
      postTurnSummary: { status_category: 'blocked', needs_action: '要我按流程开需求吗？' },
    })
    const got = statusOf('claude', 'local_blocked')
    assert.equal(got.state, 'blocked')
    assert.equal(got.needsAction, '要我按流程开需求吗？')
  })

  test('桌面会话：review_ready 是 done', () => {
    claudeRecord('local_review', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'a2',
      lastAssistantUuid: 'a2',
      postTurnSummary: { status_category: 'review_ready' },
    })
    assert.equal(statusOf('claude', 'local_review').state, 'done')
  })

  test('桌面会话：跑完的已看过落静止，没看过仍是跑完待看', () => {
    const at = Date.now() - 60_000
    claudeRecord('local_seen', {
      lastActivityAt: at,
      lastFocusedAt: at + 30_000,
      postTurnSummaryFor: 'a3',
      lastAssistantUuid: 'a3',
      postTurnSummary: { status_category: 'review_ready' },
    })
    assert.equal(statusOf('claude', 'local_seen').state, 'idle')

    claudeRecord('local_unseen', {
      lastActivityAt: at,
      lastFocusedAt: at - 30_000,
      postTurnSummaryFor: 'a3b',
      lastAssistantUuid: 'a3b',
      postTurnSummary: { status_category: 'review_ready' },
    })
    assert.equal(statusOf('claude', 'local_unseen').state, 'done')
  })

  test('桌面会话：blocked 看过也不降档——看过不等于答过', () => {
    const at = Date.now() - 60_000
    claudeRecord('local_blocked_seen', {
      lastActivityAt: at,
      lastFocusedAt: at + 30_000,
      postTurnSummaryFor: 'a3c',
      lastAssistantUuid: 'a3c',
      postTurnSummary: { status_category: 'blocked', needs_action: '走哪条？' },
    })
    const got = statusOf('claude', 'local_blocked_seen')
    assert.equal(got.state, 'blocked')
    assert.equal(got.needsAction, '走哪条？')
  })

  test('板侧写进去的 idle 压住落盘结论，下一个 hook 事件直接覆盖它', () => {
    const { store, sources } = newState()
    const cli = 'e6a1f0c2-1111-2222-3333-444455556666'
    claudeRecord('local_clicked', {
      cliSessionId: cli,
      // 落盘结论比点击旧——真实场景就是这样，点击总发生在上一轮结束之后
      lastActivityAt: Date.now() - 60_000,
      postTurnSummaryFor: 'a6',
      lastAssistantUuid: 'a6',
      postTurnSummary: { status_category: 'blocked', needs_action: '走哪条？' },
    })
    const at = () => {
      const one = [{ agent: 'claude', session: 'local_clicked' }]
      pullStatuses(one, store, sources, roots)
      return readObservations(one, store)[0].status
    }
    assert.equal(at().state, 'blocked', '没点过就是落盘结论')

    // 点 pet：写进状态层，用与 hook 事件同一个 key（内层 cliSessionId）
    store.put('claude', cli, idleStatus())
    assert.equal(at().state, 'idle')

    // 下一个事件落到同一个 key 上，直接覆盖
    recordHook({ hook_event_name: 'PreToolUse', session_id: cli, cwd: '/tmp' }, {}, store)
    assert.equal(at().state, 'working')
  })

  test('hookKeyOf 把登记 id 翻成 hook 报的那个 id；没有记录就用登记 id', () => {
    claudeRecord('local_key', { cliSessionId: 'inner-uuid' })
    assert.equal(hookKeyOf('claude', 'local_key', roots), 'inner-uuid')
    assert.equal(hookKeyOf('claude', 'local_no_record', roots), 'local_no_record')
    // codex 的登记 id 就是 hook 报的那个，不翻
    assert.equal(hookKeyOf('codex', 'th-1', roots), 'th-1')
  })

  test('桌面会话：结论落后于最新一轮就报 unknown，不拿过期结论充数', () => {
    claudeRecord('local_stale', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'a4',
      lastAssistantUuid: 'a5',
      postTurnSummary: { status_category: 'review_ready' },
    })
    assert.equal(statusOf('claude', 'local_stale').state, 'unknown')
  })

  test('桌面会话：没有记录（终端会话）报 unknown', () => {
    assert.equal(statusOf('claude', 'local_never_opened').state, 'unknown')
  })

  test('桌面会话：记录写坏了只影响这一条，不拖垮整批', () => {
    const dir = join(roots.appSupport, 'Claude-3p', 'claude-code-sessions', 'acct', 'org')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'local_broken.json'), '{ 写到一半', 'utf8')
    claudeRecord('local_ok', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'a6',
      lastAssistantUuid: 'a6',
      postTurnSummary: { status_category: 'completed' },
    })
    assert.equal(statusOf('claude', 'local_broken').state, 'unknown')
    assert.equal(statusOf('claude', 'local_ok').state, 'done', '同批的其它会话照常读出来')
  })

  test('codex：最后一条 rollout 是收尾就是 done', () => {
    codexRollout('cx-done', [
      evLine('event_msg', { type: 'task_started' }),
      evLine('event_msg', { type: 'task_complete' }),
    ])
    assert.equal(statusOf('codex', 'cx-done').state, 'done')
  })

  test('codex：最后一条是工具调用就是 running，久了没动静就当它没了', () => {
    codexRollout('cx-live', [evLine('response_item', { type: 'function_call' }, Date.now() - 60_000)])
    codexRollout('cx-dead', [evLine('response_item', { type: 'function_call' }, Date.now() - 6 * 60 * 60_000)])
    assert.equal(statusOf('codex', 'cx-live').state, 'working')
    assert.equal(
      statusOf('codex', 'cx-dead').state,
      'unknown',
      'codex 崩掉不会有收尾事件，不能一直当在跑',
    )
  })

  test('codex：收尾带 error 是 failed，被打断是 blocked（同 hook 的 Interrupt）', () => {
    codexRollout('cx-failed', [
      evLine('event_msg', { type: 'task_complete', error: { message: 'stream disconnected' } }),
    ])
    codexRollout('cx-aborted', [evLine('event_msg', { type: 'turn_aborted', reason: 'interrupted' })])
    assert.equal(statusOf('codex', 'cx-failed').state, 'failed')
    assert.equal(statusOf('codex', 'cx-aborted').state, 'blocked')
  })

  test('codex：一个 thread 跑过多轮，按落盘顺序取最后一条', () => {
    codexRollout('cx-multi', [
      evLine('event_msg', { type: 'task_complete' }),
      evLine('event_msg', { type: 'task_started' }),
      evLine('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    ])
    assert.equal(statusOf('codex', 'cx-multi').state, 'blocked', '最后一条是打断')
  })

  test('codex：没有 rollout 文件就报 unknown 而不是抛', () => {
    assert.equal(statusOf('codex', 'cx-never-seen').state, 'unknown')
  })

  test('codex：跑完且官方未读里没有它就落静止，还在未读里就仍是跑完待看', () => {
    codexRollout('cx-read', [evLine('event_msg', { type: 'task_complete' })])
    codexRollout('cx-unread', [evLine('event_msg', { type: 'task_complete' })])
    codexUnreadState(['cx-unread'])
    assert.equal(statusOf('codex', 'cx-read').state, 'idle')
    assert.equal(statusOf('codex', 'cx-unread').state, 'done')
  })

  test('codex：blocked / failed 看过也不降档', () => {
    codexRollout('cx-aborted-seen', [evLine('event_msg', { type: 'turn_aborted' })])
    codexRollout('cx-failed-seen', [evLine('event_msg', { type: 'task_complete', error: { message: 'x' } })])
    codexUnreadState([])
    assert.equal(statusOf('codex', 'cx-aborted-seen').state, 'blocked')
    assert.equal(statusOf('codex', 'cx-failed-seen').state, 'failed')
  })

  test('codex：未读集合读不到时不动它——宁可多提醒一次', () => {
    codexRollout('cx-no-state', [evLine('event_msg', { type: 'task_complete' })])
    rmSync(join(roots.codexHome, '.codex-global-state.json'), { force: true })
    assert.equal(statusOf('codex', 'cx-no-state').state, 'done')
  })

  test('cursor 没有可读的状态来源，一律 unknown', () => {
    assert.equal(statusOf('cursor', 'conv-1').state, 'unknown')
  })

  test('程小帮：库里的落盘结论参与状态，推拉结合', () => {
    const { store } = newState()
    const read = (session: string): SessionStatus => {
      const one = [{ agent: 'chengxiaobang', session }]
      pullStatuses(one, store, suiteSources, roots)
      return readObservations(one, store)[0].status
    }

    // 按小帮自己的 schema 建一份库：sessions / messages / runs
    const file = join(roots.chengxiaobangHome, 'data', 'chengxiaobang.sqlite')
    rmSync(file, { force: true })
    mkdirSync(dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    const now = new Date().toISOString()
    db.exec(`
      create table sessions (id text primary key, title text not null default '', created_at text not null, updated_at text not null, last_viewed_at text);
      create table messages (id text primary key, session_id text not null, role text not null, content text not null, created_at text not null);
      create table runs (id text primary key, session_id text not null, status text not null, error text, created_at text not null, updated_at text not null);
    `)
    const add = (id: string, status: string, extra: { error?: string; viewed?: string; at?: string } = {}): void => {
      const at = extra.at ?? now
      db.prepare('insert into sessions (id, created_at, updated_at) values (?, ?, ?)').run(id, at, at)
      db.prepare('insert into runs (id, session_id, status, error, created_at, updated_at) values (?, ?, ?, ?, ?, ?)').run(
        `r-${id}`,
        id,
        status,
        extra.error ?? null,
        at,
        at,
      )
      if (extra.viewed) db.prepare('update sessions set last_viewed_at = ? where id = ?').run(extra.viewed, id)
    }
    add('s_running', 'running')
    add('s_failed', 'failed', { error: 'model timeout' })
    add('s_aborted', 'aborted')
    add('s_unseen', 'completed')
    add('s_seen', 'completed', { viewed: now })
    // 崩溃前残留的 running：应用没来得及收尾，靠活跃超时兜底
    add('s_stale_running', 'running', { at: new Date(Date.now() - 31 * 60_000).toISOString() })
    db.close()

    assert.equal(read('s_running').state, 'working')
    assert.equal(read('s_failed').state, 'failed')
    assert.match(read('s_failed').detail, /model timeout/)
    assert.equal(read('s_aborted').state, 'blocked')
    assert.equal(read('s_unseen').state, 'done', '跑完没看过：跑完待看')
    assert.equal(read('s_seen').state, 'idle', '看过了就是静止')
    assert.equal(read('s_stale_running').state, 'unknown', '库里停在 running 太久，不能一直显示在干活')
    assert.equal(read('s_missing').state, 'unknown', '库里没有这条会话')
  })

  test('程小帮：hook 推来的新结论盖过库里那份旧的', () => {
    const { store } = newState()
    const session = 's_push_wins'
    const file = join(roots.chengxiaobangHome, 'data', 'chengxiaobang.sqlite')
    const old = new Date(Date.now() - 60_000).toISOString()
    rmSync(file, { force: true })
    mkdirSync(dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`
      create table sessions (id text primary key, title text not null default '', created_at text not null, updated_at text not null, last_viewed_at text);
      create table messages (id text primary key, session_id text not null, role text not null, content text not null, created_at text not null);
      create table runs (id text primary key, session_id text not null, status text not null, error text, created_at text not null, updated_at text not null);
    `)
    db.prepare('insert into sessions (id, created_at, updated_at) values (?, ?, ?)').run(session, old, old)
    db.prepare('insert into runs (id, session_id, status, error, created_at, updated_at) values (?, ?, ?, ?, ?, ?)').run(
      'r1',
      session,
      'completed',
      null,
      old,
      old,
    )
    db.close()

    const one = [{ agent: 'chengxiaobang', session }]
    pullStatuses(one, store, suiteSources, roots)
    assert.equal(readObservations(one, store)[0].status.state, 'done', '先读库：跑完了')

    recordHook({ hook_event_name: 'PreToolUse', session_id: session }, { agent: 'chengxiaobang' }, store)
    pullStatuses(one, store, suiteSources, roots)
    assert.equal(readObservations(one, store)[0].status.state, 'working', 'hook 更新，拉取不能盖回去')
  })

  test('同一个会话 id 挂在两个 agent 上时互不串味', () => {
    // claude 记录的文件名必须带 local_ 前缀，所以拿它当两边共用的 id
    const id = 'local_shared-id'
    claudeRecord(id, {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'a8',
      lastAssistantUuid: 'a8',
      postTurnSummary: { status_category: 'blocked', needs_action: '走哪条？' },
    })
    codexRollout(id, [evLine('event_msg', { type: 'task_complete', error: { message: 'x' } })])
    assert.equal(statusOf('claude', id).state, 'blocked')
    assert.equal(statusOf('codex', id).state, 'failed')
  })

  test('一次读一批：不同 agent 各走各的路径，互不干扰', () => {
    claudeRecord('local_batch', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 'a7',
      lastAssistantUuid: 'a7',
      postTurnSummary: { status_category: 'blocked', needs_action: '接着做吗？' },
    })
    codexRollout('cx-batch', [evLine('event_msg', { type: 'task_complete', error: { message: 'x' } })])
    const one = [
      { agent: 'claude', session: 'local_batch' },
      { agent: 'codex', session: 'cx-batch' },
      { agent: 'cursor', session: 'conv-2' },
    ]
    pullStatuses(one, suiteStore, suiteSources, roots)
    const got = readObservations(one, suiteStore)
    assert.deepEqual(
      got.map((s) => s.status.state),
      ['blocked', 'failed', 'unknown'],
    )
    // 原字段原样带出来，不能只返回 status
    assert.equal(got[0].session, 'local_batch')
    assert.equal(got[0].agent, 'claude')
  })
})

// ---------------------------------------------- rollout 兜底：增量 tail ~/.codex/sessions

describe('rollout 兜底：事件译状态、增量读、只扫近几天', () => {
  const HOME = join(TMP, 'rollout-home')

  before(() => rmSync(HOME, { recursive: true, force: true }))

  const DAY = 86_400_000

  /** 一条完整的事件行，形状照本机实测的顶层 { timestamp, type, payload } */
  function line(type: string, payload: Record<string, unknown> | null = null, at = Date.now()): string {
    return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload })
  }

  /** 写一份 rollout，返回文件路径。dir 由调用方给，好测「近几天」的窗口 */
  function writeRollout(dir: string, id: string, body: string): string {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-14T10-00-00-${id}.jsonl`)
    writeFileSync(file, body, 'utf8')
    return file
  }

  test('一行 → 一档：与 hook 同一套字面量', () => {
    const cases: Array<[string, string]> = [
      ['session_meta', 'idle'],
      ['event_msg/task_started', 'thinking'],
      ['response_item/reasoning', 'thinking'],
      ['response_item/function_call', 'working'],
      ['response_item/web_search_call', 'working'],
      ['response_item/function_call_output', 'thinking'],
      ['event_msg/task_complete', 'done'],
      ['event_msg/turn_aborted', 'blocked'],
    ]
    for (const [label, state] of cases) {
      const [type, sub] = label.split('/')
      const got = rolloutStatusOf({ type, payload: sub ? { type: sub } : null }, 0)
      assert.equal(got?.state, state, `${label} 该落到 ${state}`)
    }
  })

  test('收尾带 error 是 failed；认不出的类型不认', () => {
    assert.equal(rolloutStatusOf({ type: 'event_msg', payload: { type: 'task_complete', error: { m: 1 } } }, 0)?.state, 'failed')
    assert.equal(rolloutStatusOf({ type: 'event_msg', payload: { type: 'token_count' } }, 0), null, '周期性事件不改状态')
    assert.equal(rolloutStatusOf({ type: 'turn_context', payload: null }, 0), null, '元数据不认')
    assert.equal(rolloutStatusOf({ type: 'response_item', payload: { type: 'message' } }, 0), null)
  })

  test('增量按字节读：半行不误判、认不出的忽略、补全后接着读', () => {
    const home = join(HOME, 'incremental')
    const { sources } = newState()
    const store = new RolloutStore(home, sources)
    const dir = sessionDirFor(home, new Date())
    const start = line('event_msg', { type: 'task_started' })
    const meta = line('turn_context', { model: 'x' })
    const call = line('response_item', { type: 'function_call' })
    const done = line('event_msg', { type: 'task_complete' })
    // 一段 rollout：认得出的、认不出的、以及一条写到一半的尾行（没有换行）
    const file = writeRollout(dir, 'cx-half', [start, meta, call, done.slice(0, 24)].join('\n'))

    // 最后一条**完整**的是 function_call → 干活；半行与认不出的都不算
    assert.equal(store.refresh(['cx-half']).get('cx-half')?.status.state, 'working')

    // 补全那条半行（整份重写、末尾带换行）。offset 停在最后一个换行，前面不重读
    writeFileSync(file, [start, meta, call, done].join('\n') + '\n', 'utf8')
    assert.equal(store.refresh(['cx-half']).get('cx-half')?.status.state, 'done', '补全的尾行接上')
  })

  test('缓存形状对不上就当没有：从头重读，而不是拿着它往下走', () => {
    const home = join(HOME, 'stale-cache')
    const { sources } = newState()
    const store = new RolloutStore(home, sources)
    const dir = sessionDirFor(home, new Date())
    // 上一版把状态直接缓存在 source_file 这一列里；这一版读的是 { status, action }。
    // offset 记成文件读完的位置——真实场景就是这样，不重读时旧形状会直接漏出去
    const file = writeRollout(dir, 'cx-stale', line('event_msg', { type: 'task_complete' }) + '\n')
    const stats = statSync(file)
    sources.touchSource(file, {
      mtimeMs: stats.mtimeMs,
      offset: stats.size,
      state: { state: 'working', needsAction: '', observedAt: 1, detail: '上一版写下的形状' },
    })

    const got = store.refresh(['cx-stale']).get('cx-stale')
    assert.equal(got?.status.state, 'done', '认不出缓存就归零 offset，重新 fold 出状态')
    assert.equal(got?.action, null)
  })

  test('认不出的缓存这一轮就写回：不然下一轮又从零重读一遍', () => {
    const home = join(HOME, 'stale-rewrite')
    const { sources } = newState()
    const store = new RolloutStore(home, sources)
    const dir = sessionDirFor(home, new Date())
    const file = writeRollout(dir, 'cx-rewrite', line('event_msg', { type: 'task_complete' }) + '\n')
    const stats = statSync(file)
    sources.touchSource(file, {
      mtimeMs: stats.mtimeMs,
      offset: stats.size,
      state: { state: 'working', needsAction: '', observedAt: 1, detail: '上一版写下的形状' },
    })

    store.refresh(['cx-rewrite'])
    const cached = sources.source(file)
    assert.equal((cached?.state as { status?: { state?: string } })?.status?.state, 'done', '旧形状被新观察顶掉')
    assert.equal(cached?.offset, stats.size, 'offset 停在读完的位置，下一轮不用再重读')
  })

  test('只扫近几天：窗口外的日期目录靠缓存继续扫到，没进过缓存的就不扫', () => {
    const home = join(HOME, 'window')
    const { sources } = newState()
    const store = new RolloutStore(home, sources)
    const now = Date.now()
    const near = sessionDirFor(home, new Date(now - DAY))
    const far = sessionDirFor(home, new Date(now - 10 * DAY))
    writeRollout(near, 'cx-near', line('event_msg', { type: 'task_complete' }, now) + '\n')
    writeRollout(far, 'cx-far', line('event_msg', { type: 'task_complete' }, now - 10 * DAY) + '\n')

    const first = store.refresh(['cx-near', 'cx-far'], now)
    assert.equal(first.get('cx-near')?.status.state, 'done')
    assert.equal(first.get('cx-far'), undefined, '窗口外的日期目录不该被遍历')

    // 20 天后：near 的目录早已出窗口，但读到过就继续扫
    const later = store.refresh(['cx-near', 'cx-far'], now + 20 * DAY)
    assert.equal(later.get('cx-near')?.status.state, 'done', '跟过的日期目录继续扫')
    assert.equal(later.get('cx-far'), undefined)
  })

  test('读不到文件 / 全是半行都不算读到，调用方给 unknown', () => {
    const home = join(HOME, 'empty')
    const { sources } = newState()
    const store = new RolloutStore(home, sources)
    assert.equal(store.refresh(['cx-none'], Date.now()).get('cx-none'), undefined)
    writeRollout(sessionDirFor(home, new Date()), 'cx-partial', line('event_msg', { type: 'task_started' }).slice(0, 10))
    assert.equal(store.refresh(['cx-partial'], Date.now()).get('cx-partial'), undefined, '只有半行就什么都不认')
  })
})

// ------------------------------------------ 会话实时状态：hook 事件推来的细粒度状态

describe('hook 事件：归一与暂存', () => {
  const CLAUDE = { agent: 'claude' }
  const event = (name: string, extra: Record<string, unknown> = {}) =>
    normalizeHookEvent({ hook_event_name: name, session_id: 's1', cwd: '/tmp', ...extra })

  test('事件名归一成状态：什么事件落到哪一档', () => {
    const cases: Array<[string, string]> = [
      ['PreToolUse', 'working'],
      ['PostToolUse', 'thinking'],
      ['UserPromptSubmit', 'thinking'],
      ['SessionStart', 'idle'],
      ['PreCompact', 'sweeping'],
      ['PostCompact', 'thinking'],
      ['PermissionRequest', 'blocked'],
      ['Interrupt', 'blocked'],
      ['Stop', 'done'],
      ['StopFailure', 'failed'],
      ['PostToolUseFailure', 'failed'],
    ]
    for (const [name, state] of cases) {
      assert.equal(event(name)?.state, state, `${name} 该落到 ${state}`)
    }
  })

  test('两个 agent 的事件都要认——codex 发 Interrupt 与 Pre/PostCompact，不发 PostToolUseFailure', () => {
    // 少认一个的后果是状态卡在旧值上：打断后一直显示「干活」
    assert.equal(event('Interrupt')?.state, 'blocked')
    assert.equal(event('PreCompact')?.state, 'sweeping')
    assert.equal(event('PostCompact')?.state, 'thinking')
  })

  test('认不出的 / 缺事件名的都不认，忽略即可，不抛错', () => {
    assert.equal(event('TeammateIdle'), null, '33 个事件里没挑的，忽略')
    assert.equal(normalizeHookEvent({ session_id: 's1' }), null)
    assert.equal(normalizeHookEvent({}), null)
  })

  test('一条会话只留最新一条；重复登记时后到覆盖先到', () => {
    const { store } = newState()
    recordHook({ hook_event_name: 'PreToolUse', session_id: 'a', cwd: '/tmp' }, CLAUDE, store)
    recordHook({ hook_event_name: 'PostToolUse', session_id: 'a', cwd: '/tmp' }, CLAUDE, store)
    assert.equal(store.get('claude', 'a')?.status.state, 'thinking')
  })

  test('缺 session_id / 子 agent 的事件都不动主会话状态', () => {
    const { store } = newState()
    assert.equal(recordHook({ hook_event_name: 'PreToolUse' }, CLAUDE, store), null, '没有 id 就没人可挂')
    recordHook(
      { hook_event_name: 'PreToolUse', session_id: 'a', cwd: '/tmp', agent_id: 'sub-1', agent_type: 'claude' },
      CLAUDE,
      store,
    )
    assert.equal(store.get('claude', 'a'), undefined, '子 agent 的生死不改主会话状态')
  })

  test('SessionEnd 把这条抹掉，读的时候自然退回落盘', () => {
    const { store } = newState()
    recordHook({ hook_event_name: 'Stop', session_id: 'a', cwd: '/tmp' }, CLAUDE, store)
    assert.equal(store.get('claude', 'a')?.status.state, 'done')
    assert.equal(recordHook({ hook_event_name: 'SessionEnd', session_id: 'a', cwd: '/tmp' }, CLAUDE, store), null)
    assert.equal(store.get('claude', 'a'), undefined)
  })

  test('条目按 agent 分开存：同一个会话 id 两条管道互不覆盖', () => {
    const { store } = newState()
    recordHook({ hook_event_name: 'PreToolUse', session_id: 'same', cwd: '/tmp' }, CLAUDE, store)
    recordHook({ hook_event_name: 'Stop', session_id: 'same', cwd: '/tmp' }, { agent: 'codex' }, store)
    assert.equal(store.get('claude', 'same')?.status.state, 'working')
    assert.equal(store.get('codex', 'same')?.status.state, 'done')
  })

  test('时刻新的覆盖旧的：陈年的 hook 事件盖不掉更新的落盘结论，反过来也不许', () => {
    const { store } = newState()
    const stale = Date.now() - 31 * 60_000
    const of = (state: SessionStatus['state'], observedAt: number): SessionStatus =>
      ({ state, needsAction: '', observedAt, detail: state })

    recordHook({ hook_event_name: 'Stop', session_id: 'a', cwd: '/tmp' }, { agent: 'claude', at: stale }, store)
    assert.equal(store.get('claude', 'a')?.status.state, 'done')

    store.put('claude', 'a', of('failed', Date.now()))
    assert.equal(store.get('claude', 'a')?.status.state, 'failed', '更新的落盘结论换掉它')

    store.put('claude', 'a', of('done', stale))
    assert.equal(store.get('claude', 'a')?.status.state, 'failed', '旧的盖不掉新的')
  })

  test('板侧写的 idle 一直摆着，直到有更新的观察落下来', () => {
    const { store } = newState()
    const clicked = Date.now() - 31 * 60_000
    store.put('claude', 'idle-1', idleStatus(clicked))
    assert.equal(store.get('claude', 'idle-1')?.status.state, 'idle', '过了多久都还在')

    // 更旧的落盘结论盖不掉它
    store.put('claude', 'idle-1', { state: 'done', needsAction: '', observedAt: clicked - 1, detail: '旧的' })
    assert.equal(store.get('claude', 'idle-1')?.status.state, 'idle')

    recordHook({ hook_event_name: 'PreToolUse', session_id: 'idle-1', cwd: '/tmp' }, {}, store)
    assert.equal(store.get('claude', 'idle-1')?.status.state, 'working', '更新的 hook 事件一到就覆盖')
  })
})

describe('hook 状态接进会话：优先 hook，读不到才落盘', () => {
  const HOME = join(TMP, 'hook-home')
  const roots = {
    appSupport: join(HOME, 'Library', 'Application Support'),
    claudeHome: join(HOME, '.claude'),
    codexHome: join(HOME, '.codex'),
    chengxiaobangHome: join(HOME, '.chengxiaobang'),
  }

  before(() => rmSync(HOME, { recursive: true, force: true }))

  /** 桌面记录的 fixture：登记 id 是 local_<uuid>，内层 cliSessionId 才是 hook 报的那个 */
  function claudeRecord(sessionId: string, rec: Record<string, unknown> = {}): void {
    const dir = join(roots.appSupport, 'Claude-3p', 'claude-code-sessions', 'acct', 'org')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ sessionId, ...rec }), 'utf8')
  }

  const { sources } = newState()

  const statusOf = (agent: string, session: string, store: SessionStateStore): SessionStatus => {
    const one = [{ agent, session }]
    pullStatuses(one, store, sources, roots)
    return readObservations(one, store)[0].status
  }

  test('hook 说在干活就顶掉落盘那份结论——同一 turn 内能看出切换', () => {
    const { store } = newState()
    claudeRecord('local_working', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 't1',
      lastAssistantUuid: 't1',
      postTurnSummary: { status_category: 'blocked', needs_action: '接着做吗？' },
    })
    recordHook({ hook_event_name: 'PreToolUse', session_id: 'local_working', cwd: '/tmp', tool_name: 'Bash' }, {}, store)
    const working = statusOf('claude', 'local_working', store)
    assert.equal(working.state, 'working')

    recordHook({ hook_event_name: 'PostToolUse', session_id: 'local_working', cwd: '/tmp', tool_name: 'Bash' }, {}, store)
    const thinking = statusOf('claude', 'local_working', store)
    assert.equal(thinking.state, 'thinking', '写回「思考」，同一 turn 内切换可见')
    assert.match(thinking.detail, /PostToolUse/)
  })

  test('登记 id 与 hook 报的 id 不同名时，靠记录的 cliSessionId 翻译', () => {
    const { store } = newState()
    const cli = 'e6a1f0c2-1111-2222-3333-444455556666'
    claudeRecord('local_translated', { cliSessionId: cli })
    recordHook({ hook_event_name: 'PreToolUse', session_id: cli, cwd: '/tmp' }, {}, store)
    assert.equal(statusOf('claude', 'local_translated', store).state, 'working')
  })

  test('两个 id 都对不上就退回落盘结论，不借同目录别的会话的 hook', () => {
    const { store } = newState()
    const dir = join(TMP, 'hook-home', 'worktree')
    mkdirSync(dir, { recursive: true })
    claudeRecord('local_bycwd', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 't5',
      lastAssistantUuid: 't5',
      postTurnSummary: { status_category: 'completed' },
    })
    // 同目录另一个会话在干活：id 对不上，就不是这条的事
    recordHook({ hook_event_name: 'PreToolUse', session_id: '别的会话', cwd: dir }, {}, store)
    const got = statusOf('claude', 'local_bycwd', store)
    assert.equal(got.state, 'done', '退回自己的落盘结论，不该是在干活')
  })

  test('同目录并排跑多个会话时互不点亮，各自只认自己的 id', () => {
    const { store } = newState()
    const dir = join(TMP, 'hook-home', 'shared-wt')
    mkdirSync(dir, { recursive: true })
    recordHook({ hook_event_name: 'PreToolUse', session_id: 'claude-x', cwd: dir }, {}, store)
    assert.equal(statusOf('claude', 'claude-x', store).state, 'working', '自己的照常')
    assert.equal(statusOf('claude', 'claude-y', store).state, 'unknown', '同目录的别人不沾光')
    assert.equal(statusOf('codex', 'claude-x', store).state, 'unknown', '两种 agent 也不互相点亮')
  })

  test('在跑的状态太久没动静就当它没了——进程崩了不会有收尾事件', () => {
    const { store } = newState()
    claudeRecord('local_stale', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 't2',
      lastAssistantUuid: 't2',
      postTurnSummary: { status_category: 'completed' },
    })
    recordHook({ hook_event_name: 'PreToolUse', session_id: 'local_stale', cwd: '/tmp' }, {
      agent: 'claude',
      at: Date.now() - 31 * 60_000,
    }, store)
    assert.equal(statusOf('claude', 'local_stale', store).state, 'done', '过期的 running 不该压住落盘结论')
  })

  test('过期的 blocked 也一样让位', () => {
    const { store } = newState()
    claudeRecord('local_stale_blocked', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 't4',
      lastAssistantUuid: 't4',
      postTurnSummary: { status_category: 'completed' },
    })
    recordHook({ hook_event_name: 'PermissionRequest', session_id: 'local_stale_blocked', cwd: '/tmp' }, {
      agent: 'claude',
      at: Date.now() - 31 * 60_000,
    }, store)
    assert.equal(statusOf('claude', 'local_stale_blocked', store).state, 'done')
  })

  test('没有 hook 时走原路：落盘结论 + activity 空串', () => {
    claudeRecord('local_disk', {
      lastActivityAt: Date.now(),
      postTurnSummaryFor: 't3',
      lastAssistantUuid: 't3',
      postTurnSummary: { status_category: 'review_ready' },
    })
    const got = statusOf('claude', 'local_disk', newState().store)
    assert.equal(got.state, 'done')
    assert.equal(got.detail, '桌面应用结论：review_ready')
  })
})

// -------------------------------------------- 未读事件：卡片角标该挂哪条会话

describe('未读事件：角标挂哪些会话', () => {
  function sess(agent: string, state: string): Session {
    return {
      requirementId: 'req-x',
      agent,
      session: `${agent}-1`,
      title: '',
      cwd: '',
      link: '',
      created: '',
      updated: '',
      status: { state: state as Session['status']['state'], needsAction: '', observedAt: 0, detail: '' },
      action: null,
    }
  }

  test('完成 / 卡住 / 失败都挂角标——它们会一直挂着，点过 pet 变成 idle 才消', () => {
    for (const s of ['done', 'blocked', 'failed']) {
      assert.equal(badgesOf([sess('claude', s)]).length, 1, `${s} 该挂`)
    }
  })

  test('正在跑也挂；idle（点过的）与 unknown（读不到）不挂', () => {
    assert.equal(badgesOf([sess('claude', 'thinking')]).length, 1)
    assert.deepEqual(badgesOf([sess('claude', 'idle')]), [])
    assert.deepEqual(badgesOf([sess('cursor', 'unknown')]), [])
  })

  test('告警色、原文、可点的角标三者同判据——要亮一起亮，要消一起消', () => {
    assert.equal(badgesOf([sess('claude', 'blocked')]).length, 1)
    assert.equal(badgesOf([sess('claude', 'thinking')]).length, 1)
  })

  test('读不到的、以及一条会话都没有时都不挂', () => {
    assert.deepEqual(badgesOf([sess('cursor', 'unknown')]), [])
    assert.deepEqual(badgesOf([]), [])
  })

  test('每个会话各挂一个，按急缓排序——同时开着几个 agent 时看得出是哪个在等', () => {
    const got = badgesOf([
      sess('codex', 'working'),
      sess('claude', 'done'),
      sess('codex', 'blocked'),
    ])
    assert.deepEqual(
      got.map((s) => s.status.state),
      ['blocked', 'done', 'working'],
    )
  })

  test('点过的（idle）不占位，剩下的照旧按急缓排', () => {
    const got = badgesOf([sess('claude', 'idle'), sess('claude', 'done'), sess('codex', 'working')])
    assert.deepEqual(
      got.map((s) => s.status.state),
      ['done', 'working'],
    )
  })

  test('isEventState 只认一轮结束抛给人的那三种，在干活与 unknown 不是事件', () => {
    assert.deepEqual(
      (['done', 'blocked', 'failed', 'thinking', 'working', 'idle', 'unknown'] as const).filter(isEventState),
      ['done', 'blocked', 'failed'],
    )
  })
})

describe('pet：姿势与抢注意力挑选', () => {
  test('状态字面量与状态层同一套，一个不多一个不少', () => {
    assert.deepEqual(
      [...THREAD_STATES].sort(),
      ['blocked', 'done', 'failed', 'idle', 'sweeping', 'thinking', 'unknown', 'working'],
    )
    assert.deepEqual(Object.keys(PET_LABEL).sort(), [...THREAD_STATES].sort(), '每一档都得有名字')
  })

  test('急缓顺序：卡住 > 失败 > 跑完 > 干活 > 思考 > 静止', () => {
    assert.ok(PET_RANK.blocked < PET_RANK.failed)
    assert.ok(PET_RANK.failed < PET_RANK.done)
    assert.ok(PET_RANK.done < PET_RANK.working)
    assert.ok(PET_RANK.working < PET_RANK.thinking)
    assert.ok(PET_RANK.thinking < PET_RANK.idle)
  })

  test('focus 只给 attention 三档：没有需要人注意的就返回 -1', () => {
    // 干活 / 思考的轻动是无条件的、不走 focus，所以只有「没人需要人注意」时才是 -1——
    // 这里刻意固定成意图，别有人再把它「修」回「挑一只 working」
    assert.equal(focusIndex([]), -1)
    assert.equal(focusIndex(['working']), -1)
    assert.equal(focusIndex(['idle', 'thinking', 'working']), -1)
    assert.equal(focusIndex(['working', 'done']), 1)
    assert.equal(focusIndex(['thinking', 'blocked']), 1)
    assert.equal(focusIndex(['blocked', 'failed', 'done']), 0)
  })

  test('并列取靠前的', () => {
    assert.equal(focusIndex(['done', 'failed']), 1)
    assert.equal(focusIndex(['failed', 'done']), 0)
  })
})

describe('pet 素材：agent → 形象、状态 → 文件、静态版', () => {
  const art = { compact: false, still: false }
  type ArtOpt = { compact: boolean; still: boolean; mood?: IdleMood }
  const PETS_DIR = join(REPO_ROOT, 'src/renderer/public/pets')

  /** 走 <img> 的素材：拿它的 src，顺带钉住通道 */
  const imgSrc = (agent: string, state: Pose, opt: ArtOpt = art) => {
    const got = petArt(agent, state, opt)
    assert.equal(got.channel, 'img')
    return got.channel === 'img' ? got.src : ''
  }

  /** 云宝内联：拿它那份 SVG 原文，顺带钉住通道 */
  const cloudlingSvg = (state: Pose, opt: ArtOpt = art) => {
    const got = petArt('codex', state, opt)
    assert.equal(got.channel, 'inline')
    return got.channel === 'inline' ? got.svg : ''
  }

  test('Claude 用 clawd，走 <img>：各档大图各一张', () => {
    assert.equal(imgSrc('claude', 'idle'), 'pets/clawd-idle-follow.svg')
    assert.equal(imgSrc('claude', 'thinking'), 'pets/clawd-working-thinking.svg')
    assert.equal(imgSrc('claude', 'working'), 'pets/clawd-working-typing.svg')
    assert.equal(imgSrc('claude', 'sweeping'), 'pets/clawd-working-sweeping.svg')
    assert.equal(imgSrc('claude', 'blocked'), 'pets/clawd-notification.svg')
    assert.equal(imgSrc('claude', 'done'), 'pets/clawd-happy.svg')
    assert.equal(imgSrc('claude', 'failed'), 'pets/clawd-error.svg')
  })

  test('Codex 用 cloudling，内联成 <svg>：各档一张、互不重样', () => {
    const files: Record<Pose, string> = {
      idle: 'cloudling-idle.svg',
      thinking: 'cloudling-thinking.svg',
      working: 'cloudling-typing.svg',
      sweeping: 'cloudling-sweeping.svg',
      blocked: 'cloudling-notification.svg',
      done: 'cloudling-attention.svg',
      failed: 'cloudling-error.svg',
    }
    const poses = THREAD_STATES.filter((s) => s !== 'unknown')
    for (const state of poses) {
      assert.equal(cloudlingSvg(state), CLOUDLING_SVG[files[state]], state)
    }
    assert.equal(new Set(poses.map((s) => cloudlingSvg(s))).size, poses.length)
  })

  test('认不出的 agent 落到 clawd（默认那只），不染不动', () => {
    assert.equal(imgSrc('cursor', 'done'), imgSrc('claude', 'done'))
    assert.equal(petArt('some-new-agent', 'done', art).channel, 'img')
  })

  test('程小帮也用云宝，走同一条内联通道', () => {
    const got = petArt('chengxiaobang', 'working', art)
    assert.equal(got.channel, 'inline')
    assert.equal(got.channel === 'inline' ? got.svg : '', CLOUDLING_SVG['cloudling-typing.svg'])
  })

  test('折叠卡换 mini 组（两套都有，failed 复用 alert）', () => {
    const mini = { compact: true, still: false }
    assert.equal(imgSrc('claude', 'idle', mini), 'pets/clawd-mini-idle.svg')
    assert.equal(imgSrc('claude', 'blocked', mini), 'pets/clawd-mini-alert.svg')
    assert.equal(imgSrc('claude', 'done', mini), 'pets/clawd-mini-happy.svg')
    assert.equal(imgSrc('claude', 'failed', mini), 'pets/clawd-mini-alert.svg')
    assert.equal(cloudlingSvg('idle', mini), CLOUDLING_SVG['cloudling-mini-idle.svg'])
    assert.equal(cloudlingSvg('working', mini), CLOUDLING_SVG['cloudling-mini-typing.svg'])
    assert.equal(cloudlingSvg('done', mini), CLOUDLING_SVG['cloudling-mini-happy.svg'])
    assert.equal(cloudlingSvg('failed', mini), CLOUDLING_SVG['cloudling-mini-alert.svg'])
  })

  test('静止越久越困：20s 打哈欠、10min 打盹、50min 瘫倒一下再睡', () => {
    const at = 1_700_000_000_000
    assert.equal(idleMoodOf(at, at + 19_999), 'awake')
    assert.equal(idleMoodOf(at, at + 20_000), 'yawning')
    assert.equal(idleMoodOf(at, at + 10 * 60_000), 'dozing')
    assert.equal(idleMoodOf(at, at + 50 * 60_000), 'collapsing')
    assert.equal(idleMoodOf(at, at + 50 * 60_000 + 5_000), 'sleeping')
    assert.equal(idleMoodOf(0, at), 'awake', '说不出时刻就当刚静下来')
  })

  test('静止那档按 mood 换图；折叠卡只有睡着的 mini', () => {
    const mood = (m: IdleMood): ArtOpt => ({ compact: false, still: false, mood: m })
    assert.equal(imgSrc('claude', 'idle', mood('awake')), 'pets/clawd-idle-follow.svg')
    assert.equal(imgSrc('claude', 'idle', mood('yawning')), 'pets/clawd-idle-yawn.svg')
    assert.equal(imgSrc('claude', 'idle', mood('dozing')), 'pets/clawd-idle-doze.svg')
    assert.equal(imgSrc('claude', 'idle', mood('collapsing')), 'pets/clawd-collapse-sleep.svg')
    assert.equal(imgSrc('claude', 'idle', mood('sleeping')), 'pets/clawd-sleeping.svg')
    assert.equal(cloudlingSvg('idle', mood('sleeping')), CLOUDLING_SVG['cloudling-sleeping.svg'])

    const mini = (m: IdleMood): ArtOpt => ({ compact: true, still: false, mood: m })
    assert.equal(imgSrc('claude', 'idle', mini('sleeping')), 'pets/clawd-mini-sleep.svg')
    assert.equal(cloudlingSvg('idle', mini('sleeping')), CLOUDLING_SVG['cloudling-mini-sleep.svg'])
    assert.equal(imgSrc('claude', 'idle', mini('yawning')), 'pets/clawd-mini-idle.svg')
    assert.equal(imgSrc('claude', 'working', mini('sleeping')), 'pets/clawd-mini-typing.svg')
  })

  test('reduced-motion：clawd 换静态版；云宝内联，由挂载时只放行首帧', () => {
    const still = { compact: false, still: true }
    assert.equal(imgSrc('claude', 'done', still), 'pets/clawd-happy.still.svg')
    assert.equal(imgSrc('claude', 'done', { compact: true, still: true }), 'pets/clawd-mini-happy.still.svg')
    assert.equal(cloudlingSvg('failed', still), cloudlingSvg('failed'))
    assert.equal(cloudlingSvg('blocked', { compact: true, still: true }), cloudlingSvg('blocked', { compact: true, still: false }))
  })

  test('走 <img> 的素材都真的落在 public/pets 里（生成物没漏）', () => {
    for (const agent of ['claude', 'cursor']) {
      // unknown 不画 pet，没有素材
      for (const state of THREAD_STATES.filter((s) => s !== 'unknown')) {
        for (const compact of [false, true]) {
          for (const still of [false, true]) {
            const src = imgSrc(agent, state, { compact, still })
            const rel = src.replace(/^pets\//, '')
            assert.ok(existsSync(join(PETS_DIR, rel)), `${agent}/${state} compact=${compact} still=${still} → ${src}`)
          }
        }
      }
    }
  })

  test('内联的云宝：17 档都在、都带脚本、都是收紧过的取景框', () => {
    assert.equal(Object.keys(CLOUDLING_SVG).length, 17)
    for (const [file, svg] of Object.entries(CLOUDLING_SVG)) {
      assert.match(svg, /^<svg /, file)
      assert.match(svg, /viewBox="-2 -2 28 28"/, file)
      assert.match(svg, /<script[^>]*>/, file)
    }
  })
})

describe('云宝内联：按实例改写 id', () => {
  const files = Object.keys(CLOUDLING_SVG)

  /** 素材里定义的全部 id */
  const idsIn = (text: string) => [...text.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1])

  /** 素材里所有「指向某个元素」的引用：标记与脚本里都有 */
  const refsIn = (text: string) => [
    ...[...text.matchAll(/(?:url\(#|href="#)([\w-]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/getElementById\(\s*(['"])([\w-]+)\1/g)].map((m) => m[2]),
    ...[...text.matchAll(/querySelector(?:All)?\(\s*(['"])([^'"]*)\1/g)].flatMap((m) =>
      [...m[2].matchAll(/#([\w-]+)/g)].map((x) => x[1]),
    ),
  ]

  test('每份素材都拆得出「静态标记 + 驱动脚本」，且脚本非空', () => {
    for (const file of files) {
      const { markup, script } = scopeCloudling(CLOUDLING_SVG[file], 'x1')
      assert.ok(markup.startsWith('<svg '), file)
      assert.doesNotMatch(markup, /<script/, file)
      assert.match(script, /getElementById/, file)
      assert.doesNotMatch(script, /<!\[CDATA\[/, file)
    }
  })

  test('id 定义与全部引用都加了同一个后缀，没漏的', () => {
    for (const file of files) {
      const raw = CLOUDLING_SVG[file]
      const { markup, script } = scopeCloudling(raw, 'x1')
      // 定义可能在静态标记里，也可能是脚本现拼的（thinking 那几个档）
      const defined = idsIn(markup + script)
      assert.deepEqual([...defined].sort(), idsIn(raw).map((id) => `${id}-x1`).sort(), file)
      // 引用一律要落到改写后的定义上：漏改一处，它就会指回没加后缀的原 id
      const refs = refsIn(markup + script)
      assert.ok(refs.length > 0, file)
      for (const ref of refs) {
        assert.ok(defined.includes(ref), `${file}: #${ref} 没加后缀，或指向不存在的元素`)
      }
    }
  })

  test('两份实例的后缀不同，同一份素材互不撞', () => {
    const a = scopeCloudling(CLOUDLING_SVG['cloudling-idle.svg'], 'a')
    const b = scopeCloudling(CLOUDLING_SVG['cloudling-idle.svg'], 'b')
    for (const id of idsIn(a.markup)) assert.ok(!b.markup.includes(`id="${id}"`), id)
    assert.notEqual(a.script, b.script)
  })

  test('style 里的颜色不是选择器，不该被改写', () => {
    const { markup } = scopeCloudling(CLOUDLING_SVG['cloudling-notification.svg'], 'x1')
    assert.match(markup, /#5870E8/)
  })
})

describe('pet：一行 pet 的排布', () => {
  function sess(
    agent: string,
    state: Session['status']['state'],
    title = '',
    action: SessionAction | null = null,
    needsAction = '',
  ): Session {
    return {
      requirementId: 'req-x',
      agent,
      session: `${agent}-${state}-${title}`,
      title,
      cwd: '',
      link: '',
      created: '',
      updated: '',
      status: { state, needsAction, observedAt: 0, detail: '' },
      action,
    }
  }
  const act = (text: string): SessionAction => ({ text, calledAt: 1 })
  // 五个都读得到的会话：两条在干活 + 一条卡住 + 跑完没看 + 失败（都挂 pet）
  const pool: Session[] = [
    sess('claude', 'blocked'),
    sess('codex', 'working'),
    sess('claude', 'done'),
    sess('codex', 'failed'),
    sess('claude', 'thinking'),
  ]

  test('读得到的会话全部出 pet，不截断', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(planPetRow(pool.slice(0, n)).items.length, n, `${n} 个会话`)
    }
  })

  test('全部按急缓排序，最急的排在最前', () => {
    // 登记顺序把最急的放在最后（会话来自 updated DESC，卡住不动的往往最早登记）
    const late: Session[] = [
      sess('claude', 'working'),
      sess('codex', 'thinking'),
      sess('claude', 'idle'),
      sess('codex', 'blocked'),
    ]
    assert.deepEqual(planPetRow(late).items.map((p) => p.state), ['blocked', 'working', 'thinking', 'idle'])
  })

  test('最多一只抢注意力，且只落在 attention 三档上', () => {
    const { items } = planPetRow(pool)
    assert.equal(items.filter((p) => p.focus).length, 1)
    assert.equal(items.find((p) => p.focus)?.state, 'blocked')
  })

  test('都只在干活时谁也不抢注意力', () => {
    const { items } = planPetRow([sess('claude', 'thinking'), sess('codex', 'working')])
    assert.deepEqual(items.map((p) => p.state), ['working', 'thinking'])
    assert.equal(items.some((p) => p.focus), false)
  })

  test('pet 长期留着：读得到的会话都画 pet，且点得到', () => {
    const read = planPetRow([sess('claude', 'done')])
    assert.equal(read.items.length, 1)
    assert.equal(read.items[0].state, 'done')
  })

  test('点过的（idle 档）落静止、不带事件样式、也不抢注意力', () => {
    const clicked = planPetRow([sess('claude', 'idle')]).items[0]
    assert.equal(clicked.state, 'idle')
    assert.equal(clicked.focus, false)
  })

  test('没读过的 done 姿势不变', () => {
    const unread = planPetRow([sess('claude', 'done')]).items[0]
    assert.equal(unread.state, 'done')
  })

  test('读不到的会话不画 pet，空列表也不破', () => {
    assert.deepEqual(planPetRow([sess('cursor', 'unknown')]).items, [])
    assert.deepEqual(planPetRow([]), { items: [] })
  })

  test('气泡那句话：干活且有实时动作报动作，其余报 title', () => {
    assert.equal(planPetRow([sess('claude', 'working', '收口 hook 管道', act('改 hook.ts'))]).items[0].bubble, '改 hook.ts')
    assert.equal(planPetRow([sess('claude', 'thinking', '想下一步')]).items[0].bubble, '想下一步')
    assert.equal(planPetRow([sess('claude', 'idle', '补单测', act('改 hook.ts'))]).items[0].bubble, '补单测')
    assert.equal(planPetRow([sess('claude', 'done', '跑完了', act('改 hook.ts'))]).items[0].bubble, '跑完了')
  })

  test('卡住且要人回答：气泡报那句话原文，压过动作与 title', () => {
    const asked = sess('claude', 'blocked', '1N-WS 出票重试', act('改 hook.ts'), '要不要把重试次数提到 3 次？')
    assert.equal(planPetRow([asked]).items[0].bubble, '要不要把重试次数提到 3 次？')
  })

  test('没写原文的卡住（打断 / 等授权那两条路径）退回 title', () => {
    assert.equal(planPetRow([sess('claude', 'blocked', '等你确认', act('改 hook.ts'))]).items[0].bubble, '等你确认')
  })

  test('气泡调子：事件三档用自己的状态色，静止一档暗，真在动的亮', () => {
    assert.equal(bubbleToneOf('blocked'), 'blocked')
    assert.equal(bubbleToneOf('done'), 'done')
    assert.equal(bubbleToneOf('failed'), 'failed')
    assert.equal(bubbleToneOf('idle'), 'title')
    for (const state of ['thinking', 'working', 'sweeping'] as const) {
      assert.equal(bubbleToneOf(state), 'act', `${state} 该是亮的那档`)
    }
  })

  test('title 与动作都空就不给气泡', () => {
    assert.equal(planPetRow([sess('claude', 'idle')]).items[0].bubble, '')
    assert.equal(planPetRow([sess('claude', 'working')]).items[0].bubble, '', '干活但没话说也一样')
  })
})

// ------------------------------------------------------------------ 收尾

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true })
  assert.ok(!existsSync(TMP))
})
