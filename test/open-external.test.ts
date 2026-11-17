import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import * as links from '../src/main/open-links.ts'

describe('外链打开回执', () => {
  test('系统默认打开完成前，调用方保持等待', async () => {
    let resolve = () => {}
    const promise = new Promise<void>((finish) => { resolve = finish })
    let completed = false
    const opening = links.openExternalLink('https://example.com', () => promise, 'darwin')
      .then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    resolve()
    await opening
    assert.equal(completed, true)
  })

  test('系统默认打开失败，错误回传给调用方', async () => {
    const failure = new Error('No application can open this URL')
    await assert.rejects(
      links.openExternalLink('claude://session/demo', async () => { throw failure }, 'darwin'),
      failure,
    )
  })

  test('macOS 指定应用打开完成前不报告成功', async () => {
    let finish: (error: Error | null) => void = () => { throw new Error('No open request') }
    const launch = mock.method(childProcess, 'execFile', (_command: string, _args: string[], callback: (error: Error | null) => void) => {
      finish = callback
    })
    try {
      let completed = false
      const opening = links.openExternalLink('codex://threads/demo', async () => {
        throw new Error('Unexpected system-default route')
      }, 'darwin').then(() => { completed = true })
      await Promise.resolve()
      assert.equal(completed, false)
      assert.deepEqual(launch.mock.calls[0].arguments.slice(0, 2), ['open', ['-b', 'com.openai.codex', 'codex://threads/demo']])
      finish(null)
      await opening
      assert.equal(completed, true)
    } finally {
      launch.mock.restore()
    }
  })

  test('macOS 找不到指定应用，命令错误回传', async () => {
    const failure = new Error('Unable to find application with bundle identifier')
    const launch = mock.method(childProcess, 'execFile', (_command: string, _args: string[], callback: (error: Error) => void) => {
      callback(failure)
    })
    try {
      await assert.rejects(
        links.openExternalLink('chengxiaobang://session/demo', async () => {}, 'darwin'),
        failure,
      )
    } finally {
      launch.mock.restore()
    }
  })

  test('非 macOS 深链沿用系统默认打开并回传失败', async () => {
    const failure = new Error('Unsupported URL scheme')
    await assert.rejects(
      links.openExternalLink('codex://threads/demo', async () => { throw failure }, 'linux'),
      failure,
    )
  })
})
