import { startBoardServer, DEFAULT_PORT } from './index.ts'
import { createLogger } from './log.ts'

// 仅用于浏览器开发：`pnpm dev:server`，配合 `pnpm dev:web` 的 Vite proxy。
// Electron 场景下由 src/main/index.ts 直接调 startBoardServer，不走这里。
const port = Number(process.env.PORT ?? DEFAULT_PORT)
const log = createLogger('easy-flow')

startBoardServer({ port }).catch((err: Error) => {
  log.error(`start failed: ${err.message}`)
  process.exit(1)
})
