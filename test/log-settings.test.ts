import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardApp } from '../server/index.ts'
import { readConfig } from '../server/config.ts'

test('日志级别设置可读取、保存并拒绝非法值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-log-settings-'))
  const previous = process.env.EASY_FLOW_CONFIG
  process.env.EASY_FLOW_CONFIG = join(dir, 'config.json')
  const app = createBoardApp({ dataDir: join(dir, 'data') })
  const server = createServer((req, res) => void app.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/settings/log-level`
  const post = (logLevel: string) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logLevel }),
  })
  try {
    assert.equal((await (await fetch(url)).json()).logLevel, 'info')
    assert.equal((await (await post('debug')).json()).logLevel, 'debug')
    assert.equal(readConfig().logLevel, 'debug')
    assert.equal((await (await fetch(url)).json()).logLevel, 'debug')
    assert.match((await (await post('verbose')).json()).error, /Unknown log level/)
    assert.equal(readConfig().logLevel, 'debug')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.close()
    if (previous === undefined) delete process.env.EASY_FLOW_CONFIG
    else process.env.EASY_FLOW_CONFIG = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
