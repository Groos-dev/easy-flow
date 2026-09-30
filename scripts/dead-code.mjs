#!/usr/bin/env node
/**
 * 死代码检测：找出被 export 但仓库内无人引用的符号。
 *
 * 能覆盖的情况：export function/const/interface/type/class
 * 覆盖不到的：只在本文件内部使用的私有函数、未使用的 import（交给 tsc --noUnusedLocals）
 *
 * 用法：node scripts/dead-code.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['server', 'src', 'test', 'scripts']
const SELF_REF_OK = new Set([
  // 由 Node 直接运行的入口，不需要被 import
  'server/dev.ts',
])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules' || e === 'out' || e === 'dist') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (['.ts', '.tsx', '.mjs'].includes(extname(p))) out.push(p)
  }
  return out
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
const sources = files.map((f) => ({ path: f, rel: relative(ROOT, f), text: readFileSync(f, 'utf8') }))

// 抓 export 符号
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
const exports = []
for (const s of sources) {
  for (const m of s.text.matchAll(EXPORT_RE)) {
    exports.push({ name: m[1], file: s.rel })
  }
}

const dead = []
for (const { name, file } of exports) {
  if (SELF_REF_OK.has(file)) continue
  let uses = 0
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')
  for (const s of sources) {
    // 本文件内也算：export 出去但只在自己文件里用，不算死代码。
    // 把该文件的 export 声明行挖掉，避免把声明本身当使用。
    const body =
      s.rel === file
        ? s.text.replace(EXPORT_RE, (line) => line.replace(name, ''))
        : s.text
    const hits = body.match(re)
    if (hits) uses += hits.length
  }
  if (uses === 0) dead.push({ name, file })
}

if (!dead.length) {
  console.log('✓ 没有发现无引用的导出符号')
  process.exit(0)
}

console.log(`发现 ${dead.length} 个无引用的导出符号：\n`)
const byFile = new Map()
for (const d of dead) {
  if (!byFile.has(d.file)) byFile.set(d.file, [])
  byFile.get(d.file).push(d.name)
}
for (const [file, names] of [...byFile.entries()].sort()) {
  console.log(`  ${file}`)
  for (const n of names.sort()) console.log(`      ${n}`)
}
console.log('\n注意：这些只是「仓库内无引用」。预留接口（如给 MCP 用的）属有意保留，需人工判断。')
process.exit(1)
