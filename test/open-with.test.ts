/**
 * 本机打开方式的扫描。只认白名单：app 名字对得上才上桌——猜错的表现是「点了没反应」。
 * 这里喂临时目录，不依赖这台机器装了什么。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appDirs, appIconFile, appIconDataUrl, findOpenTarget, scanOpenTargets } from '../server/open-with.ts'
import { externalOpenArgs } from '../src/main/open-links.ts'

function fakeDirs(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-open-with-'))
  for (const name of names) mkdirSync(join(dir, name))
  return dir
}

describe('打开方式 · 扫描本机 app', () => {
  test('只认白名单里的 app，顺序按白名单（编辑器在前、终端在后）', () => {
    const dir = fakeDirs(['Cursor.app', 'WezTerm.app', 'IntelliJ IDEA.app', 'SomeRandomEditor.app'])
    try {
      const found = scanOpenTargets([dir])
      assert.deepEqual(found.map((t) => t.id), ['idea', 'cursor', 'wezterm'])
      assert.deepEqual(found.map((t) => t.kind), ['editor', 'editor', 'terminal'])
      assert.equal(found[0].app, join(dir, 'IntelliJ IDEA.app'))
      assert.equal(found[2].label, 'WezTerm')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('同一个 app 落在多个目录时取先扫到的那个', () => {
    const first = fakeDirs(['Cursor.app'])
    const second = fakeDirs(['Cursor.app'])
    try {
      const found = scanOpenTargets([first, second])
      assert.equal(found.length, 1)
      assert.equal(found[0].app, join(first, 'Cursor.app'))
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  test('认得出别名：VS Code Insiders 也归到 vscode', () => {
    const dir = fakeDirs(['Visual Studio Code - Insiders.app'])
    try {
      assert.deepEqual(scanOpenTargets([dir]).map((t) => t.id), ['vscode'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('按设置里的 id 找 app：空 id 是访达，配的 app 不在了给 undefined', () => {
    const dir = fakeDirs(['Cursor.app'])
    try {
      assert.equal(findOpenTarget('', [dir]), undefined)
      assert.equal(findOpenTarget('cursor', [dir])?.app, join(dir, 'Cursor.app'))
      assert.equal(findOpenTarget('idea', [dir]), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Codex / 程小帮深链固定指定 bundle，其它链接仍走系统默认', () => {
    assert.deepEqual(externalOpenArgs('codex://threads/abc', 'darwin'), ['-b', 'com.openai.codex', 'codex://threads/abc'])
    assert.deepEqual(externalOpenArgs('chengxiaobang://session/s_abc', 'darwin'), [
      '-b',
      'com.chengxiaobang.desktop',
      'chengxiaobang://session/s_abc',
    ])
    assert.deepEqual(externalOpenArgs('https://example.com', 'darwin'), ['https://example.com'])
    assert.deepEqual(externalOpenArgs('codex://threads/abc', 'linux'), ['codex://threads/abc'])
    assert.deepEqual(externalOpenArgs('chengxiaobang://session/s_abc', 'linux'), ['chengxiaobang://session/s_abc'])
  })

  test('app 目录带上了系统自带的终端与用户目录', () => {
    const dirs = appDirs('/Users/someone')
    assert.ok(dirs.includes('/Applications'))
    assert.ok(dirs.includes('/Users/someone/Applications'))
    assert.ok(dirs.includes('/System/Applications/Utilities'))
  })

  test('macOS 上能从 app bundle 里找出真图标文件', { skip: process.platform !== 'darwin' }, () => {
    // 系统终端每个 macOS 都在；app.getFileIcon 那条路给的是通用占位图，所以只剩 sips 这条路
    assert.ok(appIconFile('/System/Applications/Utilities/Terminal.app').endsWith('Terminal.icns'))
    assert.equal(appIconFile('/Applications/不存在的.app'), '')
    assert.ok(appIconDataUrl('/System/Applications/Utilities/Terminal.app').startsWith('data:image/png;base64,'))
    assert.equal(appIconDataUrl('/Applications/不存在的.app'), '')
  })

  test('真机扫一遍：macOS 上至少能扫到系统终端', { skip: process.platform !== 'darwin' }, () => {
    const found = scanOpenTargets()
    assert.ok(found.some((t) => t.id === 'terminal'), `本机扫到的：${found.map((t) => t.id).join(',')}`)
  })
})
