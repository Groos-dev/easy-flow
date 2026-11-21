import { agentLabel, openTargetLabel } from '../src/renderer/src/lib/labels.ts'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { createBoardApp } from '../server/index.ts'
import { BoardDatabase } from '../server/db.ts'
import { readConfig } from '../server/config.ts'
import { createTodoDoc, setTodoSummary } from '../server/convention.ts'
import { parseRequirement } from '../server/markdown.ts'
import { messages } from '../src/shared/messages.ts'
import { Language, getLanguage, setLanguage, translate, requirementStatusLabel } from '../src/shared/i18n.ts'
import { normalizeRequirementStatus, RequirementStatus } from '../src/shared/domain.ts'
import { TODO_STATUS_LABEL } from '../src/renderer/src/lib/types.ts'
import { PET_LABEL } from '../src/renderer/src/lib/pets.ts'

const previousLang = process.env.EASY_FLOW_LANG
delete process.env.EASY_FLOW_LANG
after(() => {
  if (previousLang === undefined) delete process.env.EASY_FLOW_LANG
  else process.env.EASY_FLOW_LANG = previousLang
  setLanguage(Language.English)
})

describe('complete bilingual catalog', () => {
  test('every message has both languages and the same interpolation parameters', () => {
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(value.en.trim(), key)
      assert.ok(value.zh.trim(), key)
      const parameters = (text: string) => [...new Set(text.match(/\{\d+\}/g))].sort()
      assert.deepEqual(parameters(value.en), parameters(value.zh), key)
    }
  })

  test('interpolation treats supplied content as data, including dollar signs and braces', () => {
    assert.equal(translate('Copied: {0}', ['$& {1}'], Language.English), 'Copied: $& {1}')
    assert.equal(translate('Copied: {0}', ['项目'], Language.Chinese), '已复制：项目')
  })

  test('labels follow runtime changes without persisting translated statuses', () => {
    setLanguage(Language.English)
    assert.equal(requirementStatusLabel(RequirementStatus.Completed), 'Completed')
    assert.equal(TODO_STATUS_LABEL.done, 'Completed')
    assert.equal(PET_LABEL.working, 'Working')
    assert.equal(agentLabel('chengxiaobang', 'Chengxiaobang'), 'Chengxiaobang')
    assert.equal(openTargetLabel({ id: '', label: 'Finder' }), 'Finder')
    setLanguage(Language.Chinese)
    assert.equal(requirementStatusLabel(RequirementStatus.Completed), '已完成')
    assert.equal(TODO_STATUS_LABEL.done, '已完成')
    assert.equal(PET_LABEL.working, '干活')
    assert.equal(agentLabel('chengxiaobang', 'Chengxiaobang'), '程小帮')
    assert.equal(openTargetLabel({ id: '', label: 'Finder' }), '访达')
    assert.equal(openTargetLabel({ id: 'terminal', label: 'Terminal' }), '终端')
    assert.equal(openTargetLabel({ id: 'editor', label: 'User-provided editor name' }), 'User-provided editor name')
    assert.equal(RequirementStatus.Completed, 'completed')
  })
})

