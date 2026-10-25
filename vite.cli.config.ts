import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

// 命令行有顶层 await，打成 ESM。安装包用应用自己的可执行文件加 ELECTRON_RUN_AS_NODE 跑它。
export default defineConfig({
  build: {
    outDir: 'out/cli',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    lib: {
      entry: 'server/cli.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external,
      output: {
        banner: `process.env.EASY_FLOW_VERSION ??= ${JSON.stringify(version)};\n`,
      },
    },
  },
})
