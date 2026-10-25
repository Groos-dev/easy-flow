/**
 * 命令行版本：主进程注入的 EASY_FLOW_VERSION 优先于按源码位置读 package.json。
 * 打成独立文件后，源码那条相对路径不存在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

test('EASY_FLOW_VERSION 覆盖 package.json 里的版本', () => {
  const result = spawnSync(process.execPath, [join(REPO, 'server/cli.ts'), '--version'], {
    cwd: REPO,
    env: { ...process.env, EASY_FLOW_VERSION: '9.9.9' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '9.9.9')
})
