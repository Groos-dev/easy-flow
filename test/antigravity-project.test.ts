import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ensureAntigravityProject } from '../server/antigravity-project.ts'

test('Antigravity uses a single exact local root, reuses git folders and handles simultaneous first launches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'easy-flow-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, '中文 & #'), projects = join(root, 'projects')
  await mkdir(folder)
  await mkdir(projects)
  const uri = pathToFileURL(folder).href
  const multi = JSON.stringify({ id: 'multi', projectResources: { resources: [{ folderUri: uri }, { folderUri: pathToFileURL(root).href }] } })
  await writeFile(join(projects, 'multi.json'), multi)
  const alias = join(root, 'alias')
  await symlink(folder, alias)
  const ids = await Promise.all([folder, alias, folder].map(path => ensureAntigravityProject(path, projects)))
  assert.equal(new Set(ids).size, 1)
  assert.notEqual(ids[0], 'multi')
  const created = join(projects, ids[0] + '.json')
  assert.deepEqual(JSON.parse(await readFile(created, 'utf8')).projectResources.resources, [{ folderUri: pathToFileURL(await realpath(folder)).href }])
  assert.equal((await readdir(projects)).length, 2)
  await rm(created)
  const existing = JSON.stringify({ id: 'existing', projectResources: { resources: [{ gitFolder: { folderUri: uri } }] } })
  await writeFile(join(projects, 'existing.json'), existing)
  assert.equal(await ensureAntigravityProject(folder, projects), 'existing')
  assert.equal(await readFile(join(projects, 'existing.json'), 'utf8'), existing)
})
