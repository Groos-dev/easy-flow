/**
 * easy-flow 核心回归测试。
 *
 * 目的：给重构提供可验证的行为基线。
 * 覆盖数据层（markdown 解析、sqlite 同步、状态读写）与 HTTP 层的外在行为，
 * 不测内部实现细节——所以重构实现时这些测试应保持全绿。
 *
 * 运行：node --test test/
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'

import { BoardDatabase, normalizeLinkList, normalizeExtLinks } from '../server/db.ts'
import { parseFrontmatter, readDocs, section } from '../server/markdown.ts'
import { createBoardApp } from '../server/index.ts'

const TMP = '/tmp/easy-flow-test'

/** 造一个需求目录 */
function makeReq(
  dataDir: string,
  project: string,
  slug: string,
  body: string,
  opts: { frontmatter?: Record<string, string>; docs?: Record<string, string>; symlink?: boolean } = {},
): string {
  const dir = join(dataDir, project, slug)
  mkdirSync(join(dir, 'docs'), { recursive: true })
  const fm = opts.frontmatter
    ? `---\n${Object.entries(opts.frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n`
    : ''
  writeFileSync(join(dir, 'AGENTS.md'), `${fm}${body}\n`, 'utf8')
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

    writeFileSync(join(dir, 'onex', 'alpha', 'AGENTS.md'), '# 新标题\n\n## 需求\n\n新描述', 'utf8')
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

  test('目录消失 → 标记孤儿但不丢状态', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    db.setStatus('alpha', 'Review')

    rmSync(join(dir, 'onex', 'alpha'), { recursive: true, force: true })
    const sync = db.syncProjects()
    assert.ok(sync.orphaned.includes('onex/alpha'))
    assert.equal(db.get('alpha')?.status, 'Review', '孤儿仍需可查且状态不丢')
    db.close()
  })

  test('目录恢复 → 从孤儿状态恢复', () => {
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
    assert.throws(() => db.setStatus('alpha', 'Done' as never), /未知状态/)
    assert.throws(() => db.setStatus('alpha', '开发中' as never), /未知状态/)
    assert.throws(() => db.setPriority('alpha', 'high' as never), /未知优先级/)
  })

  test('setStatus/setPriority 会更新 updated 字段', () => {
    const before = db.get('alpha')?.updated
    db.setStatus('alpha', '执行中')
    assert.match(db.get('alpha')?.updated ?? '', /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(before !== undefined)
  })

  test('操作不存在的需求会报错', () => {
    assert.throws(() => db.setStatus('nope', '澄清'), /需求不存在/)
    assert.throws(() => db.setPriority('nope', 'p0'), /需求不存在/)
    assert.throws(() => db.rename('nope', 'x'), /需求不存在/)
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
    assert.throws(() => normalizeLinkList('str' as never), /数组/)
  })

  test('normalizeExtLinks 要求 detail 与 url 成对', () => {
    const ok = normalizeExtLinks([{ detail: '设计', url: 'https://a.com' }])
    assert.deepEqual(ok, [{ detail: '设计', url: 'https://a.com' }])
    assert.throws(() => normalizeExtLinks([{ detail: '缺链接' }]), /缺少 url/)
    assert.throws(() => normalizeExtLinks([{ url: 'https://a.com' }]), /缺少描述/)
  })

  test('setLinks 部分更新，未传的字段不动', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()

    db.setLinks('alpha', { feishuTaskLinks: ['https://feishu.cn/1'] })
    db.setLinks('alpha', { codeLinks: ['https://gitlab.com/mr/1'] })

    const req = db.get('alpha')
    assert.deepEqual(req?.feishuTaskLinks, ['https://feishu.cn/1'])
    assert.deepEqual(req?.codeLinks, ['https://gitlab.com/mr/1'])
    assert.deepEqual(req?.extLinks, [])
    db.close()
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

// ------------------------------------------------------------ 数据层：项目

describe('数据层 · 项目增删', () => {
  test('createProject 建目录并注册', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    const p = db.createProject('demo', '演示')
    assert.equal(p.slug, 'demo')
    assert.equal(p.name, '演示')
    assert.ok(existsSync(join(dir, 'demo')))
    db.close()
  })

  test('createProject 校验标识格式并拒绝重名', () => {
    const dir = fresh((d) => makeReq(d, 'onex', 'alpha', '# alpha'))
    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.throws(() => db.createProject('Bad Slug', 'x'), /英文小写/)
    db.createProject('demo', '演示')
    assert.throws(() => db.createProject('demo', '再来'), /已存在/)
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

// ---------------------------------------------------------------- HTTP 层

describe('HTTP 层', () => {
  let dir: string
  let db: BoardDatabase
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string

  before(async () => {
    dir = fresh((d) => {
      makeReq(d, 'onex', 'alpha', '# alpha\n\n## 需求\n\n甲需求内容')
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
    db?.close()
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

  test('GET /api/tree 返回项目树', async () => {
    const r = await get('/api/tree')
    assert.ok(Array.isArray(r.tree))
    const onex = r.tree.find((p: any) => p.slug === 'onex')
    assert.ok(onex && Array.isArray(onex.requirements))
  })

  test('POST /api/move 改状态并落库', async () => {
    const r = await post('/api/move', { slug: 'alpha', status: 'Review' })
    assert.equal(r.status, 'Review')
    const list = await get('/api/requirements')
    assert.equal(list.requirements.find((x: any) => x.slug === 'alpha').status, 'Review')
  })

  test('POST /api/move 拒绝未知列', async () => {
    const r = await post('/api/move', { slug: 'alpha', status: 'Done' })
    assert.match(r.error, /未知状态/)
  })

  test('POST /api/update 支持改阶段与优先级', async () => {
    const r = await post('/api/update', { slug: 'alpha', status: 'Review', priority: 'p1' })
    assert.equal(r.status, 'Review')
    assert.equal(r.priority, 'p1')
  })

  test('POST /api/update 拒绝非法枚举', async () => {
    assert.match((await post('/api/update', { slug: 'alpha', status: '开发中' })).error, /未知状态/)
    assert.match((await post('/api/update', { slug: 'alpha', priority: 'high' })).error, /未知优先级/)
  })

  test('GET /api/search 返回命中的完整需求对象', async () => {
    const r = await get('/api/search?q=' + encodeURIComponent('甲需求'))
    assert.ok(r.requirements.some((x: any) => x.slug === 'alpha'))
  })

  test('GET /api/context 返回需求与原文', async () => {
    const r = await get('/api/context?slug=alpha')
    assert.equal(r.requirement.slug, 'alpha')
    assert.match(r.agentsMd, /甲需求内容/)
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
    assert.match(up.error, /越界|不支持/)
    const abs = await get('/api/doc?slug=alpha&name=' + encodeURIComponent('/etc/hosts'))
    assert.match(abs.error, /绝对路径|不支持/)
    const traverse = await get(
      '/api/doc?slug=alpha&name=' + encodeURIComponent('../../../package.json'),
    )
    assert.match(traverse.error, /越界|不支持/)
  })

  test('文档接口拒绝非文本类型', async () => {
    const r = await get('/api/doc?slug=alpha&name=shell.sh')
    assert.match(r.error, /不支持的文件类型/)
  })

  test('项目接口：列表 / 建 / 切 / 删', async () => {
    const created = await post('/api/projects', { slug: 'demo', name: '演示' })
    assert.equal(created.slug, 'demo')

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

  test('不能删除当前项目', async () => {
    const r = await post('/api/projects/delete', { slug: 'onex', removeFiles: false })
    assert.match(r.error, /不能删除当前/)
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
    assert.match(r.error, /需求不存在/)
  })
})

// ------------------------------------------------------------------ 收尾

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true })
  assert.ok(!existsSync(TMP))
})
