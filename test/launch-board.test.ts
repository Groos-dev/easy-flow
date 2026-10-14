import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { createBoardApp } from '../server/index.ts'
import { launchPrompt, launchProviders, registerLaunchProvider, type LaunchInput } from '../server/launch.ts'
import { launchResultFeedback, launchWorktreeSelection, worktreeCreationCommand } from '../src/renderer/src/lib/launch.ts'
import type { Worktree } from '../src/renderer/src/lib/types.ts'

const testRoot = mkdtempSync(join(tmpdir(), 'easy-flow-launch-board-'))
const worktreePath = join(testRoot, 'worktree-alpha')
const configFile = join(testRoot, 'config.json')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(repoRoot, 'server/cli.ts')

let app: ReturnType<typeof createBoardApp>
let server: ReturnType<typeof createServer>
let base: string
let previousPath: string | undefined
let previousOpenFail: string | undefined
let builtInput: LaunchInput | undefined
let builtPrompt = ''
let buildError = ''

function makeRequirement(dataDir: string, project: string, slug: string, id: string): void {
  const path = join(dataDir, project, slug)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'AGENTS.md'), `---\nid: ${id}\n---\n`, 'utf8')
  writeFileSync(join(path, 'requirement.md'), `# ${slug}\n\n## 需求\n\n需求正文`, 'utf8')
}

const worktree = (id: string, branch: string, missing = false): Worktree => ({
  id,
  requirementId: 'req-alpha',
  short: 'router',
  repo: 'easy-flow',
  branch,
  path: join(testRoot, id),
  main: join(testRoot, 'main'),
  created: '2026-10-12 10:00',
  updated: '2026-10-12 10:00',
  missing,
})

