/** 待处理事件落盘：原子写、坏文件兜底、内容不变不重写 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attentionPushKeyOf, type AttentionEvent } from '../server/attention.ts'
import { createAttentionStore } from '../server/attention-store.ts'

const EVENT: AttentionEvent = {
  id: 'claude:s-1',
  pushKey: attentionPushKeyOf('claude', 's-1', 'done', 100),
  agent: 'claude',
  session: 's-1',
  sessionTitle: '修复通知图标',
  link: '',
  requirement: { id: 'req-1', title: '通知能力', slug: 'agent-notifications', project: 'easy-flow' },
  state: 'done',
  needsAction: '',
  observedAt: 100,
}

function tempFile(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-attention-'))
  return { dir, file: join(dir, 'attention.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('attention store', () => {
  test('原子写：落盘可读，且不留下临时文件', () => {
    const { dir, file, cleanup } = tempFile()
    try {
      const store = createAttentionStore(file)
      store.write([EVENT])

      assert.deepEqual(store.read(), [EVENT])
      assert.deepEqual(readdirSync(dir), ['attention.json'])
    } finally {
      cleanup()
    }
  })

  test('磁盘上是坏文件时读成空数组，不抛', () => {
    const { file, cleanup } = tempFile()
    try {
      writeFileSync(file, '{broken')
      assert.deepEqual(createAttentionStore(file).read(), [])
    } finally {
      cleanup()
    }
  })

  test('内容没变就不重写文件', () => {
    const { file, cleanup } = tempFile()
    try {
      const store = createAttentionStore(file)
      store.write([EVENT])

      // 外部改掉文件；同样的内容再写一次，
      // 如果 store 没做去重就会覆盖回去
      writeFileSync(file, 'sentinel')
      store.write([EVENT])
      assert.equal(readFileSync(file, 'utf8'), 'sentinel')
    } finally {
      cleanup()
    }
  })
})
