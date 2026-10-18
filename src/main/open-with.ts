import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 「用什么打开」的候选，只认白名单：名字对得上才上桌——猜错的表现是「点了没反应」，
 * 比少一个选项更难查。这里不 import electron，扫描与找图标能单独测。
 */
export interface OpenTarget {
  id: string
  label: string
  /** .app 路径：主进程用它取图标、拼 `open -a` */
  app: string
}

/** app 可能落的几个地方（macOS 自带的两处在 System 下） */
export function appDirs(home: string = homedir()): string[] {
  return [
    '/Applications',
    join(home, 'Applications'),
    '/System/Applications',
    '/System/Applications/Utilities',
    '/Applications/Utilities',
  ]
}

/** 顺序就是菜单顺序：编辑器在前，终端在后。同一个 id 取先扫到的那个目录 */
const CANDIDATES: Array<{ id: string; label: string; apps: string[] }> = [
  { id: 'idea', label: 'IntelliJ IDEA', apps: ['IntelliJ IDEA.app'] },
  { id: 'vscode', label: 'Visual Studio Code', apps: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'] },
  { id: 'cursor', label: 'Cursor', apps: ['Cursor.app'] },
  { id: 'zed', label: 'Zed', apps: ['Zed.app'] },
  { id: 'sublime', label: 'Sublime Text', apps: ['Sublime Text.app'] },
  { id: 'goland', label: 'GoLand', apps: ['GoLand.app'] },
  { id: 'pycharm', label: 'PyCharm', apps: ['PyCharm.app', 'PyCharm CE.app'] },
  { id: 'webstorm', label: 'WebStorm', apps: ['WebStorm.app'] },
  { id: 'rustrover', label: 'RustRover', apps: ['RustRover.app'] },
  { id: 'xcode', label: 'Xcode', apps: ['Xcode.app'] },
  { id: 'wezterm', label: 'WezTerm', apps: ['WezTerm.app'] },
  { id: 'iterm', label: 'iTerm', apps: ['iTerm.app', 'iTerm2.app'] },
  { id: 'warp', label: 'Warp', apps: ['Warp.app'] },
  { id: 'ghostty', label: 'Ghostty', apps: ['Ghostty.app'] },
  { id: 'terminal', label: '终端', apps: ['Terminal.app'] },
]

/**
 * app 自己的图标文件（.icns）在哪。Info.plist 是二进制的，用 plutil 取，别自己解；
 * 取不到就当没有图标——读不出图标不该把菜单整个搞挂。
 */
export function appIconFile(appPath: string): string {
  try {
    const name = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(appPath, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim()
    if (!name) return ''
    const file = join(appPath, 'Contents/Resources', name.endsWith('.icns') ? name : `${name}.icns`)
    return existsSync(file) ? file : ''
  } catch {
    return ''
  }
}

/** 扫出本机真装了的打开方式；只扫一层，这些目录下不会再套一层 app */
export function scanOpenTargets(dirs: string[] = appDirs()): OpenTarget[] {
  return CANDIDATES.flatMap((candidate) => {
    for (const dir of dirs) {
      for (const name of candidate.apps) {
        const app = join(dir, name)
        if (existsSync(app)) return [{ id: candidate.id, label: candidate.label, app }]
      }
    }
    return []
  })
}