describe('需求详情页启动会话', () => {
  before(async () => {
    const dataDir = join(testRoot, 'data')
    makeRequirement(dataDir, 'demo', 'alpha', 'req-alpha')
    makeRequirement(dataDir, 'demo', 'beta', 'req-beta')
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(join(testRoot, 'worktree-beta'), { recursive: true })
    app = createBoardApp({ dataDir })
    app.db.addWorktree({
      id: 'wt-alpha',
      requirementId: 'req-alpha',
      short: 'router',
      repo: 'easy-flow',
      branch: 'feature-alpha',
      path: worktreePath,
      main: join(testRoot, 'main'),
    })
    app.db.addWorktree({
      id: 'wt-beta',
      requirementId: 'req-beta',
      short: 'other',
      repo: 'easy-flow',
      branch: 'feature-beta',
      path: join(testRoot, 'worktree-beta'),
      main: join(testRoot, 'main'),
    })
    writeFileSync(configFile, JSON.stringify({ dataDir }), 'utf8')

    const bin = join(testRoot, 'bin')
    mkdirSync(bin)
    const openShim = join(bin, 'open')
    writeFileSync(openShim, '#!/bin/sh\nif [ "$EASY_FLOW_TEST_OPEN_FAIL" = "1" ]; then echo "handler unavailable" >&2; exit 42; fi\nexit 0\n')
    chmodSync(openShim, 0o755)
    previousPath = process.env.PATH
    previousOpenFail = process.env.EASY_FLOW_TEST_OPEN_FAIL
    process.env.PATH = `${bin}:${previousPath ?? ''}`

    registerLaunchProvider({
      id: 'codex',
      label: '测试 Codex',
      build: (input, prompt) => {
        builtInput = input
        builtPrompt = prompt
        if (buildError) throw new Error(buildError)
        return 'codex-test://new-session'
      },
    })
    // claude 也占上：真实 provider 由并行子需求提供，这里只验证看板侧的启动流程
    registerLaunchProvider({
      id: 'claude',
      label: '测试 Claude Code',
      build: () => 'claude-test://new-session',
    })

    server = createServer((req, res) => void app.handle(req, res))
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  after(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    app.close()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousOpenFail === undefined) delete process.env.EASY_FLOW_TEST_OPEN_FAIL
    else process.env.EASY_FLOW_TEST_OPEN_FAIL = previousOpenFail
    rmSync(testRoot, { recursive: true, force: true })
  })

  const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>
  const post = async (path: string, body: unknown) =>
    (await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json() as Promise<any>

  test('provider API 只暴露注册表中的 id 与 label', async () => {
    const result = await get('/api/launch/providers')
    assert.deepEqual(result.providers, launchProviders().map(({ id, label }) => ({ id, label })))
    assert.ok(result.providers.some((p: any) => p.id === 'codex' && p.label === '测试 Codex'))
    assert.equal('build' in result.providers.find((p: any) => p.id === 'codex'), false)
  })

  test('UI 工作区选择：唯一可用项直选，多项留空，失联目录不可选', () => {
    const one = worktree('wt-one', 'feature-one')
    const two = worktree('wt-two', 'feature-two')
    const gone = worktree('wt-gone', 'feature-gone', true)
    assert.deepEqual(launchWorktreeSelection([one]), { available: [one], selectedId: 'wt-one' })
    assert.equal(launchWorktreeSelection([one, two]).selectedId, '')
    assert.deepEqual(launchWorktreeSelection([gone]), { available: [], selectedId: '' })
    assert.equal(launchWorktreeSelection([one, two], 'wt-two').selectedId, 'wt-two')
    assert.equal(worktreeCreationCommand('req-alpha'), 'easy-flow wt new req-alpha --repo <仓库> --branch feature-<需求 slug>')

    const renderScript = `
      import { createElement } from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import Form from './src/renderer/src/components/LaunchSessionForm.tsx'
      const base = {
        requirementId: 'req-alpha', providers: [{ id: 'codex', label: 'Codex' }],
        worktreeId: '', agent: 'codex', loading: false, providerError: '', requestError: '',
        busy: false, result: null, onWorktreeChange() {}, onAgentChange() {}, onLaunch() {},
      }
      const one = { id: 'wt-one', requirementId: 'req-alpha', short: 'router', repo: 'easy-flow', branch: 'feature-one', path: '/tmp/one', main: '/tmp/main', created: '', updated: '', missing: false }
      const two = { ...one, id: 'wt-two', branch: 'feature-two' }
      const render = (props) => renderToStaticMarkup(createElement(Form, { ...base, ...props }))
      console.log(JSON.stringify({
        one: render({ worktrees: [one], worktreeId: 'wt-one', agent: 'claude' }),
        multiple: render({ worktrees: [one, two], agent: 'claude' }),
        codex: render({ worktrees: [one, two] }),
        empty: render({ worktrees: [] }),
        failure: render({ worktrees: [one], worktreeId: 'wt-one', result: { agent: 'codex', url: 'codex-test://new-session', prompt: 'easy-flow context wt-one', opened: false, error: 'handler unavailable' } }),
      }))
    `
    const rendered = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', renderScript], {
      cwd: repoRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.web.json') },
      encoding: 'utf8',
    })
    assert.equal(rendered.status, 0, rendered.stderr)
    const markup = JSON.parse(rendered.stdout)
    assert.match(markup.one, /easy-flow · feature-one/)
    assert.match(markup.one, /type="button" class="select-trigger"/)
    assert.match(markup.multiple, /选择工作区/)
    assert.match(markup.multiple, /launch-submit" type="submit" disabled=""/)
    // Codex 按需求建 project、收全部工作区，不出现工作区选择
    assert.match(markup.codex, /不用选/)
    assert.doesNotMatch(markup.codex, /选择工作区/)
    assert.match(markup.empty, /easy-flow wt new req-alpha/)
    assert.match(markup.failure, /role="alert"/)
    assert.match(markup.failure, /handler unavailable/)
    assert.match(markup.failure, /easy-flow context wt-one/)
    assert.match(markup.failure, /aria-label="复制提示词"/)
    assert.match(markup.failure, /easy-flow req session add req-alpha --agent codex/)
    assert.match(markup.failure, /手动重试打开会话草稿/)
    assert.match(markup.failure, /href="codex-test:\/\/new-session"/)
    assert.doesNotMatch(markup.failure, /已创建成功/)
    const selectMenu = readFileSync(join(repoRoot, 'src/renderer/src/components/SelectMenu.tsx'), 'utf8')
    assert.equal((selectMenu.match(/type="button"/g) ?? []).length, 2)
  })

  test('api.launch 将 HTTP 200 的启动失败保留为结果，并且 ctx 未加载时不显示启动入口', async () => {
    const vite = await createViteServer({
      configFile: false,
      root: repoRoot,
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
    })
    const previousFetch = globalThis.fetch
    const previousOpenFail = process.env.EASY_FLOW_TEST_OPEN_FAIL
    try {
      const { api } = await vite.ssrLoadModule('/src/renderer/src/lib/api.ts') as {
        api: { launch(input: { slug: string; project: string; worktreeId: string; agent: 'codex' | 'claude' }): Promise<any> }
      }
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(input), base)
        return previousFetch(new URL(`${path.pathname}${path.search}`, base), init)
      }) as typeof fetch
      process.env.EASY_FLOW_TEST_OPEN_FAIL = '1'
      const result = await api.launch({ slug: 'alpha', project: 'demo', worktreeId: 'wt-alpha', agent: 'codex' })
      assert.equal(result.opened, false)
      assert.match(result.error, /handler unavailable|42/)
      assert.match(result.prompt, /easy-flow context req-alpha/)
      const { default: LaunchSessionForm } = await vite.ssrLoadModule('/src/renderer/src/components/LaunchSessionForm.tsx') as {
        default: any
      }
      const formHtml = renderToStaticMarkup(createElement(LaunchSessionForm, {
        requirementId: 'req-alpha', worktrees: [worktree('wt-alpha', 'feature-alpha')],
        providers: [{ id: 'codex', label: 'Codex' }], worktreeId: 'wt-alpha', agent: 'codex',
        loading: false, providerError: '', requestError: '', busy: false, result,
        onWorktreeChange: () => {}, onAgentChange: () => {}, onLaunch: () => {},
      }))
      assert.match(formHtml, /handler unavailable/)
      assert.match(formHtml, /easy-flow context req-alpha/)
      assert.match(formHtml, /aria-label="复制提示词"/)
      assert.match(formHtml, /easy-flow req session add req-alpha --agent codex/)
      await assert.rejects(
        api.launch({ slug: 'alpha', project: 'demo', worktreeId: 'wt-beta', agent: 'claude' }),
        /does not belong to requirement/,
      )

      const { default: InfoPanel } = await vite.ssrLoadModule('/src/renderer/src/components/InfoPanel.tsx') as {
        default: any
      }
      const html = renderToStaticMarkup(createElement(InfoPanel, {
        req: {
          slug: 'alpha', project: 'demo', id: 'req-alpha', title: 'alpha', path: '',
          feishuTaskLinks: [], codeLinks: [], extLinks: [], links: '',
        },
        ctx: null,
        onOpenTodo: () => {},
      }) as never)
      assert.doesNotMatch(html, /新建 Agent 会话|wt new req-alpha/)
    } finally {
      globalThis.fetch = previousFetch
      if (previousOpenFail === undefined) delete process.env.EASY_FLOW_TEST_OPEN_FAIL
      else process.env.EASY_FLOW_TEST_OPEN_FAIL = previousOpenFail
      await vite.close()
    }
  })

  test('POST launch 从需求关联记录取路径，打开草稿但不预登记会话', async () => {
    const result = await post('/api/launch', {
      slug: 'alpha',
      project: 'demo',
      worktreeId: 'wt-alpha',
      agent: 'codex',
      worktreePath: '/tmp/untrusted',
    })
    // Codex 不绑单个工作区：需求名下全部可用工作区进 project roots
    const input: LaunchInput = {
      agent: 'codex',
      requirementId: 'req-alpha',
      worktreeId: '',
      worktreePath: '',
      requirementWorktreePaths: [worktreePath],
    }
    assert.deepEqual(builtInput, input)
    assert.equal(builtPrompt, launchPrompt(input))
    assert.equal(result.agent, 'codex')
    assert.equal(result.url, 'codex-test://new-session')
    assert.equal(result.prompt, launchPrompt(input))
    assert.equal(result.opened, true)
    assert.equal(result.error, undefined)
    const feedback = launchResultFeedback('req-alpha', result)
    assert.equal(feedback.role, 'status')
    assert.match(feedback.title, /待发送的新会话草稿/)
    assert.match(feedback.title, /尚未登记会话/)
    assert.doesNotMatch(result.prompt, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(app.db.listSessions('req-alpha').some((s) => s.session === 'thread-launch-1'), false)

    const env: NodeJS.ProcessEnv = { ...process.env, EASY_FLOW_CONFIG: configFile, CODEX_THREAD_ID: 'thread-launch-1' }
    for (const name of ['CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CURSOR_CONVERSATION_ID']) delete env[name]
    const first = spawnSync(process.execPath, [cliPath, 'req', 'session', 'add', 'req-alpha', '--agent', 'codex', '--title', '启动入口验证'], {
      cwd: worktreePath,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /已登记会话/)
    const session = app.db.listSessions('req-alpha')
    assert.equal(session.length, 1)
    assert.equal(session[0].session, 'thread-launch-1')
    assert.equal(session[0].role, 'dev')
    assert.equal(session[0].cwd, realpathSync(worktreePath))

    const repeated = spawnSync(process.execPath, [cliPath, 'req', 'session', 'add', 'req-alpha', '--agent', 'codex', '--title', '更新标题'], {
      cwd: worktreePath,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.equal(app.db.listSessions('req-alpha').length, 1)
    assert.equal(app.db.listSessions('req-alpha')[0].title, '更新标题')
  })

  test('启动 URL handler 失败时返回可复制 prompt、原因且不登记会话', async () => {
    const before = app.db.listSessions('req-alpha').map((s) => s.session)
    process.env.EASY_FLOW_TEST_OPEN_FAIL = '1'
    const result = await post('/api/launch', {
      slug: 'alpha', project: 'demo', worktreeId: 'wt-alpha', agent: 'codex',
    })
    delete process.env.EASY_FLOW_TEST_OPEN_FAIL
    assert.equal(result.opened, false)
    assert.match(result.error, /handler unavailable|42/)
    assert.match(result.prompt, /easy-flow context req-alpha/)
    assert.match(result.prompt, /easy-flow req session add req-alpha --agent codex/)
    assert.deepEqual(app.db.listSessions('req-alpha').map((s) => s.session), before)
    const feedback = launchResultFeedback('req-alpha', result)
    assert.equal(feedback.role, 'alert')
    assert.match(feedback.title, /启动失败/)
    assert.match(feedback.detail, /尚未创建会话记录/)
    assert.equal(feedback.prompt, result.prompt)
    assert.match(feedback.manualCommand, /easy-flow req session add req-alpha --agent codex/)
    assert.doesNotMatch(feedback.title, /已打开|已创建成功/)
  })

  test('provider 构建失败、未注册 agent、以及非本需求工作区都不误报打开成功', async () => {
    const before = app.db.listSessions('req-alpha').map((s) => s.session)
    buildError = 'provider build failed'
    const failedBuild = await post('/api/launch', {
      slug: 'alpha', project: 'demo', worktreeId: 'wt-alpha', agent: 'codex',
    })
    buildError = ''
    assert.equal(failedBuild.opened, false)
    assert.equal(failedBuild.error, 'provider build failed')
    assert.ok(failedBuild.prompt)

    // 注册表里没有的 agent 直接拒掉，而不是返回一个"打开了"的假象
    const unsupported = await post('/api/launch', {
      slug: 'alpha', project: 'demo', worktreeId: 'wt-alpha', agent: 'cursor',
    })
    assert.match(unsupported.error, /Unknown launch agent/i)

    // 跨需求的工作区只在 Claude 那条路上拦（它必须指定一个工作目录）
    const foreign = await post('/api/launch', {
      slug: 'alpha', project: 'demo', worktreeId: 'wt-beta', agent: 'claude',
    })
    assert.match(foreign.error, /belong|requirement|Worktree/i)
    assert.deepEqual(app.db.listSessions('req-alpha').map((s) => s.session), before)
  })
})
