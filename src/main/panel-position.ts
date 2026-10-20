import { readFileSync, writeFileSync } from 'node:fs'

/** mini 面板的落点与位置落盘：不碰 Electron，多屏、换屏这些情况在测试里覆盖 */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** 落盘是 { x, y }——getPosition() 给的是数组，写之前转一次 */
export function readPanelPosition(file: string): Point | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Point> | null
    if (typeof saved?.x === 'number' && typeof saved?.y === 'number') {
      return { x: saved.x, y: saved.y }
    }
  } catch {
    /* 没存过或文件坏了 */
  }
  return null
}

export function writePanelPosition(file: string, pos: Point): void {
  try {
    writeFileSync(file, JSON.stringify({ x: pos.x, y: pos.y }))
  } catch {
    /* 位置记忆不是关键路径 */
  }
}

function inside(p: Point, box: Box): boolean {
  return p.x >= box.x && p.x < box.x + box.width && p.y >= box.y && p.y < box.y + box.height
}

/** 上次的位置还在某块屏上就夹回工作区，否则落鼠标所在屏的默认点 */
export function placePanel(
  saved: Point | null,
  size: { width: number; height: number },
  workAreas: readonly Box[],
  cursor: Point,
): Point {
  const home = saved ? workAreas.find((a) => inside(saved, a)) : undefined
  // 工作区装不下整个面板时不硬夹
  if (saved && home && home.width >= size.width && home.height >= size.height) {
    return {
      x: Math.min(saved.x, home.x + home.width - size.width),
      y: Math.min(saved.y, home.y + home.height - size.height),
    }
  }

  const area = workAreas.find((a) => inside(cursor, a)) ?? workAreas[0]
  if (!area) return saved ?? { x: 0, y: 0 }
  // 工作区比面板还窄时贴左上角
  const slackX = Math.max(0, area.width - size.width)
  const slackY = Math.max(0, area.height - size.height)
  return {
    x: area.x + Math.min(slackX, Math.round(slackX / 2)),
    y: area.y + Math.min(slackY, Math.round(area.height * 0.2)),
  }
}
