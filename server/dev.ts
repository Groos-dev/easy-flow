import { startBoardServer, DEFAULT_PORT } from './index.ts'

// 仅用于浏览器开发：`pnpm dev:server`，配合 `pnpm dev:web` 的 Vite proxy。
// Electron 场景下由 src/main/index.ts 直接调 startBoardServer，不走这里。
const port = Number(process.env.PORT ?? DEFAULT_PORT)

startBoardServer({ port }).catch((err: Error) => {
  console.error('[easy-flow] 启动失败:', err.message)
  process.exit(1)
})
