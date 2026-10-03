/**
 * fs 的小工具：读不到就当空、当没有。
 *
 * 「文件不存在」与「读失败」在这里一视同仁，是刻意的取舍而非疏忽：
 * 这条路上多数调用是扫描（数据目录可能被搬走、被删、权限不对），
 * 逐个区分会让每个调用点都得写一套错误分支。
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs'

/** 读不到的目录当空目录 */
export function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 路径不存在（或 lstat 失败）当没有这个路径 */
export function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** 读不到的文件当没有内容 */
export function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
