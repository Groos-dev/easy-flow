/**
 * Codex 侧转发层回归：一是 `/api/hook?agent=codex` 让事件落进 codex 那一格（共用入口缺省算 claude），
 * 二是 scripts/codex-hook.mjs 对 agent 无感的纪律。
 *
 * 归一与暂存本身（事件名 → state、按 agent 分格、SessionEnd、子 agent）由
 * core.test.ts 覆盖；这里只测 Codex 接进来这一面，不重复那套。
 *
 * 运行：pnpm test
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createBoardApp } from '../server/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FORWARDER = join(HERE, '..', 'scripts', 'codex-hook.mjs')
const TMP = join(tmpdir(), `easy-flow-hook-${basename(process.cwd())}`)

process.env.GIT_CONFIG_GLOBAL = '/dev/null'

// ------------------------------------------------------------ HTTP 入站口

describe('/api/hook?agent=codex', () => {
  let dir: string
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string

  before(async () => {
    dir = join(TMP, 'board')
    rmSync(dir, { recursive: true, force: true })
    const reqDir = join(dir, 'onex', 'alpha')
    mkdirSync(join(reqDir, 'docs'), { recursive: true })
    writeFileSync(join(reqDir, 'AGENTS.md'), '---\nid: req-alpha\n---\n', 'utf8')
    writeFileSync(join(reqDir, 'requirement.md'), '# alpha\n\n## 需求\n\n甲需求\n', 'utf8')

    app = createBoardApp({ dataDir: dir })
    // 同一条 id 挂两个 agent：codex 的事件只能点亮 codex 那条，不能串到 claude
    app.db.addSession({ requirementId: 'req-alpha', agent: 'codex', session: 'cx-http', title: 'codex 会话' })
    app.db.addSession({ requirementId: 'req-alpha', agent: 'claude', session: 'cx-http', title: 'claude 会话' })

    server = createServer((rq, rs) => void app.handle(rq, rs))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    app.close()
    rmSync(TMP, { recursive: true, force: true })
  })

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const statusOf = async (agent: string) => {
    const r = (await (await fetch(`${base}/api/sessions`)).json()) as any
    return r.sessions.find((s: any) => s.session === 'cx-http' && s.agent === agent)?.status
  }

  test('带 ?agent=codex 时落进 codex 那一格，跟着细粒度活动走', async () => {
    const res = await post('/api/hook?agent=codex', { hook_event_name: 'PreToolUse', session_id: 'cx-http' })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
    const codex = await statusOf('codex')
    assert.equal(codex.state, 'working')
    assert.equal(codex.detail, 'hook 事件：PreToolUse')
  })

  test('同一条 id 的 claude 会话不被 codex 的事件点亮——两条管道互不串味', async () => {
    const claude = await statusOf('claude')
    assert.equal(claude.state, 'unknown', '共用入口得认来源，否则会互相点亮')
  })
})

// ------------------------------------------------------------ 转发脚本

describe('codex-hook 转发脚本', () => {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'cx-fwd', cwd: '/tmp' })

  /** 跑一次转发脚本，把 input 喂进它的 stdin。捕获用的 server 在测试进程里，必须异步跑 */
  function runForwarder(
    input: string,
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; code: number | null; ms: number }> {
    return new Promise((resolve) => {
      const start = Date.now()
      const child = spawn('node', [FORWARDER], { env: { ...process.env, ...env } })
      let stdout = ''
      child.stdout.on('data', (c) => (stdout += c))
      child.on('close', (code) => resolve({ stdout, code, ms: Date.now() - start }))
      child.stdin.end(input)
    })
  }

  test('把 stdin 原样 POST 到 /api/hook?agent=codex，并回 {}', async () => {
    let seen: { method?: string; url?: string; body?: string; ct?: string } = {}
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen = { method: req.method, url: req.url, body, ct: req.headers['content-type'] }
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const { stdout, code } = await runForwarder(payload, { EASY_FLOW_PORT: String(port) })
      assert.equal(code, 0)
      assert.equal(stdout, '{}')
      assert.equal(seen.method, 'POST')
      assert.equal(seen.url, '/api/hook?agent=codex', '必须标来源，否则会落进 claude 那一格')
      assert.equal(seen.body, payload)
      assert.equal(seen.ct, 'application/json')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  test('服务没开也静默退回：回 {}、正常退出', async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const deadPort = (probe.address() as { port: number }).port
    await new Promise<void>((r) => probe.close(() => r()))

    const out = execFileSync('node', [FORWARDER], {
      input: payload,
      env: { ...process.env, EASY_FLOW_PORT: String(deadPort) },
      timeout: 8_000,
    }).toString()
    assert.equal(out, '{}')
  })

  test('服务收下但不回应也在 3 秒内收口——总闸不只是 HTTP 请求超时', async () => {
    const server = createServer(() => {})
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const { stdout, code, ms } = await runForwarder(payload, { EASY_FLOW_PORT: String(port) })
      assert.equal(code, 0)
      assert.equal(stdout, '{}')
      assert.ok(ms < 4_500, `应在 3 秒总闸附近收口，实测 ${ms}ms`)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  test('空 stdin 直接回 {}', () => {
    const out = execFileSync('node', [FORWARDER], { input: '' }).toString()
    assert.equal(out, '{}')
  })
})
