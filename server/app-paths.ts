import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SKILL_MARKER = join('skill', 'easy-flow', 'SKILL.md')

/**
 * 安装包里拷到归档外的真实文件目录（Contents/Resources）。
 * 开发态这里没有技能文件，返回 null，调用方继续用仓库相对路径。
 * 先看环境变量，再看可执行文件旁的 Resources：开发时那个目录是 Electron 自带的，里面没有技能。
 */
export function packagedResources(
  env: string | undefined = process.env.EASY_FLOW_RESOURCES,
  execPath: string = process.execPath,
): string | null {
  const besideBinary = join(dirname(execPath), '..', 'Resources')
  for (const dir of [env, besideBinary]) {
    if (dir && existsSync(join(dir, SKILL_MARKER))) return dir
  }
  return null
}

// 通知和窗口用的 png。已打包读 Resources；开发态从 out/main 往上两级。
export function iconFile(packaged: boolean, resourcesPath: string, moduleDir: string): string {
  return packaged ? join(resourcesPath, 'icon.png') : join(moduleDir, '../../resources/icon.png')
}

// 与 electron-builder 的 productName、executableName 一致。shim 靠这个名字找可执行文件。
export const APP_BINARY = 'easy-flow'