test('legacy status migration is idempotent and preserves metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-i18n-migration-'))
  try {
    const board = new BoardDatabase(dir)
    board.close()
    const raw = new DatabaseSync(join(dir, 'easy-flow.db'))
    for (const [index, status] of ['澄清', '执行中', 'Review', '已完成'].entries()) {
      raw.prepare('INSERT INTO requirement (slug, project, id, title, path, status, priority, pinned, session_analysis_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`req-${index}`, 'demo', `id-${index}`, '用户标题', dir, status, 'p1', 1, 'completed')
    }
    raw.close()
    for (let pass = 0; pass < 2; pass++) {
      const migrated = new BoardDatabase(dir)
      for (const [index, expected] of Object.values(RequirementStatus).entries()) {
        const row = migrated.byId(`id-${index}`)!
        assert.equal(row.status, expected)
        assert.equal(row.title, '用户标题')
        assert.equal(row.priority, 'p1')
        assert.equal(row.pinned, true)
        assert.equal(row.sessionAnalysisStatus, 'completed')
      }
      assert.equal(migrated.setStatus('req-0', '执行中', 'demo').status, RequirementStatus.InProgress)
      migrated.setStatus('req-0', RequirementStatus.Clarification, 'demo')
      migrated.close()
    }
    assert.equal(normalizeRequirementStatus('Review'), RequirementStatus.Review)
    for (const value of ['unrecognized', '__proto__', 'constructor', 'toString']) assert.equal(normalizeRequirementStatus(value), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe('saved language and CLI precedence', () => {
  let dir: string
  let previousConfig: string | undefined
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'easy-flow-i18n-api-'))
    previousConfig = process.env.EASY_FLOW_CONFIG
    process.env.EASY_FLOW_CONFIG = join(dir, 'config.json')
    app = createBoardApp({ dataDir: join(dir, 'data') })
    server = createServer((req, res) => void app.handle(req, res))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    base = `http://127.0.0.1:${address.port}`
  })
  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    app.close()
    if (previousConfig === undefined) delete process.env.EASY_FLOW_CONFIG
    else process.env.EASY_FLOW_CONFIG = previousConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test('defaults to English, persists Chinese, and rejects invalid languages without mutation', async () => {
    const get = async () => (await fetch(`${base}/api/settings/language`)).json() as Promise<{ language: string }>
    assert.equal((await get()).language, Language.English)
    for (const language of [Language.Chinese, Language.English, Language.Chinese]) {
      const response = await fetch(`${base}/api/settings/language`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language }) })
      assert.equal(response.status, 200)
      assert.equal(readConfig().language, language)
      assert.equal((await get()).language, language)
    }
    const rejected = await fetch(`${base}/api/settings/language`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'fr' }) })
    assert.ok(rejected.status >= 400)
    assert.equal(readConfig().language, Language.Chinese)
  })

  test('a CLI-only language environment does not override a saved application preference', async () => {
    const previous = process.env.EASY_FLOW_LANG
    process.env.EASY_FLOW_LANG = 'en'
    try {
      const response = await fetch(`${base}/api/settings/language`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: Language.Chinese }) })
      assert.equal(response.status, 200)
      assert.equal(requirementStatusLabel(RequirementStatus.Completed), '已完成')
    } finally {
      if (previous === undefined) delete process.env.EASY_FLOW_LANG
      else process.env.EASY_FLOW_LANG = previous
    }
  })

  test('CLI language flag overrides environment and saved preference without changing JSON shape', () => {
    const cli = (args: string[], environmentLanguage = 'zh') => spawnSync(process.execPath, ['--import', 'tsx', 'server/cli.ts', ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, EASY_FLOW_LANG: environmentLanguage },
    })
    const english = cli(['--lang', 'en', '--help'])
    assert.equal(english.status, 0, english.stderr)
    assert.match(english.stdout, /Usage:/)
    assert.doesNotMatch(english.stdout, /[\u4e00-\u9fff]/)
    const chinese = cli(['--lang=zh', '--help'], 'en')
    assert.equal(chinese.status, 0, chinese.stderr)
    assert.match(chinese.stdout, /用法/)
    assert.equal(cli(['--lang', 'fr', '--help']).status, 2)
    const invalidJson = cli(['--lang', 'fr', '--json'])
    assert.equal(invalidJson.status, 2)
    assert.equal(typeof (JSON.parse(invalidJson.stdout) as { error: unknown }).error, 'string')
    const savedPreference = cli(['--help'], '')
    assert.match(savedPreference.stdout, /用法/)
    assert.equal(cli(['--lang', 'en', '--lang', 'zh', '--help']).status, 2)
    const enJson = JSON.parse(cli(['dir', '--lang', 'en', '--json']).stdout) as unknown
    const zhJson = JSON.parse(cli(['dir', '--lang', 'zh', '--json']).stdout) as unknown
    assert.deepEqual(enJson, zhJson)
    assert.equal(readConfig().language, Language.Chinese)
  })

  test('new English and Chinese documents remain readable and editable without changing content ownership', () => {
    for (const language of [Language.English, Language.Chinese]) {
      setLanguage(language)
      const id = `T-20261121-${language}`
      const { file } = createTodoDoc(join(dir, language), id, 'User-owned title', 'First summary')
      const original = readFileSync(file, 'utf8')
      const updated = setTodoSummary(original, 'Updated summary')
      assert.ok(updated.includes('Updated summary'))
      assert.ok(!updated.includes('First summary'))
      assert.equal((updated.match(/## (Summary|摘要)/g) ?? []).length, 1)
      assert.ok(updated.includes('User-owned title'))
      const root = join(dir, language, 'requirement')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'requirement.md'), '# User requirement\n\n## Summary\n\nUser text\n\n## Repos\n\n| Short name | Repository |\n| --- | --- |\n| app | example/app |\n')
      const parsed = parseRequirement(root, 'requirement')
      assert.equal(parsed.summary, 'User text')
      assert.equal(parsed.repos[0]?.short, 'app')
    }
  })
})


