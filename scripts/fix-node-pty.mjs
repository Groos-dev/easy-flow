#!/usr/bin/env node
/**
 * pnpm 从 tarball 解包时会丢失 node-pty 的 spawn-helper 可执行位，
 * 导致 pty.spawn 报 "posix_spawnp failed."。这里补回来。
 * 由 package.json 的 postinstall 调用，保证重装依赖后依然可用。
 */
import { readdirSync, statSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function findSpawnHelpers(dir, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) findSpawnHelpers(p, found)
    else if (entry === 'spawn-helper') found.push(p)
  }
  return found
}

const helpers = findSpawnHelpers(join(process.cwd(), 'node_modules'))
let fixed = 0

for (const file of helpers) {
  const mode = statSync(file).mode
  if ((mode & 0o111) === 0o111) continue
  chmodSync(file, mode | 0o755)
  fixed++
  console.log(`[easy-flow] 补齐可执行位: ${file.replace(process.cwd() + '/', '')}`)
}

if (!helpers.length) {
  console.log('[easy-flow] 未找到 node-pty spawn-helper（可能尚未安装）')
} else {
  console.log(`[easy-flow] node-pty spawn-helper 检查完成，修复 ${fixed} 个`)
}
