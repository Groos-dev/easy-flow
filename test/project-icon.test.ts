/**
 * 项目图标的取值回归。
 *
 * 首字符与色相都是纯函数（渲染层），所以直接断言取值，不必起服务、不碰 DOM。
 *
 * 运行：pnpm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { projectInitial, projectHue, projectColor } from '../src/renderer/src/lib/projectIcon.ts'

describe('项目图标的首字符', () => {
  test('中文取第一个字，英文取首字母并大写', () => {
    assert.equal(projectInitial('onex'), 'O')
    assert.equal(projectInitial('机票辅营'), '机')
    assert.equal(projectInitial('devctl 开发流程平台'), 'D')
  })

  test('跳过空格、连字符与下划线', () => {
    assert.equal(projectInitial('  easy-flow 自身'), 'E')
    assert.equal(projectInitial('_demo'), 'D')
  })

  test('名字整个是标点时回落问号，不留一个空图标', () => {
    assert.equal(projectInitial('---'), '?')
    assert.equal(projectInitial(''), '?')
  })
})

describe('项目图标的颜色', () => {
  test('同一个 slug 每次都是同一个色相', () => {
    assert.equal(projectHue('onex'), projectHue('onex'))
    assert.equal(projectColor('onex'), projectColor('onex'))
  })

  test('色相落在 0-359', () => {
    for (const slug of ['onex', 'easy-flow', 'personal', 'search-seat-verify', 'a', '']) {
      const h = projectHue(slug)
      assert.ok(h >= 0 && h < 360, `${slug} → ${h}`)
    }
  })

  test('底色固定饱和与亮度，暗色主题下白字压得住', () => {
    assert.match(projectColor('onex'), /^hsl\(\d+, 42%, 38%\)$/)
  })
})
