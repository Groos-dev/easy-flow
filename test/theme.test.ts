// 主题解析口径与 /api/settings/theme 契约
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardApp } from '../server/index.ts'
import { readConfig } from '../server/config.ts'
import { isTheme, resolveTheme } from '../src/shared/theme.ts'

describe('主题取值', () => {
  test('跟随系统按系统色系解析', () => {
    assert.equal(resolveTheme('system', true), 'light')
    assert.equal(resolveTheme('system', false), 'dark')
  })

  test('显式选择不看系统', () => {
    assert.equal(resolveTheme('light', false), 'light')
    assert.equal(resolveTheme('dark', true), 'dark')
  })

  test('只认三档', () => {
    assert.equal(isTheme('system'), true)
    assert.equal(isTheme('light'), true)
    assert.equal(isTheme('dark'), true)
    assert.equal(isTheme(''), false)
    assert.equal(isTheme('auto'), false)
  })
})

describe('主题接口', () => {
  let dir: string
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string
  let prevConfig: string | undefined

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'easy-flow-theme-api-'))
    prevConfig = process.env.EASY_FLOW_CONFIG
    process.env.EASY_FLOW_CONFIG = join(dir, 'config.json')
    app = createBoardApp({ dataDir: join(dir, 'data') })
    server = createServer((req, res) => void app.handle(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    app.close()
    if (prevConfig === undefined) delete process.env.EASY_FLOW_CONFIG
    else process.env.EASY_FLOW_CONFIG = prevConfig
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async () => (await fetch(`${base}/api/settings/theme`)).json() as Promise<any>
  const post = async (body: unknown) =>
    (await fetch(`${base}/api/settings/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json() as Promise<any>

  test('默认跟随系统', async () => {
    assert.equal((await get()).theme, 'system')
  })

  test('切换后落盘，重启读配置仍是它', async () => {
    const r = await post({ theme: 'light' })
    assert.equal(r.theme, 'light')
    assert.equal(readConfig().theme, 'light')
    assert.equal((await get()).theme, 'light')
  })

  test('未知取值拒绝且不改配置', async () => {
    const r = await post({ theme: 'sepia' })
    assert.match(r.error, /Unknown theme/)
    assert.equal(readConfig().theme, 'light')
  })
})