test('persisted generated session messages switch language after restart; opaque legacy text is preserved', async () => {
  const { normalizeHookEvent, hookActionOf } = await import('../server/hook.ts')
  const { formatActionText } = await import('../src/shared/session-text.ts')
  const { planPetRow } = await import('../src/renderer/src/lib/pets.ts')
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-message-state-'))
  const previous = getLanguage()
  let db = new BoardDatabase(dir)
  try {
    setLanguage(Language.Chinese)
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/user.txt' } }
    const status = normalizeHookEvent(payload, 10)!
    status.needsAction = 'User-authored 用户原文'
    db.putSessionObservation('codex', 'localized', { status, action: hookActionOf(payload, 10) })
    db.putSessionObservation('codex', 'legacy', {
      status: { state: 'working', needsAction: '用户原文', observedAt: 10, detail: 'Opaque external detail 原文' },
      action: { text: 'Opaque legacy action 原文', calledAt: 10 },
    })
    db.close()
    setLanguage(Language.English)
    db = new BoardDatabase(dir)
    const english = db.getSessionObservation('codex', 'localized')!
    assert.equal(english.action?.text, 'Read user.txt')
    assert.equal(english.status.detail, 'Hook event: PreToolUse')
    assert.equal(english.status.needsAction, 'User-authored 用户原文')
    assert.equal(english.action?.message?.key, 'Read {0}')
    setLanguage(Language.Chinese)
    // This is the same already-fetched object, as used by a memoized renderer.
    assert.equal(formatActionText(english.action!), '读 user.txt')
    const plan = planPetRow([{ requirementId: 'req-test', agent: 'codex', session: 'localized', title: 'User title', cwd: '', link: '', created: '', updated: '', status: english.status, action: english.action }])
    assert.equal(plan.items[0]?.bubble, '读 user.txt')
    const chinese = db.getSessionObservation('codex', 'localized')!
    assert.equal(chinese.status.detail, 'hook 事件：PreToolUse')
    assert.equal(chinese.action?.text, '读 user.txt')
    const legacy = db.getSessionObservation('codex', 'legacy')!
    assert.equal(legacy.status.detail, 'Opaque external detail 原文')
    assert.equal(legacy.action?.text, 'Opaque legacy action 原文')
    assert.equal(legacy.status.needsAction, '用户原文')
  } finally { db.close(); setLanguage(previous); rmSync(dir, { recursive: true, force: true }) }
})

test('background sync captures each request language when creating templates in new directories', async () => {
  const { createFileSync } = await import('../server/file-sync.ts')
  const root = mkdtempSync(join(tmpdir(), 'easy-flow-worker-languages-'))
  const previous = getLanguage()
  const sync = createFileSync(join(process.cwd(), 'server/sync-worker.ts'))
  try {
    setLanguage(Language.Chinese)
    const chinese = sync.scan(join(root, 'zh'))
    setLanguage(Language.English)
    const english = sync.scan(join(root, 'en'))
    await Promise.all([chinese, english])
    for (const [language, heading] of [['zh', '# 项目规范'], ['en', '# Project conventions']]) {
      const template = join(root, language, '_templates/project/AGENTS.md')
      assert.ok(readFileSync(template, 'utf8').includes(heading))
    }
    const custom = join(root, 'en', '_templates/project/AGENTS.md')
    writeFileSync(custom, '# User-owned custom template')
    setLanguage(Language.Chinese)
    await sync.scan(join(root, 'en'))
    assert.equal(readFileSync(custom, 'utf8'), '# User-owned custom template')
  } finally { await sync.close(); setLanguage(previous); rmSync(root, { recursive: true, force: true }) }
})

