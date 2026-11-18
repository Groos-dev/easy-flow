import { parentPort } from 'node:worker_threads'
import { BoardDatabase } from './db.ts'
import type { FileSyncRequest, FileSyncReply } from './file-sync.ts'

let db: BoardDatabase | null = null
parentPort!.on('message', ({ id, dataDir }: FileSyncRequest) => {
  let reply: FileSyncReply
  try {
    if (db?.dataDir !== dataDir) {
      db?.close()
      db = new BoardDatabase(dataDir)
    }
    reply = { id, sync: db.syncProjects() }
  } catch (error) {
    reply = { id, error: (error as Error).message }
  }
  parentPort!.postMessage(reply)
})
