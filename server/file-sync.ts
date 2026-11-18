import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import type { BoardDatabase } from './db.ts'

type SyncResult = ReturnType<BoardDatabase['syncProjects']>
export interface FileSyncRequest { id: number; dataDir: string }
export type FileSyncReply = { id: number } & ({ sync: SyncResult } | { error: string })

export function createFileSync(file: string) {
  const worker = file.endsWith('.ts')
    ? new Worker(`require(${JSON.stringify(createRequire(file).resolve('tsx/cjs'))}); require(${JSON.stringify(file)})`, { eval: true })
    : new Worker(file)
  const pending = new Map<number, { resolve: (sync: SyncResult) => void; reject: (error: Error) => void }>()
  let sequence = 0
  let failure: Error | null = null
  const fail = (error: Error) => {
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', () => fail(new Error('文件同步 worker 已退出')))
  worker.on('message', (reply: FileSyncReply) => {
    const request = pending.get(reply.id)
    if (!request) return
    pending.delete(reply.id)
    if ('error' in reply) request.reject(new Error(reply.error))
    else request.resolve(reply.sync)
  })
  return {
    scan(dataDir: string): Promise<SyncResult> {
      if (failure) return Promise.reject(failure)
      const id = ++sequence
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, dataDir } satisfies FileSyncRequest)
      })
    },
    async close() {
      fail(new Error('文件同步已关闭'))
      await worker.terminate()
    },
  }
}
