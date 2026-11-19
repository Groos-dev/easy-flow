// 看板键盘焦点的位置计算
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextCandidateInDirection,
  nextPetStop,
  posOf,
  slugAt,
  type BoardColumn,
  type FocusCandidate,
  type FocusRect,
} from '../src/renderer/src/lib/board-focus.ts'

const COLUMNS: BoardColumn[] = [
  { status: '澄清', slugs: ['a', 'b'] },
  { status: '执行中', slugs: [] },
  { status: 'Review', slugs: ['c'] },
  { status: '已完成', slugs: ['d', 'e'] },
]

describe('看板位置反查', () => {
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

describe('跳到下一只 pet 落点', () => {
  const PETS = new Map([
    ['a', ['s1', 's2']],
    ['c', ['s3']],
    ['e', ['s4', 's5']],
  ])
  const petsOf = (slug: string) => PETS.get(slug) ?? []

  test('没有焦点时落到第一张卡的第一只', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: null, session: '' }), {
      slug: 'a',
      session: 's1',
    })
  })

  test('停在卡上时先落这张卡的第一只', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: '已完成', index: 1 }, session: '' }), {
      slug: 'e',
      session: 's4',
    })
  })

  test('同一张卡里接着走下一只', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: '澄清', index: 0 }, session: 's1' }), {
      slug: 'a',
      session: 's2',
    })
  })

  test('卡里走完再去后面第一张有 pet 的卡', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: '澄清', index: 0 }, session: 's2' }), {
      slug: 'c',
      session: 's3',
    })
  })

  test('当前卡没有 pet 就跳过去', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: '澄清', index: 1 }, session: '' }), {
      slug: 'c',
      session: 's3',
    })
  })

  test('当前那只已不在候选里时落本卡第一只', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: '已完成', index: 1 }, session: 'gone' }), {
      slug: 'e',
      session: 's4',
    })
  })

  test('到末尾绕回开头', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: '已完成', index: 1 }, session: 's5' }), {
      slug: 'a',
      session: 's1',
    })
  })

  test('当前卡已不在版面上时从头找', () => {
    assert.deepEqual(nextPetStop(COLUMNS, petsOf, { pos: { status: 'Review', index: 5 }, session: '' }), {
      slug: 'a',
      session: 's1',
    })
  })

  test('一只都没有时返回 null', () => {
    assert.equal(nextPetStop(COLUMNS, () => [], { pos: null, session: '' }), null)
    assert.equal(nextPetStop([], petsOf, { pos: null, session: '' }), null)
  })
})

describe('按屏幕几何找下一个落点', () => {
  const rect = (left: number, top: number): FocusRect => ({
    left,
    top,
    right: left + 120,
    bottom: top + 60,
  })
  const card = (slug: string, r: FocusRect): FocusCandidate => ({ kind: 'card', slug, rect: r })

  const pinnedA = card('pin-a', rect(0, 0))
  const pinnedB = card('pin-b', rect(200, 0))
  const a1 = card('a1', rect(0, 200))
  const b1 = card('b1', rect(200, 200))
  const c1 = card('c1', rect(400, 200))
  const base = [pinnedA, pinnedB, a1, b1, c1]

  const next = (slug: string, dir: 'up' | 'down' | 'left' | 'right', list = base) => {
    const current = list.find((c) => c.kind === 'card' && c.slug === slug)
    assert.ok(current)
    const hit = nextCandidateInDirection(
      current.rect,
      list.filter((c) => c !== current),
      dir,
    )
    return hit?.kind === 'card' ? hit.slug : null
  }

  test('置顶横排左右走到相邻卡，不往下方列跳', () => {
    assert.equal(next('pin-a', 'right'), 'pin-b')
    assert.equal(next('pin-b', 'left'), 'pin-a')
  })

  test('置顶往下落到正下方最近的列', () => {
    assert.equal(next('pin-a', 'down'), 'a1')
    assert.equal(next('pin-b', 'down'), 'b1')
  })

  test('列内左右按同一行就近走，列顶往上先落到正上方的置顶卡', () => {
    assert.equal(next('a1', 'right'), 'b1')
    assert.equal(next('b1', 'left'), 'a1')
    assert.equal(next('b1', 'right'), 'c1')
    assert.equal(next('a1', 'up'), 'pin-a')
  })

  test('列内往下优先到下方的同列卡', () => {
    const a2 = card('a2', rect(0, 300))
    assert.equal(next('a1', 'down', [...base, a2]), 'a2')
  })

  test('同一排更高的卡不算下方目标', () => {
    const tall = card('tall', { left: 0, top: 0, right: 120, bottom: 200 })
    const short = card('short', { left: 200, top: 0, right: 320, bottom: 80 })
    const below = card('below', { left: 200, top: 300, right: 320, bottom: 360 })
    const down = nextCandidateInDirection(short.rect, [tall, below], 'down')
    assert.equal(down?.kind === 'card' ? down.slug : null, 'below')
    assert.equal(nextCandidateInDirection(tall.rect, [short, below], 'up'), null)
  })

  test('方向上没有卡就返回 null', () => {
    assert.equal(next('c1', 'right'), null)
    assert.equal(next('a1', 'left'), null)
    assert.equal(next('pin-a', 'up'), null)
  })

  test('侧向偏移计入代价：同排更远的卡优先于斜下方的近卡', () => {
    const current = card('x', rect(0, 0))
    const sameRow = card('same', rect(300, 0))
    const diagonal = card('diag', rect(150, 100))
    const hit = nextCandidateInDirection(current.rect, [diagonal, sameRow], 'right')
    assert.equal(hit?.kind === 'card' ? hit.slug : null, 'same')
  })

  test('窄条与需求 slug 同名也按候选身份区分', () => {
    const bar: FocusCandidate = { kind: 'done-bar', rect: rect(300, 0) }
    const sameSlug = card('done-column', rect(500, 0))
    const hit = nextCandidateInDirection(rect(0, 0), [sameSlug, bar], 'right')
    assert.equal(hit?.kind, 'done-bar')
  })
})
