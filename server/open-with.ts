import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type OpenKind = 'editor' | 'terminal'

export interface OpenTarget {
  id: string
  label: string
  kind: OpenKind
  app: string
}

export function appDirs(home: string = homedir()): string[] {
  return [
    '/Applications',
    join(home, 'Applications'),
    '/System/Applications',
    '/System/Applications/Utilities',
    '/Applications/Utilities',
  ]
}

const CANDIDATES: Array<{ id: string; label: string; kind: OpenKind; apps: string[] }> = [
  { id: 'idea', label: 'IntelliJ IDEA', kind: 'editor', apps: ['IntelliJ IDEA.app'] },
  { id: 'vscode', label: 'Visual Studio Code', kind: 'editor', apps: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'] },
  { id: 'cursor', label: 'Cursor', kind: 'editor', apps: ['Cursor.app'] },
  { id: 'zed', label: 'Zed', kind: 'editor', apps: ['Zed.app'] },
  { id: 'sublime', label: 'Sublime Text', kind: 'editor', apps: ['Sublime Text.app'] },
  { id: 'goland', label: 'GoLand', kind: 'editor', apps: ['GoLand.app'] },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor', apps: ['PyCharm.app', 'PyCharm CE.app'] },
  { id: 'webstorm', label: 'WebStorm', kind: 'editor', apps: ['WebStorm.app'] },
  { id: 'rustrover', label: 'RustRover', kind: 'editor', apps: ['RustRover.app'] },
  { id: 'xcode', label: 'Xcode', kind: 'editor', apps: ['Xcode.app'] },
  { id: 'wezterm', label: 'WezTerm', kind: 'terminal', apps: ['WezTerm.app'] },
  { id: 'iterm', label: 'iTerm', kind: 'terminal', apps: ['iTerm.app', 'iTerm2.app'] },
  { id: 'warp', label: 'Warp', kind: 'terminal', apps: ['Warp.app'] },
  { id: 'ghostty', label: 'Ghostty', kind: 'terminal', apps: ['Ghostty.app'] },
  { id: 'terminal', label: '终端', kind: 'terminal', apps: ['Terminal.app'] },
]

export function appIconFile(appPath: string): string {
  try {
    const name = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(appPath, 'Contents/Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    if (!name) return ''
    const file = join(appPath, 'Contents/Resources', name.endsWith('.icns') ? name : `${name}.icns`)
    return existsSync(file) ? file : ''
  } catch {
    return ''
  }
}

const iconPngCache = new Map<string, string>()

// .icns 转 PNG 落临时目录，按 app + 尺寸缓存；读不出图标返回空串
export function appIconPng(appPath: string, size = 32): string {
  const key = `${appPath}:${size}`
  const hit = iconPngCache.get(key)
  if (hit && existsSync(hit)) return hit
  const icns = appIconFile(appPath)
  if (!icns) return ''
  try {
    const dir = join(tmpdir(), 'easy-flow-app-icons')
    mkdirSync(dir, { recursive: true })
    const hash = createHash('sha1').update(appPath).digest('hex').slice(0, 10)
    const png = join(dir, `${hash}-${size}.png`)
    execFileSync('sips', ['-s', 'format', 'png', '-Z', String(size), icns, '--out', png])
    iconPngCache.set(key, png)
    return png
  } catch {
    return ''
  }
}

export function appIconDataUrl(appPath: string, size = 32): string {
  const png = appIconPng(appPath, size)
  return png ? `data:image/png;base64,${readFileSync(png).toString('base64')}` : ''
}

export function scanOpenTargets(dirs: string[] = appDirs()): OpenTarget[] {
  return CANDIDATES.flatMap((candidate) => {
    for (const dir of dirs) {
      for (const name of candidate.apps) {
        const app = join(dir, name)
        if (existsSync(app)) return [{ id: candidate.id, label: candidate.label, kind: candidate.kind, app }]
      }
    }
    return []
  })
}

// 空 id = 访达；配的 app 被卸了也返回 undefined，调用方退回访达
export function findOpenTarget(id: string, dirs: string[] = appDirs()): OpenTarget | undefined {
  if (!id) return undefined
  return scanOpenTargets(dirs).find((t) => t.id === id)
}
