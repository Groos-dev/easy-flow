// 看板键盘焦点的位置计算
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  movePos,
  posOf,
  slugAt,
  type BoardColumn,
} from '../src/renderer/src/lib/board-focus.ts'

const COLUMNS: BoardColumn[] = [
  { status: '澄清', slugs: ['a', 'b'] },
  { status: '执行中', slugs: [] },
  { status: 'Review', slugs: ['c'] },
  { status: '已完成', slugs: ['d', 'e'] },
]

describe('看板焦点', () => {
  test('没有焦点时落到第一列第一张', () => {
    assert.deepEqual(movePos(COLUMNS, null, 'down'), { status: '澄清', index: 0 })
    assert.deepEqual(movePos(COLUMNS, null, 'right'), { status: '澄清', index: 0 })
  })

  test('上下移动到头就留在原地', () => {
    assert.deepEqual(movePos(COLUMNS, { status: '澄清', index: 0 }, 'down'), {
      status: '澄清',
      index: 1,
    })
    assert.deepEqual(movePos(COLUMNS, { status: '澄清', index: 1 }, 'down'), {
      status: '澄清',
      index: 1,
    })
    assert.deepEqual(movePos(COLUMNS, { status: '澄清', index: 0 }, 'up'), {
      status: '澄清',
      index: 0,
    })
  })

  test('左右跳过空列', () => {
    assert.deepEqual(movePos(COLUMNS, { status: '澄清', index: 0 }, 'right'), {
      status: 'Review',
      index: 0,
    })
    assert.deepEqual(movePos(COLUMNS, { status: 'Review', index: 0 }, 'left'), {
      status: '澄清',
      index: 0,
    })
  })

  test('目标列更短时行号夹到最后一张', () => {
    assert.deepEqual(movePos(COLUMNS, { status: '已完成', index: 1 }, 'left'), {
      status: 'Review',
      index: 0,
    })
  })

  test('到头没有可去的列就留在原地', () => {
    assert.deepEqual(movePos(COLUMNS, { status: '已完成', index: 0 }, 'right'), {
      status: '已完成',
      index: 0,
    })
    assert.deepEqual(movePos(COLUMNS, { status: '澄清', index: 0 }, 'left'), {
      status: '澄清',
      index: 0,
    })
  })

  test('全空时没有焦点', () => {
    const empty: BoardColumn[] = [
      { status: '澄清', slugs: [] },
      { status: '执行中', slugs: [] },
    ]
    assert.equal(movePos(empty, null, 'down'), null)
  })

  test('按 slug 找位置，找不到返回 null', () => {
    assert.deepEqual(posOf(COLUMNS, 'c'), { status: 'Review', index: 0 })
    assert.equal(posOf(COLUMNS, 'nope'), null)
    assert.equal(posOf(COLUMNS, ''), null)
  })

  test('位置换回 slug', () => {
    assert.equal(slugAt(COLUMNS, { status: '已完成', index: 1 }), 'e')
    assert.equal(slugAt(COLUMNS, { status: '已完成', index: 9 }), '')
    assert.equal(slugAt(COLUMNS, null), '')
  })
})
