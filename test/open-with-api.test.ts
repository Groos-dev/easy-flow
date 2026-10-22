/** /api/settings/open-with 契约；断言不依赖本机装了哪些 app */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardApp } from '../server/index.ts'
import { readConfig, writeConfig } from '../server/config.ts'

describe('打开方式接口', () => {
  let dir: string
  let app: ReturnType<typeof createBoardApp>
  let server: ReturnType<typeof createServer>
  let base: string
  let prevConfig: string | undefined

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'easy-flow-open-with-api-'))
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

  const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<any>
  const post = async (p: string, body: unknown) =>
    (await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json() as Promise<any>

  test('GET：访达永远第一项，默认是空串', async () => {
    const r = await get('/api/settings/open-with')
    assert.equal(r.default, '')
    assert.equal(r.missing, false)
    assert.equal(r.options[0].id, '')
    assert.equal(r.options[0].kind, 'finder')
    assert.equal(r.options[0].label, '访达')
    for (const o of r.options) {
      assert.equal(typeof o.label, 'string')
      assert.equal(typeof o.icon, 'string')
      assert.ok(['finder', 'editor', 'terminal'].includes(o.kind))
    }
  })

  test('POST 未知 id 拒绝且不改配置', async () => {
    const r = await post('/api/settings/open-with', { id: 'ghost' })
    assert.match(r.error, /Unknown open target/)
    assert.equal(readConfig().openWith, '')
  })

  test('POST 空串选回访达并落盘', async () => {
    const r = await post('/api/settings/open-with', { id: '' })
    assert.equal(r.default, '')
    assert.equal(r.missing, false)
    assert.equal(readConfig().openWith, '')
  })

  test('配置指向已卸载的 app 时 missing 为真', async () => {
    writeConfig({ openWith: 'ghost' })
    const r = await get('/api/settings/open-with')
    assert.equal(r.default, 'ghost')
    assert.equal(r.missing, true)
  })
})
