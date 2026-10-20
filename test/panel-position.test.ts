/** mini 面板落点与位置落盘的回归 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  placePanel,
  readPanelPosition,
  writePanelPosition,
} from '../src/main/panel-position.ts'

const SIZE = { width: 420, height: 480 }
/** 主屏 + 右侧第二块屏 */
const MAIN = { x: 0, y: 0, width: 1512, height: 950 }
const SIDE = { x: 1512, y: 0, width: 1440, height: 900 }
const CURSOR_ON_MAIN = { x: 700, y: 400 }

describe('mini 面板落点', () => {
  test('存过的位置还在这块屏上：原样回去', () => {
    assert.deepEqual(placePanel({ x: 100, y: 200 }, SIZE, [MAIN], CURSOR_ON_MAIN), { x: 100, y: 200 })
  })

  test('贴着右下角的旧位置出界：夹回工作区里', () => {
    assert.deepEqual(placePanel({ x: 1400, y: 800 }, SIZE, [MAIN], CURSOR_ON_MAIN), {
      x: MAIN.width - SIZE.width,
      y: MAIN.height - SIZE.height,
    })
  })

  test('那块屏没了：退回鼠标所在屏、顶部居中 20%', () => {
    assert.deepEqual(placePanel({ x: 2000, y: 100 }, SIZE, [MAIN], CURSOR_ON_MAIN), {
      x: Math.round((MAIN.width - SIZE.width) / 2),
      y: Math.round(MAIN.height * 0.2),
    })
  })

  test('鼠标在第二块屏：默认位置跟过去', () => {
    const at = placePanel(null, SIZE, [MAIN, SIDE], { x: 2000, y: 300 })
    assert.equal(at.x, SIDE.x + Math.round((SIDE.width - SIZE.width) / 2))
    assert.equal(at.y, Math.round(SIDE.height * 0.2))
  })

  test('工作区比面板还窄：贴着左上角放，不给出负坐标', () => {
    const tiny = { x: 0, y: 0, width: 300, height: 300 }
    assert.deepEqual(placePanel({ x: 10, y: 10 }, SIZE, [tiny], CURSOR_ON_MAIN), { x: 0, y: 0 })
  })
})

describe('mini 面板位置落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-panel-'))
  const file = join(dir, 'panel-position.json')
  after(() => rmSync(dir, { recursive: true, force: true }))

  test('写进去再读回来是同一个点', () => {
    writePanelPosition(file, { x: 100, y: 200 })
    assert.deepEqual(readPanelPosition(file), { x: 100, y: 200 })
  })

  test('文件不在、内容坏了、形状不对：都当作没记住', () => {
    assert.equal(readPanelPosition(join(dir, 'nope.json')), null)
    writeFileSync(file, '{"x":1}')
    assert.equal(readPanelPosition(file), null)
    writeFileSync(file, '[1294,344]')
    assert.equal(readPanelPosition(file), null)
  })
})
