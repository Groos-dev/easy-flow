import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // sandbox 化的预加载脚本必须是 CommonJS，ESM 会报
      // "Cannot use import statement outside a module"
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    server: {
      // 渲染层用相对路径访问 /api，必须转发到内嵌服务；
      // 缺了这条会落到 SPA fallback 返回 index.html，前端 JSON 解析失败整页白屏。
      proxy: { '/api': 'http://127.0.0.1:3210' },
    },
    build: {
      rollupOptions: {
        // mini：呼出式 mini 面板（Electron 专属；web 模式没有全局快捷键与独立小窗）
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          mini: resolve(__dirname, 'src/renderer/mini.html'),
        },
      },
    },
  },
})
