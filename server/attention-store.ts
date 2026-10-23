/**
 * 待处理事件的落盘：临时文件 + rename，写一半被杀也不会留下截断的 JSON。
 *
 * 不碰 Electron，放在 server/ 是为了让 node --test 也能覆盖原子写。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readAttentionFile, type AttentionEvent } from './attention.ts'
import { createLogger } from './log.ts'

const log = createLogger('attention')

export interface AttentionStore {
  read: () => AttentionEvent[]
  write: (events: readonly AttentionEvent[]) => void
}

export function createAttentionStore(file: string): AttentionStore {
  let lastRaw = ''
  return {
    read() {
      try {
        return readAttentionFile(readFileSync(file, 'utf8'))
      } catch {
        return []
      }
    },
    write(events) {
      const raw = JSON.stringify({ events })
      if (raw === lastRaw) return
      try {
        const tmp = `${file}.easy-flow-${process.pid}.tmp`
        writeFileSync(tmp, raw)
        renameSync(tmp, file)
        // 写成功后才认这份内容，失败时下次还能重试
        lastRaw = raw
      } catch (err) {
        log.warn(`persist failed: ${(err as Error).message}`)
      }
    },
  }
}
