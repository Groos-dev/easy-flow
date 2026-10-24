/**
 * 设置页「一键配置 hook」的回归：最要紧的一条是**只增不改**——
 * 装的时候只往事件数组里追加自己那条，卸的时候只摘自己那条，
 * 别人的 hook（本机真有的 cmux / orca / git-ai / 用户自配）必须逐字不变。
 *
 * 所以这里构造一份含他人 hook 的配置，断言「装完再卸完」与原文件**逐字相等**，
 * 并且全程只在临时目录里的假配置上跑，绝不碰用户的 ~/.claude/settings.json 或 ~/.codex/hooks.json。
 *
 * 运行：pnpm test
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

import { hookPlan, installHooks, uninstallHooks } from '../server/hook-install.ts'
import { createBoardApp } from '../server/index.ts'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'

const TMP = join(tmpdir(), `easy-flow-hooks-${basename(process.cwd())}`)

// 一份含他人 Codex hook 的配置（cmux 设了 120s、orca 走 .orca 脚本、git-ai 走 checkpoint）
function codexOthers() {
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [{ command: 'cmux hooks feed --event PreToolUse', timeout: 120000, type: 'command' }],
        },
        {
          hooks: [
            {
              type: 'command',
              command:
                "if [ -f '/Users/x/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/Users/x/.orca/agent-hooks/codex-hook.sh'; fi",
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        { hooks: [{ command: 'bun ~/.agents/hooks/runtime.ts', timeout: 30, type: 'command' }] },
        { hooks: [{ command: '/Users/x/.git-ai/bin/git-ai checkpoint codex --hook-input stdin', type: 'command' }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ command: 'cmux hooks feed --event UserPromptSubmit', timeout: 5000, type: 'command' }] },
      ],
    },
  }
}

// 一份含用户自配 Claude hook 的配置
function claudeOthers() {
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    env: { ANTHROPIC_BASE_URL: 'http://example.test' },
    hooks: {
      Notification: [
        {
          hooks: [
            { command: '~/.cc-switch/data/hooks/claude/play-notification-sound.sh', type: 'command' },
            { command: 'bun ~/.agents/hooks/runtime.ts', type: 'command' },
          ],
          matcher: '',
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            { command: 'bun ~/.agents/hooks/runtime.ts', type: 'command' },
            { command: '/Users/x/.git-ai/bin/git-ai checkpoint claude --hook-input stdin', type: 'command' },
          ],
        },
      ],
    },
  }
}

// 程小帮的 hook 是扁平数组，保留一条用户自己的 hook 验证只增不改
function cxbOthers() {
  return {
    enabled: true,
    hooks: [
      {
        id: 'someone-else',
        event: 'PreToolUse',
        matcher: 'Write|Edit|Shell',
        command: 'echo other',
        timeoutSeconds: 30,
        enabled: true,
      },
    ],
  }
}

// Cursor 的 hook 也是扁平 command；保留 git-ai / 用户自己的脚本
function cursorOthers() {
  return {
    version: 1,
    hooks: {
      preToolUse: [
        { command: '/Users/x/.git-ai/bin/git-ai checkpoint cursor --hook-input stdin', timeout: 10 },
        { command: 'echo other', timeout: 10 },
      ],
      stop: [{ command: '/Users/x/.cursor/hooks/skill-distill-queue.sh' }],
    },
  }
}

// JSON.stringify 的缩进要跟真实文件一致，否则「逐字相等」的基线不是真基线
function writeJson(file: string, obj: unknown, trailingNewline = true): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(obj, null, 2) + (trailingNewline ? '\n' : ''), 'utf8')
}

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

describe('hook 一键配置：只增不改', () => {
  let home: string
  let claudeFile: string
  let codexFile: string
  let cxbFile: string
  let cursorFile: string

  beforeEach(() => {
    home = join(TMP, `home-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    claudeFile = join(home, '.claude', 'settings.json')
    codexFile = join(home, '.codex', 'hooks.json')
    cxbFile = join(home, '.chengxiaobang', 'hooks.json')
    cursorFile = join(home, '.cursor', 'hooks.json')
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test('未配置时四个 agent 都报未安装，地址带端口', () => {
    const plan = hookPlan({ port: 3210, home })
    assert.equal(plan.port, 3210)
    assert.equal(plan.agents.length, 4)
    for (const a of plan.agents) {
      assert.equal(a.installed, false)
      assert.equal(a.events, 0)
      assert.match(a.url, /^http:\/\/127\.0\.0\.1:3210\/api\/hook/)
    }
    assert.equal(plan.agents.find((a) => a.id === 'codex')!.url, 'http://127.0.0.1:3210/api/hook?agent=codex')
    assert.equal(plan.agents.find((a) => a.id === 'cursor')!.url, 'http://127.0.0.1:3210/api/hook?agent=cursor')
    assert.equal(plan.agents.find((a) => a.id === 'chengxiaobang')!.url, 'http://127.0.0.1:3210/api/hook?agent=chengxiaobang')
  })

  test('Cursor 原来没有配置文件时，装出来带 version: 1', () => {
    installHooks({ port: 3210, home })
    const cursor = JSON.parse(read(cursorFile))
    assert.equal(cursor.version, 1)
    assert.equal(cursor.hooks.preToolUse.length, 1)
    assert.match(cursor.hooks.preToolUse[0].command, /\/api\/hook\?agent=cursor/)
  })

  test('装完能读到：各装了自己那批事件，别人的 hook 深度不变', () => {
    writeJson(codexFile, codexOthers())
    writeJson(claudeFile, claudeOthers())
    writeJson(cxbFile, cxbOthers())
    writeJson(cursorFile, cursorOthers())

    installHooks({ port: 3210, home })

    const codex = JSON.parse(read(codexFile))
    const claude = JSON.parse(read(claudeFile))
    const cxb = JSON.parse(read(cxbFile))
    const cOthers = codexOthers()
    const jOthers = claudeOthers()

    // 自己的条目追加在事件数组末尾：别人的条目在前、逐字不变，我们那条在最后
    assert.deepEqual(codex.hooks.PreToolUse.slice(0, 2), cOthers.hooks.PreToolUse)
    assert.equal(codex.hooks.PreToolUse.length, 3)
    assert.match(codex.hooks.PreToolUse[2].hooks[0].command, /\/api\/hook\?agent=codex/)
    assert.deepEqual(codex.hooks.Stop.slice(0, 2), cOthers.hooks.Stop)
    assert.match(codex.hooks.Stop[2].hooks[0].command, /\/api\/hook\?agent=codex/)
    assert.deepEqual(codex.hooks.UserPromptSubmit.slice(0, 1), cOthers.hooks.UserPromptSubmit)
    assert.match(codex.hooks.UserPromptSubmit[1].hooks[0].command, /\/api\/hook\?agent=codex/)

    // Claude：没装到的事件（Notification）整段不动；装到的事件别人在前、我们追加
    assert.deepEqual(claude.env, jOthers.env)
    assert.deepEqual(claude.hooks.Notification, jOthers.hooks.Notification)
    assert.deepEqual(claude.hooks.PostToolUse.slice(0, 1), jOthers.hooks.PostToolUse)
    const ours = claude.hooks.PostToolUse[1].hooks[0]
    assert.equal(ours.type, 'command')
    assert.match(ours.command, /'http:\/\/127\.0\.0\.1:3210\/api\/hook'/)
    assert.match(ours.command, /\|\| true$/)

    // Cursor：扁平 command；别人的条目在前，我们追加；beforeSubmitPrompt 要显式 continue
    const cursor = JSON.parse(read(cursorFile))
    assert.deepEqual(cursor.hooks.preToolUse.slice(0, 2), cursorOthers().hooks.preToolUse)
    assert.equal(cursor.hooks.preToolUse.length, 3)
    assert.match(cursor.hooks.preToolUse[2].command, /\/api\/hook\?agent=cursor/)
    assert.match(cursor.hooks.beforeSubmitPrompt[0].command, /\{"continue":true\}/)
    assert.match(cursor.hooks.stop[0].command, /skill-distill-queue/)
    assert.equal(cursor.version, 1)

    const plan = hookPlan({ port: 3210, home })
    assert.equal(plan.agents.find((a) => a.id === 'codex')!.installed, true)
    assert.equal(plan.agents.find((a) => a.id === 'codex')!.events, 9)
    assert.equal(plan.agents.find((a) => a.id === 'claude')!.installed, true)
    assert.equal(plan.agents.find((a) => a.id === 'claude')!.events, 9)
    assert.equal(plan.agents.find((a) => a.id === 'cursor')!.installed, true)
    assert.equal(plan.agents.find((a) => a.id === 'cursor')!.events, 8)
    assert.equal(plan.agents.find((a) => a.id === 'chengxiaobang')!.installed, true)
    assert.equal(plan.agents.find((a) => a.id === 'chengxiaobang')!.events, 6)
    assert.equal(cxb.enabled, true)
    assert.equal(cxb.hooks.length, 7, '原有 1 条 + easy-flow 6 条')
    assert.equal(cxb.hooks[0].id, 'someone-else')
    assert.match(cxb.hooks[1].command, /\/api\/hook\?agent=chengxiaobang/)
    assert.equal(cxb.hooks[1].event, 'SessionStart')
  })

  test('最要紧的一条：装完再卸完，四份配置逐字还原', () => {
    writeJson(codexFile, codexOthers())
    writeJson(claudeFile, claudeOthers())
    writeJson(cxbFile, cxbOthers())
    writeJson(cursorFile, cursorOthers())
    const codexBefore = read(codexFile)
    const claudeBefore = read(claudeFile)
    const cxbBefore = read(cxbFile)
    const cursorBefore = read(cursorFile)

    installHooks({ port: 3210, home })
    assert.notEqual(read(codexFile), codexBefore, '装完应当确实写进去了')
    assert.notEqual(read(claudeFile), claudeBefore)
    assert.notEqual(read(cxbFile), cxbBefore)
    assert.notEqual(read(cursorFile), cursorBefore)

    uninstallHooks({ home })
    assert.equal(read(codexFile), codexBefore, 'Codex：cmux 与 orca 必须逐字不变')
    assert.equal(read(claudeFile), claudeBefore, 'Claude：用户自己的 hook 必须逐字不变')
    assert.equal(read(cxbFile), cxbBefore, '程小帮：原有 hook 必须逐字不变')
    assert.equal(read(cursorFile), cursorBefore, 'Cursor：git-ai 与用户脚本必须逐字不变')
  })

  test('原文件没有行尾换行时，装完再卸完也不多出换行', () => {
    writeJson(claudeFile, claudeOthers(), false)
    const before = read(claudeFile)
    assert.ok(!before.endsWith('\n'))

    installHooks({ port: 3210, home })
    assert.ok(!read(claudeFile).endsWith('\n'), '回写要跟随原文件的行尾习惯')

    uninstallHooks({ home })
    assert.equal(read(claudeFile), before)
  })

  test('程小帮原本没有 hooks 字段时，卸完要留一份合法配置而不是空壳', () => {
    // 小帮的 schema 要求 enabled 与 hooks 都在：删掉 hooks 会让整份配置被判「读不懂」而丢弃
    writeJson(cxbFile, { enabled: true })

    installHooks({ port: 3210, home })
    assert.equal(JSON.parse(read(cxbFile)).hooks.length, 6)

    uninstallHooks({ home })
    const after = JSON.parse(read(cxbFile))
    assert.deepEqual(after.hooks, [], '条目摘干净，但字段还在')
    assert.equal(after.enabled, true)
  })

  test('幂等：连点两次装、连点两次卸，结果一致且不重复', () => {
    writeJson(codexFile, codexOthers())

    installHooks({ port: 3210, home })
    const afterFirst = read(codexFile)
    const second = installHooks({ port: 3210, home })
    assert.equal(read(codexFile), afterFirst, '第二次装不应改动文件')
    assert.match(second.summary, /已是最新/)

    const ours = JSON.parse(afterFirst).hooks.PreToolUse.filter((b: any) =>
      JSON.stringify(b).includes('/api/hook'),
    )
    assert.equal(ours.length, 1, '不能出现第二条')

    uninstallHooks({ home })
    const cleaned = read(codexFile)
    const again = uninstallHooks({ home })
    assert.equal(read(codexFile), cleaned, '第二次卸不应改动文件')
    assert.match(again.summary, /没有需要卸载的条目/)
  })

  test('这次写入了 Cursor 的 hooks.json 才在结论里提示重启', () => {
    const first = installHooks({ port: 3210, home })
    assert.match(first.summary, /重启 Cursor/)

    const cursorBefore = read(cursorFile)
    rmSync(claudeFile, { force: true })
    const second = installHooks({ port: 3210, home })
    assert.equal(second.summary, '已安装')
    assert.equal(read(cursorFile), cursorBefore)
  })

  test('端口变了，装出来的地址跟着更新', () => {
    writeJson(codexFile, codexOthers())
    writeJson(claudeFile, claudeOthers())
    writeJson(cxbFile, cxbOthers())

    installHooks({ port: 3210, home })
    assert.match(read(codexFile), /127\.0\.0\.1:3210\/api\/hook\?agent=codex/)

    installHooks({ port: 4000, home })
    const codex = read(codexFile)
    const claude = read(claudeFile)
    assert.match(codex, /127\.0\.0\.1:4000\/api\/hook\?agent=codex/)
    assert.doesNotMatch(codex, /:3210\//)
    assert.match(claude, /http:\/\/127\.0\.0\.1:4000\/api\/hook'/)
    assert.doesNotMatch(claude, /:3210\//)
    // 别人的还在、位置没动
    assert.deepEqual(JSON.parse(codex).hooks.Stop.slice(0, 2), codexOthers().hooks.Stop)
  })

  test('文件不是合法 JSON 时整个拒改，原文一字不动', () => {
    mkdirSync(dirname(codexFile), { recursive: true })
    writeFileSync(codexFile, '{ this is not json', 'utf8')
    const before = read(codexFile)

    assert.throws(() => installHooks({ port: 3210, home }), /不是合法 JSON/)
    assert.equal(read(codexFile), before)
  })

  test('hooks 字段形状不认识时拒改，不覆盖', () => {
    writeJson(codexFile, { hooks: ['not-an-object'] })
    const before = read(codexFile)
    assert.throws(() => installHooks({ port: 3210, home }), /hooks 字段不是对象/)
    assert.equal(read(codexFile), before)
  })

  test('每次改动前都留 .bak：装前备份原文，卸前备份当时那份', () => {
    writeJson(codexFile, codexOthers())
    const before = read(codexFile)

    installHooks({ port: 3210, home })
    const installed = read(codexFile)
    assert.equal(read(`${codexFile}.bak`), before, '.bak 是改动前那一份')

    uninstallHooks({ home })
    assert.equal(read(`${codexFile}.bak`), installed, '卸前把当时那份也备份下来')
    assert.equal(read(codexFile), before, '卸完回到原文')
  })
})

// ----------------------------------------------------------- HTTP 层接线
describe('/api/hooks 路由', () => {
  let home: string
  let dir: string
  let originalHome: string | undefined
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string

  before(async () => {
    home = join(TMP, `http-home-${Date.now()}`)
    dir = join(TMP, `http-board-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    mkdirSync(dir, { recursive: true })
    // 让 homedir() 落到临时目录：全程不碰真实用户配置
    originalHome = process.env.HOME
    process.env.HOME = home

    app = createBoardApp({ dataDir: dir, port: 4321 })
    server = createServer((rq, rs) => void app.handle(rq, rs))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    app.close()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  const post = (p: string) => fetch(`${base}${p}`, { method: 'POST' })

  test('GET 反映真文件，POST 装 / 卸走同一条路径', async () => {
    const empty = (await (await fetch(`${base}/api/hooks`)).json()) as any
    assert.equal(empty.port, 4321)
    assert.equal(empty.agents.length, 4)
    assert.ok(empty.agents.every((a: any) => a.installed === false))

    const installed = (await (await post('/api/hooks/install')).json()) as any
    assert.match(installed.summary, /^已安装/)
    assert.match(installed.summary, /重启 Cursor/)
    assert.deepEqual(installed.failed, [])
    assert.deepEqual(
      installed.agents.map((a: any) => a.installed),
      [true, true, true, true],
    )
    assert.match(installed.agents[0].url, /:4321\/api\/hook/)

    const removed = (await (await post('/api/hooks/uninstall')).json()) as any
    assert.equal(removed.summary, '已卸载')
    assert.ok(removed.agents.every((a: any) => a.installed === false))
  })
})