test('representative CLI validation errors are fully localized in both languages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-cli-errors-'))
  const config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ dataDir: join(dir, 'data') }))
  const run = (args: string[], language: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, EASY_FLOW_CONFIG: config }
    delete env.CODEX_THREAD_ID
    return spawnSync(process.execPath, ['server/cli.ts', ...args, '--lang', language, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' })
  }
  try {
    const missingEn = JSON.parse(run(['req', 'session', 'add', 'req-missing', '--agent', 'codex'], 'en').stdout) as { error: string }
    const missingZh = JSON.parse(run(['req', 'session', 'add', 'req-missing', '--agent', 'codex'], 'zh').stdout) as { error: string }
    assert.match(missingEn.error, /Missing --id.*CODEX_THREAD_ID/)
    assert.doesNotMatch(missingEn.error, /[\u4e00-\u9fff]/)
    assert.match(missingZh.error, /缺少 --id/)
    assert.match(missingZh.error, /CODEX_THREAD_ID/)
    assert.doesNotMatch(missingZh.error, /Missing|Run this in|is set in this shell/)
    for (const language of ['en', 'zh']) {
      const error = (JSON.parse(run(['req', 'new', 'Check project ownership', '--project', 'missing-project', '--slug', 'missing'], language).stdout) as { error: string }).error
      assert.match(error, language === 'en' ? /no projects under the data dir yet/ : /数据目录下还没有项目/)
      if (language === 'en') assert.doesNotMatch(error, /[\u4e00-\u9fff]/)
      else assert.doesNotMatch(error, /no projects|Known projects/)
    }
    assert.equal(run(['project', 'new', 'demo'], 'en').status, 0)
    for (const language of ['en', 'zh']) {
      const error = (JSON.parse(run(['req', 'new', 'Check project ownership', '--project', 'missing-project', '--slug', 'missing'], language).stdout) as { error: string }).error
      assert.match(error, language === 'en' ? /Known projects: demo/ : /现有项目：demo/)
      if (language === 'en') assert.doesNotMatch(error, /[\u4e00-\u9fff]/)
      else assert.doesNotMatch(error, /Known projects/)
    }
    const req = JSON.parse(run(['req', 'new', 'Validate links', '--project', 'demo', '--slug', 'links'], 'en').stdout) as { id: string }
    for (const language of ['en', 'zh']) {
      const missing = JSON.parse(run(['req', 'link', req.id], language).stdout) as { error: string }
      const invalid = JSON.parse(run(['req', 'link', req.id, 'invalid-link'], language).stdout) as { error: string }
      assert.match(missing.error, language === 'en' ? /Pass at least one link/ : /请至少指定一条链接/)
      assert.match(invalid.error, language === 'en' ? /Link expects/ : /链接格式应为/)
    }
    const todoArgs = ['todo', 'new', 'repeat', '--source', 'manual', '--ref', 'duplicate-case', '--summary', 'Verify both languages; finish when all validation cases are localized.']
    const todo = JSON.parse(run(todoArgs, 'en').stdout) as { id: string }
    for (const language of ['en', 'zh']) {
      const cases: Array<{ args: string[]; en: RegExp; zh: RegExp }> = [
        { args: todoArgs, en: /Ref already used/, zh: /去重键已被/ },
        { args: ['todo', 'promote', todo.id, '--project', 'demo', '--slug', 'repeat'], en: /title repeats/i, zh: /标题与目录名重复/ },
        { args: ['todo', 'set', 'T-20990101-999', '--title', 'Unused title'], en: /Todo not found/, zh: /找不到待办/ },
        { args: ['todo', 'new', 'Check owner', '--source', 'manual', '--req', 'req-missing'], en: /Requirement not found/, zh: /找不到需求/ },
      ]
      for (const item of cases) {
        const error = (JSON.parse(run(item.args, language).stdout) as { error: string }).error
        assert.match(error, language === 'en' ? item.en : item.zh)
        if (language === 'en') assert.doesNotMatch(error, /[\u4e00-\u9fff]/)
        else assert.doesNotMatch(error, /Ref already used|Todo not found|Requirement not found|title repeats/i)
      }
    }
    assert.equal(run(['todo', 'set', todo.id, '--req', req.id], 'en').status, 0)
    for (const language of ['en', 'zh']) {
      const error = (JSON.parse(run(['todo', 'promote', todo.id, '--project', 'demo'], language).stdout) as { error: string }).error
      assert.match(error, language === 'en' ? /already belongs to/ : /已归属需求/)
    }

  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bilingual Chengxiaobang prompts retain context and registration within the documented text budget', async () => {
  const { launchPrompt } = await import('../server/launch.ts')
  const previous = getLanguage()
  try {
    for (const language of [Language.English, Language.Chinese]) {
      setLanguage(language)
      const prompt = launchPrompt({
        agent: 'chengxiaobang', requirementId: 'req-27f266a1f8', worktreeId: 'wt-b6411615a6',
        worktreePath: process.cwd(), requirementWorktreePaths: [process.cwd()],
      })
      assert.ok(prompt.length <= 500, `${language}: ${prompt.length} characters`)
      assert.ok(prompt.includes(`cd ${process.cwd()}`))
      assert.ok(prompt.includes('easy-flow context wt-b6411615a6'))
      assert.ok(prompt.includes('easy-flow req session add req-27f266a1f8 --agent chengxiaobang'))
    }
  } finally { setLanguage(previous) }
})
