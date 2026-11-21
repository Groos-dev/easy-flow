import { isLanguage, setLanguage, t } from '../src/shared/i18n.ts'
import { parentPort } from 'node:worker_threads'
import { BoardDatabase } from './db.ts'
import type { FileSyncRequest, FileSyncReply } from './file-sync.ts'

let db: BoardDatabase | null = null
parentPort!.on('message', ({ id, dataDir, language }: FileSyncRequest) => {
  let reply: FileSyncReply
  try {
    if (!isLanguage(language)) throw new Error(t('Invalid synchronization language'))
    setLanguage(language)
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
