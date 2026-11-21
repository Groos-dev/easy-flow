import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { BoardDatabase } from '../server/db.ts'
import { createBoardApp } from '../server/index.ts'
import { RolloutStore, sessionDirFor } from '../server/rollout.ts'
import type { SourceRow } from '../server/source-file.ts'
import { focusEffect, livePreview } from '../src/renderer/src/lib/markdown-live.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-perf-'))
  const req = join(dir, 'p', 'r')
  mkdirSync(join(req, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'p', 'AGENTS.md'), '---\nname: 项目\n---\n')
  writeFileSync(join(req, 'requirement.md'), '---\nid: req-perf\n---\n# 性能优化\n\n## 需求\n\n交互流畅\n')
  writeFileSync(join(req, 'docs', 'a.md'), '文档正文')
  return { dir, req }
}

test('rollout 追加后持久化推进位置，重建读取器仍从新位置继续', () => {
  const home = mkdtempSync(join(tmpdir(), 'easy-flow-rollout-'))
  const dir = sessionDirFor(home, new Date())
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'rollout-2026-11-18T00-00-00-perf.jsonl')
  const line = (type: string) => JSON.stringify({ timestamp: '2026-11-18T00:00:00Z', type: 'event_msg', payload: { type } }) + '\n'
  const rows = new Map<string, SourceRow>()
  let writes = 0
  const sources = {
    source: (p: string) => rows.get(p),
    listSources: () => [...rows].map(([path, value]) => ({ path, ...value })),
    touchSource: (p: string, patch: Partial<SourceRow>) => {
      rows.set(p, { mtimeMs: 0, offset: 0, state: null, ...rows.get(p), ...patch })
      writes++
    },
  }
  try {
    writeFileSync(path, line('task_started'))
    new RolloutStore(home, sources).refresh(['perf'])
    appendFileSync(path, line('task_complete'))
    assert.equal(new RolloutStore(home, sources).refresh(['perf']).get('perf')?.status.state, 'done')
    assert.equal(rows.get(path)?.offset, statSync(path).size)
    const count = writes
    new RolloutStore(home, sources).refresh(['perf'])
    assert.equal(writes, count)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('无内容变化的同步不产生写事务，项目版本保持稳定', () => {
  const { dir } = fixture()
  const db = new BoardDatabase(dir)
  const observer = new DatabaseSync(db.file, { readOnly: true })
  try {
    db.syncProjects()
    const projects = db.listProjects()
    const version = observer.prepare('PRAGMA data_version').get()?.data_version
    const sync = db.syncProjects()
    assert.deepEqual(sync.updated, [])
    assert.deepEqual(db.listProjects(), projects)
    assert.equal(observer.prepare('PRAGMA data_version').get()?.data_version, version)
  } finally {
    observer.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('增量同步跟随正文编辑、同目录增删文档和需求恢复，保留状态', () => {
  const { dir, req } = fixture()
  const db = new BoardDatabase(dir)
  try {
    db.syncProjects()
    db.pickProject()
    db.setStatus('r', 'review')
    writeFileSync(join(req, 'docs', 'a.md'), '修改后的长正文')
    writeFileSync(join(req, 'docs', 'b.md'), '新增正文')
    db.syncProjects()
    assert.equal(db.context('r')?.docs.find(d => d.name === 'docs/a.md')?.content, '修改后的长正文')
    rmSync(join(req, 'docs', 'b.md'))
    db.syncProjects()
    assert.ok(!db.get('r')?.docs.some(d => d.name === 'docs/b.md'))
    assert.equal(db.get('r')?.status, 'review')
    assert.ok(db.search('修改后的长正文').has('r'))
    assert.equal(db.syncProjects().updated.length, 0)
    const hidden = join(dir, 'p', '.r-hidden')
    renameSync(req, hidden)
    assert.deepEqual(db.syncProjects().missing, ['p/r'])
    renameSync(hidden, req)
    assert.deepEqual(db.syncProjects().restored, ['p/r'])
    assert.equal(db.get('r')?.status, 'review')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('详情轻量响应只提供目录与信息，原文接口仍返回完整正文', async () => {
  const { dir, req } = fixture()
  const text = '很长的文档正文\n'.repeat(12000)
  writeFileSync(join(req, 'docs', 'large.md'), text)
  const app = createBoardApp({ dataDir: dir })
  const server = createServer((req, res) => void app.handle(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${address.port}${path}`)).json()
  try {
    const detail = await get('/api/detail?slug=r&project=p')
    assert.equal(detail.requirement.id, 'req-perf')
    assert.ok(detail.requirement.docs.some((d: { name: string }) => d.name === 'docs/large.md'))
    assert.ok(!('docs' in detail))
    assert.ok(!('requirementMd' in detail))
    const doc = await get('/api/doc?slug=r&project=p&name=docs%2Flarge.md')
    assert.equal(doc.content, text)
    const context = await get('/api/context?slug=r&project=p')
    assert.ok(context.docs.length > 0)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('看板快照版本一致，详情模式省去会话与下一步排名', async () => {
  const { dir } = fixture()
  const app = createBoardApp({ dataDir: dir })
  const server = createServer((req, res) => void app.handle(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${address.port}${path}`)).json()
  try {
    const snapshot = await get('/api/snapshot')
    assert.equal(snapshot.board.requirements[0].id, 'req-perf')
    assert.deepEqual(snapshot.todos.sync, { added: [], updated: [], missing: [], restored: [] })
    assert.equal(snapshot.board.rev, (await get('/api/requirements')).rev)
    assert.equal(snapshot.sessions.rev, (await get('/api/sessions')).rev)
    assert.equal(snapshot.nextUp.rev, (await get('/api/next-up')).rev)
    const detail = await get('/api/snapshot?view=detail')
    assert.equal(detail.board.rev, snapshot.board.rev)
    assert.ok(!('sessions' in detail))
    assert.ok(!('nextUp' in detail))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('编辑器同一行移动复用装饰，跨行后切换原文记号', () => {
  let state = EditorState.create({
    doc: '# 标题\n\n正文 **加粗**\n',
    selection: { anchor: 2 },
    extensions: [markdown({ base: markdownLanguage }), livePreview],
  })
  state = state.update({ effects: focusEffect.of(true) }).state
  const before = state.facet(EditorView.decorations)[0]
  state = state.update({ selection: { anchor: 3 } }).state
  assert.equal(state.facet(EditorView.decorations)[0], before)
  state = state.update({ selection: { anchor: 11 } }).state
  const current = state.facet(EditorView.decorations)[0]
  assert.notEqual(current, before)
  assert.equal(state.doc.toString(), '# 标题\n\n正文 **加粗**\n')
})

test('跨行和多选区增量装饰与完整计算一致', async () => {
  const { liveDecorations } = await import('../src/renderer/src/lib/markdown-live.ts')
  const { EditorSelection } = await import('@codemirror/state')
  const doc = '# 标题\n\n- [ ] 第一项 **加粗**\n- 第二项\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n> 引用\n\n---\n\n结尾\n'
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), livePreview, EditorState.allowMultipleSelections.of(true)] })
  state = state.update({ effects: focusEffect.of(true) }).state
  const values = (set: ReturnType<typeof liveDecorations>) => {
    const out: unknown[] = []
    set.between(0, doc.length, (from, to, value) => { out.push([from, to, value.spec.class, value.spec.widget?.constructor.name]) })
    return out
  }
  for (let line = 1; line <= state.doc.lines; line++) {
    state = state.update({ selection: { anchor: state.doc.line(line).from } }).state
    const actual = state.facet(EditorView.decorations)[0] as ReturnType<typeof liveDecorations>
    assert.deepEqual(values(actual), values(liveDecorations(state)), `line ${line}`)
  }
  state = state.update({ selection: EditorSelection.create([
    EditorSelection.range(0, 3), EditorSelection.cursor(state.doc.line(7).from),
  ]) }).state
  assert.deepEqual(values(state.facet(EditorView.decorations)[0] as ReturnType<typeof liveDecorations>), values(liveDecorations(state)))
})

test('所有图片姿势都有可读取的离屏静态素材', async () => {
  const { petArt } = await import('../src/renderer/src/lib/pet-art.ts')
  const { existsSync } = await import('node:fs')
  for (const agent of ['claude', 'codex', 'chengxiaobang', 'cursor']) {
    for (const state of ['idle', 'thinking', 'working', 'sweeping', 'blocked', 'done', 'failed'] as const) {
      for (const mood of ['awake', 'yawning', 'dozing', 'collapsing', 'sleeping'] as const) {
        for (const compact of [true, false]) {
          const art = petArt(agent, state, { compact, mood })
          if (art.channel !== 'img') continue
          const still = art.src.replace('pets/', 'pets/still/').replace('.webp', '.png')
          assert.ok(existsSync(join(process.cwd(), 'src/renderer/public', still)), still)
        }
      }
    }
  }
})

test('后台扫描同步新增与编辑，连续无变化扫描保持稳定', async () => {
  const { createFileSync } = await import('../server/file-sync.ts')
  const { dir, req } = fixture()
  const sync = createFileSync(join(process.cwd(), 'server/sync-worker.ts'))
  try {
    assert.equal((await sync.scan(dir)).added.length, 1)
    assert.equal((await sync.scan(dir)).updated.length, 0)
    writeFileSync(join(req, 'docs/a.md'), '后台扫描的新正文')
    assert.equal((await sync.scan(dir)).updated.length, 1)
    const db = new BoardDatabase(dir, 'p')
    db.pickProject()
    assert.equal(db.context('r')?.docs.find(d => d.name === 'docs/a.md')?.content, '后台扫描的新正文')
    db.close()
  } finally {
    await sync.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('独立解析缓存跟随另一连接的索引增删与项目重建', () => {
  const { dir, req } = fixture()
  const background = new BoardDatabase(dir, 'p')
  const detail = new BoardDatabase(dir, 'p')
  try {
    background.syncProjects()
    detail.syncProjects()
    writeFileSync(join(req, 'docs/b.md'), '临时文档')
    detail.syncRequirement('r', 'p')
    rmSync(join(req, 'docs/b.md'))
    background.syncProjects()
    assert.ok(!background.context('r', 'p')?.docs.some(d => d.name === 'docs/b.md'))
    detail.deleteProject('p')
    background.syncProjects()
    assert.ok(background.get('r', 'p')?.docs.some(d => d.name === 'docs/a.md'))
  } finally {
    background.close()
    detail.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('后台同步新增首个项目后，主服务自动选中它', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-first-project-'))
  const background = new BoardDatabase(dir)
  const app = createBoardApp({ dataDir: dir, syncFiles: async () => background.syncProjects() })
  const server = createServer((req, res) => void app.handle(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    assert.equal(app.db.project, '')
    mkdirSync(join(dir, 'p/r'), { recursive: true })
    writeFileSync(join(dir, 'p/AGENTS.md'), '# 项目')
    writeFileSync(join(dir, 'p/r/requirement.md'), '# 首个需求')
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/resync`, { method: 'POST' })
    assert.equal(response.status, 200)
    assert.equal(app.db.project, 'p')
    assert.equal(app.db.list().length, 1)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    app.close()
    background.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目名称变化会进入同步结果，mini 可以补拉新名称', () => {
  const { dir } = fixture()
  const db = new BoardDatabase(dir)
  try {
    db.syncProjects()
    writeFileSync(join(dir, 'p/AGENTS.md'), '---\nname: 新项目名称\n---\n')
    const sync = db.syncProjects()
    assert.deepEqual(sync.updated, [])
    assert.deepEqual((sync as { projects?: string[] }).projects, ['p'])
    assert.equal(db.listProjects()[0].name, '新项目名称')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
