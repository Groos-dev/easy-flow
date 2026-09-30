import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * 仅用于浏览器开发：`pnpm dev:server` + `pnpm dev:web`。
 * Electron 场景走 electron.vite.config.ts，两端前端代码完全一致。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  server: {
    port: 5273,
    proxy: { '/api': 'http://127.0.0.1:3210' },
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') },
  },
})
