#!/usr/bin/env node
/**
 * One-off: move req id from requirement AGENTS.md → requirement.md; run sqlite link_items migration.
 * Usage: node scripts/migrate-unified-links-data.mjs [dataDir]
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applySchema } from '../server/schema.ts'
import { setRequirementId } from '../server/convention.ts'
import { listProjectDirs, listRequirementDirs, parseFrontmatter } from '../server/markdown.ts'

const dataDir = process.argv[2] || join(homedir(), 'requirements')
const dbFile = join(dataDir, 'easy-flow.db')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

if (!existsSync(dbFile)) {
  console.error(`No database: ${dbFile}`)
  process.exit(1)
}

const backup = `${dbFile}.bak-${stamp}`
copyFileSync(dbFile, backup)
console.log(`Backed up DB → ${backup}`)

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 30000')
const colsBefore = db.prepare('PRAGMA table_info(requirement)').all().map((c) => c.name)
applySchema(db)
const colsAfter = db.prepare('PRAGMA table_info(requirement)').all().map((c) => c.name)
const dropped = ['feishu_task_links', 'code_links', 'ext_links'].filter((c) => colsBefore.includes(c) && !colsAfter.includes(c))
console.log(`SQLite schema: dropped legacy link columns: ${dropped.join(', ') || '(none)'}`)
db.close()

let migrated = 0
let removedAgents = 0
let already = 0
let noId = 0

for (const project of listProjectDirs(dataDir)) {
  for (const { dir, slug } of listRequirementDirs(project.root)) {
    const reqPath = join(dir, 'requirement.md')
    const desc = parseFrontmatter(readFileSync(reqPath, 'utf8'))
    if (desc.data.id) {
      already++
      const agentsPath = join(dir, 'AGENTS.md')
      if (existsSync(agentsPath)) {
        const agents = parseFrontmatter(readFileSync(agentsPath, 'utf8')).data
        if (agents.id === desc.data.id || String(agents.id || '').startsWith('req-')) {
          unlinkSync(agentsPath)
          removedAgents++
          console.log(`removed stale AGENTS.md: ${project.slug}/${slug}`)
        }
      }
      continue
    }
    const agentsPath = join(dir, 'AGENTS.md')
    if (!existsSync(agentsPath)) {
      noId++
      continue
    }
    const agents = parseFrontmatter(readFileSync(agentsPath, 'utf8')).data
    const id = String(agents.id || '').trim()
    if (!id.startsWith('req-')) {
      noId++
      console.warn(`skip (no req id): ${project.slug}/${slug}`)
      continue
    }
    setRequirementId(dir, id)
    migrated++
    unlinkSync(agentsPath)
    removedAgents++
    console.log(`migrated ${id}: ${project.slug}/${slug}`)
  }
}

console.log(
  `\nDone. req id → requirement.md: ${migrated}; already had id: ${already}; removed AGENTS.md: ${removedAgents}; no id source: ${noId}`,
)
