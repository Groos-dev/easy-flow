// Antigravity App 2.36 stores local projects in ~/.gemini/config/projects.
// A native draft accepts a project ID. Map only a sole, exact folder so a
// sibling checkout or a project with additional roots cannot be selected.
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { t as tr } from '../src/shared/i18n.ts'
import { createLogger } from './log.ts'

interface Project {
  id?: string
  isWorkspaceOnly?: boolean
  projectResources?: { resources?: { folderUri?: string; gitFolder?: { folderUri?: string } }[] }
}

async function matchingProject(file: string, directory: string): Promise<string | undefined> {
  let project: Project
  try {
    project = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const roots = project?.projectResources?.resources
  if (project?.isWorkspaceOnly || !project?.id || basename(file) !== project.id + '.json' || !Array.isArray(roots) || roots.length !== 1) return
  const uri = roots[0]?.folderUri ?? roots[0]?.gitFolder?.folderUri
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return
  try {
    if (await realpath(fileURLToPath(uri)) === directory) return project.id
  } catch { /* Stale or non-local folder. */ }
}

// RFC 9562 UUIDv5 with the URL namespace and the canonical folder URI.
function projectId(uri: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')
  const hash = createHash('sha1').update(namespace).update(uri).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex', 0, 16)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export async function ensureAntigravityProject(folder: string, projects: string): Promise<string> {
  if (!isAbsolute(folder) || !(await stat(folder)).isDirectory()) throw new Error(tr('Invalid workspace folder: {0}', [folder]))
  const directory = await realpath(folder)
  const uri = pathToFileURL(directory).href
  const id = projectId(uri)
  await mkdir(projects, { recursive: true, mode: 0o700 })
  const matches: string[] = []
  for (const file of await readdir(projects, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue
    const match = await matchingProject(join(projects, file.name), directory)
    if (match === id) return id
    if (match) matches.push(match)
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(tr('Multiple Antigravity projects use {0}. Select the intended project in Antigravity.', [directory]))

  const project = { id, name: basename(directory) || directory, projectResources: { resources: [{ folderUri: uri }] } }
  const target = join(projects, id + '.json')
  const temporary = join(projects, '.' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(project, null, 2) + '\n')
    await handle.close()
    // Publish a complete manifest without replacing an existing project or its settings.
    try {
      await link(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await matchingProject(target, directory) !== id) throw new Error(tr('Antigravity project no longer matches {0}.', [directory]), { cause: error })
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') createLogger('antigravity').warn(`Could not remove temporary project file: ${error.message}`)
  })
  return id
}
