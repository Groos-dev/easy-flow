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
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BoardDatabase, normalizeLinkList, normalizeExtLinks } from '../server/db.ts'
import { parseFrontmatter, readDocs, section } from '../server/markdown.ts'
import { createProjectDir, createRequirementDir, setRequirementId } from '../server/convention.ts'
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
  // 两份齐备才算需求：AGENTS.md 放 agent 指令，requirement.md 放需求描述
  writeFileSync(join(dir, 'AGENTS.md'), '<!-- agent 指令 -->\n', 'utf8')
  writeFileSync(join(dir, 'requirement.md'), `${fm}${body}\n`, 'utf8')
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
    writeFileSync(desc, readFileSync(desc, 'utf8').replace('# 需求标题', '# 抄模板建的需求'), 'utf8')
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

    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.equal(db.listProjects().find((p) => p.slug === 'demo')?.name, '示例项目')
    db.close()
  })

  test('createProjectDir 拒绝非法标识与已存在的目录', () => {
    const dir = fresh(() => {})
    assert.throws(() => createProjectDir(dir, 'Bad_Slug'), /英文小写/)
    createProjectDir(dir, 'demo')
    assert.throws(() => createProjectDir(dir, 'demo'), /目录已存在/)
  })

  test('createRequirementDir 写齐两份文件，id 落进 frontmatter', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const created = createRequirementDir(join(dir, 'onex'), 'cny-not-rmb', '币种改 CNY', '上游只认 CNY')
    assert.ok(existsSync(join(created.dir, 'AGENTS.md')))
    const desc = readFileSync(join(created.dir, 'requirement.md'), 'utf8')
    assert.match(desc, new RegExp(`^---\\nid: ${created.id}\\n---$`, 'm'))
    assert.match(desc, /^# 币种改 CNY$/m)
    assert.match(desc, /## 需求\n\n上游只认 CNY/)

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
    assert.throws(() => createRequirementDir(root, '中文名', 'x'), /英文小写/)
    createRequirementDir(root, 'alpha', 'x')
    assert.throws(() => createRequirementDir(root, 'alpha', 'x'), /目录已存在/)
  })

  test('setRequirementId 只动 frontmatter，正文原样保留', () => {
    const dir = fresh(() => {})
    const reqDir = join(dir, 'onex', 'legacy')
    mkdirSync(reqDir, { recursive: true })
    writeFileSync(join(reqDir, 'AGENTS.md'), '<!-- 指令 -->\n', 'utf8')
    writeFileSync(join(reqDir, 'requirement.md'), '# 老需求\n\n## 需求\n\n正文不能动。\n', 'utf8')

    setRequirementId(reqDir, 'req-abc1234567')
    const after = readFileSync(join(reqDir, 'requirement.md'), 'utf8')
    assert.equal(after, '---\nid: req-abc1234567\n---\n\n# 老需求\n\n## 需求\n\n正文不能动。\n')

    // 再补一次：幂等，不叠加 frontmatter
    setRequirementId(reqDir, 'req-abc1234567')
    assert.equal(readFileSync(join(reqDir, 'requirement.md'), 'utf8'), after)
  })

  test('子需求建在父需求下，结构相同；但看板只扫一层，还认不到它', () => {
    const dir = fresh(() => {
      createProjectDir(TMP, 'onex')
    })
    const root = join(dir, 'onex')
    const parent = createRequirementDir(root, 'parent', '父需求')
    const child = createRequirementDir(parent.dir, 'child', '子需求')
    assert.ok(existsSync(join(child.dir, 'requirement.md')))

    const db = new BoardDatabase(dir)
    db.syncProjects()
    assert.deepEqual(db.list().map((r) => r.slug), ['parent'])
    // 父需求能按 id 反查，子需求还不能——它在库里根本没有行
    assert.equal(db.byId(parent.id)?.slug, 'parent')
    assert.equal(db.byId(child.id), undefined)
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
      ['requirement.md'],
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
      ['requirement.md', 'tasks/step-1/plan.md'],
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

// ------------------------------------------------------------------ MCP

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 起真的 mcp 进程走一遍 stdio 协议。
 * server/mcp.ts 是入口脚本（import 即连接），没法进程内调，只能当客户端说话。
 */
function mcpSession(
  configFile: string,
  requests: Array<Record<string, unknown>>,
  extraEnv: Record<string, string> = {},
): Promise<Array<{ id?: number; result?: any; error?: { message: string } }>> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env, EASY_FLOW_CONFIG: configFile }
    // 身份只该来自调用方，别让跑测试的 shell 里的残留 env 干扰
    delete env.EASY_FLOW_PROJECT
    delete env.EASY_FLOW_REQUIREMENT_ID
    Object.assign(env, extraEnv)

    const child = spawn(join(REPO_ROOT, 'node_modules/.bin/tsx'), [join(REPO_ROOT, 'server/mcp.ts')], {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const expected = requests.filter((r) => r.id !== undefined).length
    const out: Array<{ id?: number; result?: any; error?: { message: string } }> = []
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('mcp 进程超时'))
    }, 60_000)

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        out.push(JSON.parse(line))
        // 收齐就关 stdin，进程随之退出，不用干等
        if (out.filter((m) => m.id !== undefined).length >= expected) child.stdin.end()
      }
    })
    child.on('error', reject)
    child.on('exit', () => {
      clearTimeout(timer)
      // 一条响应都没收到，八成是进程起不来，把 stderr 一起抛出来
      if (!out.length && stderr.trim()) reject(new Error(`mcp 进程没有响应：${stderr.trim()}`))
      else resolve(out)
    })
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`)
  })
}

/** 一次会话只调一个工具，返回结果文本 */
async function callTool(
  configFile: string,
  name: string,
  args: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
): Promise<{ isError: boolean; text: string }> {
  const [reply] = await mcpSession(
    configFile,
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }],
    extraEnv,
  )
  return { isError: !!reply.result.isError, text: reply.result.content[0].text }
}

describe('MCP 层', () => {
  const base = '/tmp/easy-flow-mcp-test'
  const dataDir = join(base, 'data')
  const configFile = join(base, 'config.json')

  function scaffold(): string {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(configFile, JSON.stringify({ dataDir }), 'utf8')
    return configFile
  }

  test('工具面：建项目与需求，缺上下文时报可读错误', async () => {
    const replies = await mcpSession(scaffold(), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_project', arguments: { slug: 'demo', name: '示例项目' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_requirement', arguments: { project: 'demo', title: '支持 1A 重试', slug: 'seat-retry', summary: '失败重试一次' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_requirement', arguments: { title: '没有项目上下文' } } },
    ])

    const byId = new Map(replies.filter((r) => r.id !== undefined).map((r) => [r.id, r.result]))
    assert.deepEqual(
      byId.get(2).tools.map((t: { name: string }) => t.name).sort(),
      ['assign_ids', 'create_project', 'create_requirement', 'create_sub_requirement', 'get_context'],
    )
    assert.match(byId.get(3).content[0].text, /已创建项目「示例项目」/)
    assert.match(byId.get(4).content[0].text, /需求 id：req-/)
    assert.equal(byId.get(5).isError, true)
    assert.match(byId.get(5).content[0].text, /缺少 project/)

    const db = new BoardDatabase(dataDir)
    const r = db.get('seat-retry', 'demo')!
    assert.equal(r.title, '支持 1A 重试')
    assert.equal(r.status, '澄清')
    assert.match(r.id, /^req-/)
    assert.equal(db.listProjects().find((p) => p.slug === 'demo')?.name, '示例项目')
    db.close()
  })

  test('get_context 只按 id 反查：显式传、env 传都行，缺 id 报错', async () => {
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

    const byArg = await callTool(configFile, 'get_context', { id: created.id })
    assert.equal(byArg.isError, false)
    assert.match(byArg.text, new RegExp(`需求 id：${created.id}`))
    assert.match(byArg.text, /项目：demo（示例项目）/)
    assert.match(byArg.text, /需求：CSD 接 TF 标准价（csd-price）/)
    assert.match(byArg.text, /状态：澄清/)
    assert.match(byArg.text, /先查 CK 再改代码/)
    assert.match(byArg.text, /跟 supply 对了/)

    const byEnv = await callTool(configFile, 'get_context', {}, { EASY_FLOW_REQUIREMENT_ID: created.id })
    assert.match(byEnv.text, new RegExp(`需求 id：${created.id}`))

    const noId = await callTool(configFile, 'get_context')
    assert.equal(noId.isError, true)
    assert.match(noId.text, /缺少需求 id/)

    const unknown = await callTool(configFile, 'get_context', { id: 'req-nope' })
    assert.equal(unknown.isError, true)
    assert.match(unknown.text, /找不到需求：req-nope/)
  })

  test('assign_ids 给老需求补 id，幂等', async () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    // 手写一个没有 id 的老需求
    const legacy = join(dataDir, 'demo', 'legacy')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'AGENTS.md'), '<!-- 指令 -->\n', 'utf8')
    writeFileSync(join(legacy, 'requirement.md'), '# 老需求\n\n## 需求\n\n正文不能动。\n', 'utf8')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    assert.equal(seed.get('legacy', 'demo')?.id, '')
    seed.close()

    const first = await callTool(configFile, 'assign_ids')
    assert.match(first.text, /已补 1 个：\ndemo\/legacy → req-/)
    const desc = readFileSync(join(legacy, 'requirement.md'), 'utf8')
    const id = /id: (req-\w+)/.exec(desc)![1]
    assert.equal(desc, `---\nid: ${id}\n---\n\n# 老需求\n\n## 需求\n\n正文不能动。\n`)

    const db = new BoardDatabase(dataDir)
    db.syncProjects()
    assert.equal(db.get('legacy', 'demo')?.id, id)
    assert.equal(db.byId(id)?.slug, 'legacy')
    db.close()

    const again = await callTool(configFile, 'assign_ids')
    assert.match(again.text, /所有需求都已有 id/)
    rmSync(base, { recursive: true, force: true })
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
    assert.match(r.requirementMd, /甲需求内容/)
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
