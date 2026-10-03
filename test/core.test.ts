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
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync, cpSync, realpathSync, lstatSync, readlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createServer } from 'node:http'

import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BoardDatabase, normalizeLinkList, normalizeExtLinks } from '../server/db.ts'
import { parseFrontmatter, readDocs, section } from '../server/markdown.ts'
import { createProjectDir, createRequirementDir, setRequirementId } from '../server/convention.ts'
import { createBoardApp } from '../server/index.ts'

// 夹具不该受用户全局 git 配置影响：core.hooksPath 指向 lefthook，每条命令都要跑它，
// 偶尔会卡上几分钟（还会让随后的 rmSync 撞 ENOTEMPTY）。身份由每条命令显式 -c 传，够用。
process.env.GIT_CONFIG_GLOBAL = '/dev/null'

const TMP = '/tmp/easy-flow-test'

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
    const desc = readFileSync(join(created.dir, 'requirement.md'), 'utf8')
    assert.ok(!desc.includes('id:'))
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
    delete env.EASY_FLOW_REPO_ROOTS
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

const GIT_TMP = '/tmp/easy-flow-git-test'

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

  test('目录消失标孤儿、回来即恢复，记录一直留着', () => {
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
    assert.deepEqual(sync.worktrees.orphaned, ['wt-gone'])
    assert.equal(db.worktreeById('wt-gone')!.orphan, true)
    assert.equal(db.listWorktrees(req.id).length, 2)

    mkdirSync(join(d, 'wt-gone'), { recursive: true })
    sync = db.syncProjects()
    assert.deepEqual(sync.worktrees.restored, ['wt-gone'])
    assert.equal(db.worktreeById('wt-gone')!.orphan, false)
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
      [
        'add_links',
        'assign_ids',
        'create_project',
        'create_requirement',
        'create_sub_requirement',
        'create_worktree',
        'get_context',
        'import_worktrees',
        'remove_worktree',
        'update_requirement',
      ],
    )
    assert.match(byId.get(3).content[0].text, /已创建项目「示例项目」/)
    assert.match(byId.get(4).content[0].text, /需求 id：req-/)
    assert.equal(byId.get(5).isError, true)
    // project 是必填参数，缺了由参数校验挡下（指名了工具与字段）
    assert.match(byId.get(5).content[0].text, /create_requirement/)
    assert.match(byId.get(5).content[0].text, /project/)

    const db = new BoardDatabase(dataDir)
    const r = db.get('seat-retry', 'demo')!
    assert.equal(r.title, '支持 1A 重试')
    assert.equal(r.status, '澄清')
    assert.match(r.id, /^req-/)
    assert.equal(db.listProjects().find((p) => p.slug === 'demo')?.name, '示例项目')
    db.close()
  })

  test('get_context 只按 id 反查：必须显式传，缺 id 报错', async () => {
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

    const noId = await callTool(configFile, 'get_context')
    assert.equal(noId.isError, true)
    assert.match(noId.text, /缺少需求 id/)

    const unknown = await callTool(configFile, 'get_context', { id: 'req-nope' })
    assert.equal(unknown.isError, true)
    assert.match(unknown.text, /找不到需求：req-nope/)
  })

  test('create_worktree：目录、身份文件、软链、exclude、落库一次做完', async () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo', '示例项目')
    const created = createRequirementDir(join(dataDir, 'demo'), 'seatmap-truemap', '接真图数据源', '新增 TRUEMAP')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const args = { requirementId: created.id, repo: repoName, branch: 'feature-truemap', short: 'router' }
    const res = await callTool(configFile, 'create_worktree', args, env)
    assert.equal(res.isError, false, res.text)
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(res.text)?.[1]
    assert.ok(id, res.text)

    const wtPath = join(workspace, `${repoName}.feature-truemap`)
    assert.equal(sh(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-truemap')
    assert.match(readFileSync(join(wtPath, 'AGENTS.md'), 'utf8'), new RegExp(`id: ${id}`))
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
    const again = await callTool(configFile, 'create_worktree', args, env)
    assert.equal(again.isError, false, again.text)
    assert.equal(/worktree id：(wt-[0-9a-f]+)/.exec(again.text)?.[1], id)
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

  test('create_worktree 拒绝：分支在别处检出、路径被占、分支名非法', async () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const call = (branch: string) =>
      callTool(configFile, 'create_worktree', { requirementId: created.id, repo: repoName, branch }, env)

    // 手工在别的路径建一个，占住分支
    const who = ['-c', 'user.name=test', '-c', 'user.email=test@test']
    execFileSync('git', ['-C', repo, ...who, 'worktree', 'add', '-q', join(workspace, 'manual'), '-b', 'feature-taken'])
    const taken = await call('feature-taken')
    assert.equal(taken.isError, true)
    assert.match(taken.text, /已在 .*manual 检出/)

    // 目标路径被普通目录占着
    mkdirSync(join(workspace, `${repoName}.feature-blocked`), { recursive: true })
    const blocked = await call('feature-blocked')
    assert.equal(blocked.isError, true)
    assert.match(blocked.text, /已被占用/)

    // 非法分支名在预检就挡下，不留任何东西
    const bad = await call('feature bad')
    assert.equal(bad.isError, true)
    assert.match(bad.text, /check-ref-format/)
    assert.equal(existsSync(join(workspace, `${repoName}.feature bad`)), false)

    // 走到 git 自己的失败：报错要带 fatal 那句，而不是 stderr 的进度行
    const badBase = await callTool(
      configFile,
      'create_worktree',
      { requirementId: created.id, repo: repoName, branch: 'feature-new', base: 'no-such-ref' },
      env,
    )
    assert.equal(badBase.isError, true)
    assert.match(badBase.text, /invalid reference/)
    // git 自己什么都没建出来
    assert.equal(existsSync(join(workspace, `${repoName}.feature-new`)), false)
    assert.equal(sh(repo, 'branch', '--list', 'feature-new'), '')
  })

  test('同一条分支被另一个需求再要一次：报错，且不动那个 worktree', async () => {
    scaffold()
    const { workspace, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const alpha = createRequirementDir(join(dataDir, 'demo'), 'alpha', '甲需求', '摘要')
    const beta = createRequirementDir(join(dataDir, 'demo'), 'beta', '乙需求', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const first = await callTool(
      configFile,
      'create_worktree',
      { requirementId: alpha.id, repo: repoName, branch: 'feature-shared' },
      env,
    )
    assert.equal(first.isError, false, first.text)
    const wtPath = join(workspace, `${repoName}.feature-shared`)
    writeFileSync(join(wtPath, 'README.md'), 'work in progress\n')

    const second = await callTool(
      configFile,
      'create_worktree',
      { requirementId: beta.id, repo: repoName, branch: 'feature-shared' },
      env,
    )
    assert.equal(second.isError, true)
    // 兜底的是「软链不覆盖」，不是归属预检——正常不会走到这里，走到了也不能动别人的目录
    assert.match(second.text, /已指向/)

    // 甲的目录、分支与未提交改动一样不少
    assert.equal(existsSync(wtPath), true)
    assert.equal(readFileSync(join(wtPath, 'README.md'), 'utf8'), 'work in progress\n')
    assert.equal(sh(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-shared')

    const db = new BoardDatabase(dataDir)
    assert.equal(db.listWorktrees(alpha.id).length, 1)
    assert.equal(db.listWorktrees(beta.id).length, 0)
    db.close()
  })

  test('重复认领撞上不一致的软链：报错，但不回滚，目录与未提交改动原样', async () => {
    scaffold()
    const { workspace, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const args = { requirementId: created.id, repo: repoName, branch: 'feature-own' }
    const made = await callTool(configFile, 'create_worktree', args, env)
    assert.equal(made.isError, false, made.text)
    const wtPath = join(workspace, `${repoName}.feature-own`)
    writeFileSync(join(wtPath, 'README.md'), 'half done\n')

    // 把软链指到别处，制造一个「认领走到一半失败」的现场
    rmSync(join(wtPath, 'requirement.md'))
    symlinkSync(join(wtPath, 'README.md'), join(wtPath, 'requirement.md'))

    const again = await callTool(configFile, 'create_worktree', args, env)
    assert.equal(again.isError, true)
    assert.match(again.text, /已指向/)

    // 认领失败不回滚，更不该丢未提交改动
    assert.equal(existsSync(wtPath), true)
    assert.equal(readFileSync(join(wtPath, 'README.md'), 'utf8'), 'half done\n')
    assert.equal(sh(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-own')
    const db = new BoardDatabase(dataDir)
    assert.equal(db.listWorktrees(created.id).length, 1)
    db.close()
  })

  test('认领已有 worktree：不覆盖仓库自己的 AGENTS.md，并说明 id 只在库里', async () => {
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
    const res = await callTool(
      configFile,
      'create_worktree',
      { requirementId: created.id, repo: repoName, branch: 'feature-owned' },
      env,
    )
    assert.equal(res.isError, false, res.text)
    assert.match(res.text, /本就存在/)
    assert.match(res.text, /没落进文件/)
    assert.equal(readFileSync(join(wtPath, 'AGENTS.md'), 'utf8'), '仓库自己的指令，别动\n')
    // 软链与 exclude 照补
    assert.equal(
      readFileSync(join(wtPath, 'requirement.md'), 'utf8'),
      readFileSync(join(created.dir, 'requirement.md'), 'utf8'),
    )
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/requirement\.md$/m)

    const id = /worktree id：(wt-[0-9a-f]+)/.exec(res.text)![1]
    const db = new BoardDatabase(dataDir)
    assert.equal(db.worktreeById(id)!.path, wtPath)
    db.close()
  })

  test('git 登记被手工删掉后，remove_worktree 仍能清干净', async () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const made = await callTool(
      configFile,
      'create_worktree',
      { requirementId: created.id, repo: repoName, branch: 'feature-orphan' },
      env,
    )
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(made.text)![1]
    const wtPath = join(workspace, `${repoName}.feature-orphan`)

    // 模拟别处 prune 过：git 不再认它，目录还在
    rmSync(join(repo, '.git', 'worktrees', basename(wtPath)), { recursive: true, force: true })

    // 这种目录问不出 git status，所以必须显式 force
    const guarded = await callTool(configFile, 'remove_worktree', { id })
    assert.equal(guarded.isError, true)
    assert.match(guarded.text, /判断不了工作区是否干净/)

    const res = await callTool(configFile, 'remove_worktree', { id, force: true })
    assert.equal(res.isError, false, res.text)
    assert.equal(existsSync(wtPath), false)
    const db = new BoardDatabase(dataDir)
    assert.equal(db.worktreeById(id), undefined)
    db.close()
  })

  test('remove_worktree：脏工作区要 force，分支永远保留', async () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const made = await callTool(
      configFile,
      'create_worktree',
      { requirementId: created.id, repo: repoName, branch: 'feature-x' },
      env,
    )
    assert.equal(made.isError, false, made.text)
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(made.text)![1]
    const wtPath = join(workspace, `${repoName}.feature-x`)

    writeFileSync(join(wtPath, 'README.md'), 'changed\n')
    const refuse = await callTool(configFile, 'remove_worktree', { id })
    assert.equal(refuse.isError, true)
    assert.match(refuse.text, /未提交改动/)

    const forced = await callTool(configFile, 'remove_worktree', { id, force: true })
    assert.equal(forced.isError, false, forced.text)
    assert.match(forced.text, /丢弃了 1 处未提交改动/)
    assert.match(forced.text, /分支 feature-x 已保留/)
    assert.equal(existsSync(wtPath), false)
    assert.equal(sh(repo, 'branch', '--list', 'feature-x'), 'feature-x')

    const db = new BoardDatabase(dataDir)
    assert.equal(db.worktreeById(id), undefined)
    db.close()
  })

  test('get_context 多态：wt- 拿到工作区与需求，裸值当项目', async () => {
    scaffold()
    const { workspace, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo', '示例项目')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '接真图', '新增 TRUEMAP')
    writeFileSync(join(created.dir, 'context.md'), '跟 supply 对过：灰度按航司放。', 'utf8')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const made = await callTool(
      configFile,
      'create_worktree',
      { requirementId: created.id, repo: repoName, branch: 'feature-x', short: 'router' },
      env,
    )
    const id = /worktree id：(wt-[0-9a-f]+)/.exec(made.text)![1]

    const byWt = await callTool(configFile, 'get_context', { id }, env)
    assert.equal(byWt.isError, false, byWt.text)
    assert.match(byWt.text, new RegExp(`worktree id：${id}`))
    assert.match(byWt.text, /分支：feature-x/)
    assert.match(byWt.text, new RegExp(`需求 id：${created.id}`))
    assert.match(byWt.text, /新增 TRUEMAP/)
    assert.match(byWt.text, /灰度按航司放/)

    const byReq = await callTool(configFile, 'get_context', { id: created.id }, env)
    assert.match(byReq.text, /## worktree（1）/)
    assert.match(byReq.text, new RegExp(id))

    const byProject = await callTool(configFile, 'get_context', { id: 'demo' }, env)
    assert.match(byProject.text, /项目：示例项目（demo）/)
    assert.match(byProject.text, new RegExp(`${created.id}.*1 个 worktree`))

    const nowhere = await callTool(configFile, 'get_context', { id: 'nope' }, env)
    assert.equal(nowhere.isError, true)
    assert.match(nowhere.text, /现有项目/)
  })

  test('import_worktrees：收编旧布局的 worktree，幂等，且一个工作区只归一个需求', async () => {
    scaffold()
    const { workspace, repo, repoName } = gitFixture()
    createProjectDir(dataDir, 'demo')
    const alpha = createRequirementDir(join(dataDir, 'demo'), 'alpha', '甲需求', '摘要')
    const beta = createRequirementDir(join(dataDir, 'demo'), 'beta', '乙需求', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    // 旧工作流留下的形态：worktree 不在 <仓库>.<分支> 这个规范路径上，靠需求目录的软链认人
    const legacy = join(workspace, 'legacy-checkout')
    const who = ['-c', 'user.name=test', '-c', 'user.email=test@test']
    execFileSync('git', ['-C', repo, ...who, 'worktree', 'add', '-q', legacy, '-b', 'feature-legacy'])
    symlinkSync(legacy, join(alpha.dir, 'router'))
    // 同一个工作区还被另一个需求链着
    symlinkSync(legacy, join(beta.dir, 'router'))

    const env = { EASY_FLOW_REPO_ROOTS: workspace }
    const res = await callTool(configFile, 'import_worktrees', { requirementId: alpha.id }, env)
    assert.equal(res.isError, false, res.text)
    assert.match(res.text, /收编 1 个/)
    assert.match(res.text, /feature-legacy/)

    // 产物齐了
    assert.match(readFileSync(join(legacy, 'AGENTS.md'), 'utf8'), /^id: wt-/m)
    assert.equal(
      readFileSync(join(legacy, 'requirement.md'), 'utf8'),
      readFileSync(join(alpha.dir, 'requirement.md'), 'utf8'),
    )
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/requirement\.md$/m)

    const db = new BoardDatabase(dataDir)
    const wts = db.listWorktrees(alpha.id)
    assert.equal(wts.length, 1)
    assert.equal(wts[0].path, legacy)
    assert.equal(wts[0].branch, 'feature-legacy')
    assert.equal(wts[0].short, 'router')
    assert.equal(wts[0].repo, repoName)
    assert.equal(wts[0].main, repo)
    db.close()

    // 幂等：同一个需求再跑，跳过；另一个需求来要同一路径，也跳过（先登记者得）
    const again = await callTool(configFile, 'import_worktrees', { requirementId: alpha.id }, env)
    assert.match(again.text, /收编 0 个/)
    assert.match(again.text, /已归/)
    const other = await callTool(configFile, 'import_worktrees', { requirementId: beta.id }, env)
    assert.match(other.text, /收编 0 个/)
    assert.match(other.text, /甲需求/)
  })

  test('update_requirement 与 add_links：按 id 改，链接只增不删', async () => {
    scaffold()
    createProjectDir(dataDir, 'demo')
    const created = createRequirementDir(join(dataDir, 'demo'), 'alpha', '标题', '摘要')
    const seed = new BoardDatabase(dataDir)
    seed.syncProjects()
    seed.close()

    const moved = await callTool(configFile, 'update_requirement', {
      id: created.id,
      status: '执行中',
      priority: 'p1',
    })
    assert.equal(moved.isError, false, moved.text)
    assert.match(moved.text, /状态：执行中 · 优先级：p1/)

    const links = await callTool(configFile, 'add_links', {
      id: created.id,
      codeLinks: ['https://gitlab.example.com/mr/1'],
      extLinks: [{ detail: '设计稿', url: 'https://example.com/design' }],
    })
    assert.equal(links.isError, false, links.text)
    assert.match(links.text, /代码链接（1）/)
    assert.match(links.text, /扩展链接（1）：设计稿/)

    const bad = await callTool(configFile, 'add_links', { id: created.id, codeLinks: ['ftp://x'] })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /http\(s\)/)

    // 只增不删：再追加一条，原来那条与扩展链接都还在
    const more = await callTool(configFile, 'add_links', {
      id: created.id,
      feishuTaskLinks: ['https://project.feishu.cn/x7mm65/story/detail/1'],
    })
    assert.equal(more.isError, false, more.text)
    assert.match(more.text, /飞书任务（1）/)
    assert.match(more.text, /代码链接（1）/)
    assert.match(more.text, /扩展链接（1）/)

    const none = await callTool(configFile, 'update_requirement', { id: created.id })
    assert.equal(none.isError, true)
    assert.match(none.text, /至少传/)

    const db = new BoardDatabase(dataDir)
    const r = db.byId(created.id)!
    assert.equal(r.status, '执行中')
    assert.equal(r.priority, 'p1')
    assert.deepEqual(r.codeLinks, ['https://gitlab.example.com/mr/1'])
    assert.deepEqual(r.feishuTaskLinks, ['https://project.feishu.cn/x7mm65/story/detail/1'])
    assert.deepEqual(r.extLinks, [{ detail: '设计稿', url: 'https://example.com/design' }])
    db.close()
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
    const agents = readFileSync(join(legacy, 'AGENTS.md'), 'utf8')
    const id = /id: (req-\w+)/.exec(agents)![1]
    assert.equal(agents, `---\nid: ${id}\n---\n\n<!-- 指令 -->\n`)
    assert.equal(
      readFileSync(join(legacy, 'requirement.md'), 'utf8'),
      '# 老需求\n\n## 需求\n\n正文不能动。\n',
    )

    const db = new BoardDatabase(dataDir)
    db.syncProjects()
    assert.equal(db.get('legacy', 'demo')?.id, id)
    assert.equal(db.byId(id)?.slug, 'legacy')
    db.close()

    const again = await callTool(configFile, 'assign_ids')
    assert.match(again.text, /所有需求都已有 id/)
    rmSync(base, { recursive: true, force: true })
  })

  // 注册是用户级的：每个 claude / codex 会话都会拉起这个进程，
  // 所以没碰工具时不该开库、更不该凭空造出一个数据目录
  test('懒开库：只握手不调工具，不建库', async () => {
    scaffold()
    const never = join(base, 'never-used')
    writeFileSync(configFile, JSON.stringify({ dataDir: never }), 'utf8')
    await mcpSession(configFile, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    assert.equal(existsSync(never), false)
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

  test('POST /api/worktree/open 只认库里的记录，目录不在就报错', async () => {
    const unknown = await post('/api/worktree/open', { id: 'wt-nope' })
    assert.match(unknown.error, /找不到 worktree/)
    // 上一条用例登记的路径本来就不存在：不该真去 open，而是报出来
    const gone = await post('/api/worktree/open', { id: 'wt-ctx' })
    assert.match(gone.error, /目录已不存在/)
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

  // 只读地看注册计划；不测 /api/mcp/install——那会改到本机真实的 agent 配置
  test('GET /api/mcp 返回两个 agent 的注册计划', async () => {
    const r = await get('/api/mcp')
    assert.match(r.entry, /server\/mcp\.ts$/)
    assert.deepEqual(
      r.agents.map((a: { id: string }) => a.id),
      ['claude', 'codex'],
    )
    for (const a of r.agents) {
      assert.equal(typeof a.installed, 'boolean')
      assert.ok(a.configFile.startsWith('/'))
    }
  })
})

// ------------------------------------------------------------------ 收尾

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true })
  assert.ok(!existsSync(TMP))
})
