import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardDatabase, TAG_MAX_LENGTH, normalizeTags } from '../server/db.ts'
import Card from '../src/renderer/src/components/Card.tsx'
import type { Requirement } from '../src/renderer/src/lib/types.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'easy-flow-tags-'))
}

function makeReq(dir: string, project: string, slug: string, id: string): void {
  const reqDir = join(dir, project, slug)
  mkdirSync(reqDir, { recursive: true })
  writeFileSync(
    join(reqDir, 'requirement.md'),
    `---\nid: ${id}\n---\n\n# ${slug}\n\n## 需求\n\nx\n`,
    'utf8',
  )
}

describe('标签字段', () => {
  test('normalizeTags 去空白、忽略大小写去重，拒绝空串与超长', () => {
    assert.deepEqual(normalizeTags([' 看板 ', '看板', 'Kanban', 'kanban']), ['看板', 'Kanban'])
    assert.deepEqual(normalizeTags([]), [])
    assert.throws(() => normalizeTags(['   ']), /empty/)
    assert.throws(() => normalizeTags(['x'.repeat(TAG_MAX_LENGTH + 1)]), /longer/)
    assert.throws(() => normalizeTags(['Full GC']), /whitespace/)
    assert.throws(() => normalizeTags(['#选座']), /start with #/)
    assert.throws(() => normalizeTags([1]), /string/)
    assert.throws(() => normalizeTags('看板' as never), /array/)
  })

  test('setTags 落库，重新同步不清标签；tagCounts 跨项目统计并按次数排序', () => {
    const dir = tempDir()
    makeReq(dir, 'onex', 'alpha', 'req-a')
    makeReq(dir, 'onex', 'beta', 'req-b')
    makeReq(dir, 'personal', 'gamma', 'req-c')
    const db = new BoardDatabase(dir)
    db.syncProjects()

    db.setTags('alpha', ['看板', '卡片'], 'onex')
    db.setTags('beta', ['看板', '排障'], 'onex')
    db.setTags('gamma', ['看板'], 'personal')
    db.syncProjects()

    assert.deepEqual(db.get('alpha', 'onex')?.tags, ['看板', '卡片'])
    assert.throws(() => db.setTags('alpha', ['看板', '卡片', '样式', '发布'], 'onex'), /At most 3/)
    assert.deepEqual(db.get('alpha', 'onex')?.tags, ['看板', '卡片'])
    assert.deepEqual(db.tagCounts(), [
      { tag: '看板', count: 3 },
      { tag: '卡片', count: 1 },
      { tag: '排障', count: 1 },
    ])
    assert.deepEqual(db.tagCounts('onex'), [
      { tag: '看板', count: 2 },
      { tag: '卡片', count: 1 },
      { tag: '排障', count: 1 },
    ])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('同名忽略大小写复用词表里的标签，写法以首次写入为准', () => {
    const dir = tempDir()
    makeReq(dir, 'p', 'a', 'req-a')
    makeReq(dir, 'p', 'b', 'req-b')
    const db = new BoardDatabase(dir, 'p')
    db.syncProjects()

    db.setTags('b', ['Kanban'], 'p')
    db.setTags('a', ['kanban'], 'p')
    assert.deepEqual(db.get('a', 'p')?.tags, ['Kanban'])
    assert.deepEqual(db.tagCounts(), [{ tag: 'Kanban', count: 2 }])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('摘掉最后一处引用的标签退出词表；失联需求不计数', () => {
    const dir = tempDir()
    makeReq(dir, 'p', 'a', 'req-a')
    makeReq(dir, 'p', 'b', 'req-b')
    const db = new BoardDatabase(dir, 'p')
    db.syncProjects()

    db.setTags('a', ['错字', '看板'], 'p')
    db.setTags('b', ['看板'], 'p')
    db.setTags('a', ['看板'], 'p')
    assert.deepEqual(db.tagCounts(), [{ tag: '看板', count: 2 }])

    rmSync(join(dir, 'p', 'b'), { recursive: true, force: true })
    db.syncProjects()
    assert.deepEqual(db.tagCounts(), [{ tag: '看板', count: 1 }])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('search：#标签 精确筛、关键词也命中标签名，多个词取交集', () => {
    const dir = tempDir()
    makeReq(dir, 'p', 'a', 'req-a')
    makeReq(dir, 'p', 'b', 'req-b')
    makeReq(dir, 'p', 'c', 'req-c')
    const db = new BoardDatabase(dir, 'p')
    db.syncProjects()
    db.setTags('a', ['选座', 'NDC'], 'p')
    db.setTags('b', ['选座价格'], 'p')
    db.setTags('c', ['行李'], 'p')

    const hits = (q: string) => [...db.search(q)].sort()
    assert.deepEqual(hits('#选座'), ['a'])
    assert.deepEqual(hits('#ndc'), ['a'])
    assert.deepEqual(hits('选座'), ['a', 'b'])
    assert.deepEqual(hits('#选座 #行李'), [])
    assert.deepEqual(hits('#行李 c'), ['c'])
    assert.deepEqual(hits('#'), ['a', 'b', 'c'])

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('卡片左下角按写入顺序摆出全部标签；没有标签不留空位', () => {
    const req: Requirement = {
      slug: 'a',
      project: 'p',
      id: 'req-1',
      parentId: '',
      title: '标题',
      status: '执行中',
      priority: '',
      summary: '',
      repos: [],
      links: '',
      linkItems: [],
      tags: ['选座', '价格', '契约'],
      docs: [],
      path: '',
      mtime: 0,
      updated: '',
    }

    const html = renderToStaticMarkup(createElement(Card, { req }))
    const tags = [...html.matchAll(/class="card-tag"[^>]*>([^<]+)</g)].map((m) => m[1])
    assert.deepEqual(tags, ['选座', '价格', '契约'])
    assert.match(html, /title="按 #选座 筛选"/)

    const plain = renderToStaticMarkup(createElement(Card, { req: { ...req, tags: [] } }))
    assert.doesNotMatch(plain, /card-tags/)
  })

  test('命令行：add / rm / set 与 3 个上限，taglist 汇总词表', () => {
    const dir = tempDir()
    makeReq(dir, 'onex', 'alpha', 'req-cli')
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ dataDir: dir, activeProject: 'onex' }), 'utf8')

    const raw = (...args: string[]) =>
      spawnSync(process.execPath, [join(REPO, 'server/cli.ts'), ...args, '--json'], {
        cwd: REPO,
        env: { ...process.env, EASY_FLOW_CONFIG: configFile },
        encoding: 'utf8',
      })
    const run = (...args: string[]) => {
      const result = raw(...args)
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }

    assert.deepEqual(run('req', 'tag', 'add', 'req-cli', '看板', '卡片').tags, ['看板', '卡片'])
    assert.deepEqual(run('req', 'tag', 'rm', 'req-cli', '卡片').tags, ['看板'])
    assert.deepEqual(run('req', 'tag', 'ls', 'req-cli').tags, ['看板'])
    assert.deepEqual(run('taglist').tags, [{ tag: '看板', count: 1 }])

    assert.deepEqual(run('req', 'tag', 'add', 'req-cli', '卡片', '样式').tags, ['看板', '卡片', '样式'])
    const full = raw('req', 'tag', 'add', 'req-cli', '发布')
    assert.equal(full.status, 2)
    assert.match(full.stdout, /最多 3 个标签/)
    assert.match(full.stdout, /req tag rm/)
    assert.match(full.stdout, /req tag set/)

    const tooMany = raw('req', 'tag', 'set', 'req-cli', 'a', 'b', 'c', 'd')
    assert.equal(tooMany.status, 2)
    assert.match(tooMany.stdout, /req tag rm/)

    assert.deepEqual(run('req', 'tag', 'set', 'req-cli', '价格', '契约').tags, ['价格', '契约'])

    rmSync(dir, { recursive: true, force: true })
  })
})
