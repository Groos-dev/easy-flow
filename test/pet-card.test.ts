/**
 * 卡上 pet 的渲染回归。
 *
 * pets.ts 的纯函数（状态映射、一行怎么排）在 core.test.ts 里测；这里只管「真渲染出来的
 * markup 对不对」——4 + N、唯一 .focus、折叠卡也挂入口。用 react-dom/server 直接渲染组件，
 * 不需要 DOM 环境。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Card from '../src/renderer/src/components/Card.tsx'
import { PetRow } from '../src/renderer/src/components/Pet.tsx'
import type { Requirement, Session } from '../src/renderer/src/lib/types.ts'

function sess(agent: string, state: Session['status']['state'], fresh: boolean, link = ''): Session {
  return {
    requirementId: 'req-x',
    agent,
    session: `${agent}-${state}-${fresh}`,
    title: '',
    cwd: '',
    link,
    created: '',
    updated: '',
    status: { state, activity: '', fresh, needsAction: '', at: '', detail: '' },
  }
}

function req(patch: Partial<Requirement> = {}): Requirement {
  return {
    slug: 'a',
    project: 'p',
    id: 'req-1',
    parentId: '',
    title: '标题',
    status: '执行中',
    priority: 'p2',
    summary: '',
    repos: [],
    links: '',
    feishuTaskLinks: [],
    codeLinks: [],
    extLinks: [],
    docs: [],
    path: '',
    mtime: 0,
    updated: '',
    ...patch,
  }
}

/** 五个都挂得上角标的会话：卡住 + 跑完没看 + 失败 + 两条正在跑 */
const pool: Session[] = [
  sess('claude', 'blocked', true),
  sess('codex', 'running', false),
  sess('claude', 'done', true),
  sess('codex', 'failed', true),
  sess('claude', 'running', false),
]

const petCount = (html: string) => html.match(/class="pet /g)?.length ?? 0
const focusCount = (html: string) => html.match(/ focus"/g)?.length ?? 0
const eventCount = (html: string) => html.match(/class="pet[^"]*?\bevent\b/g)?.length ?? 0
const moreCount = (html: string) => html.match(/class="pet-more[^"]*"[^>]*>\+(\d+)</)?.[1] ?? ''

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('PetRow 渲染', () => {
  test('1/2/3/4 个会话出等量 pet、无 +N；5 个出 4 只 + 1', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const html = render(createElement(PetRow, { sessions: pool.slice(0, n) }))
      assert.equal(petCount(html), Math.min(n, 4), `${n} 个会话`)
      assert.equal(moreCount(html), n > 4 ? String(n - 4) : '', `${n} 个会话的 +N`)
    }
  })

  test('同一时刻最多一只带 .focus', () => {
    assert.equal(focusCount(render(createElement(PetRow, { sessions: pool }))), 1)
  })

  test('都只有正在跑时没有 .focus', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'running', false), sess('codex', 'running', false)] }))
    assert.equal(focusCount(html), 0)
  })

  test('读得到的会话都挂 pet——读过的事件也留着，读不到的才不渲染', () => {
    assert.equal(render(createElement(PetRow, { sessions: [] })), '')
    assert.equal(render(createElement(PetRow, { sessions: [sess('cursor', 'unknown', true)] })), '')
    const read = render(createElement(PetRow, { sessions: [sess('claude', 'done', false)] }))
    assert.equal(petCount(read), 1)
    assert.match(read, /class="pet s-idle"/)
    assert.equal(eventCount(read), 0)
    assert.equal(focusCount(read), 0)
  })

  test('读过的 done 姿势是静止，但文案仍说清「跑完已看」', () => {
    const read = render(createElement(PetRow, { sessions: [sess('claude', 'done', false)] }))
    assert.match(read, /src="pets\/clawd-idle-follow.svg"/)
    assert.match(read, /aria-label="Claude Code · 跑完已看"/)
    const unread = render(createElement(PetRow, { sessions: [sess('claude', 'done', true)] }))
    assert.match(unread, /src="pets\/clawd-happy.svg"/)
    assert.match(unread, /aria-label="Claude Code · 跑完待看"/)
  })

  test('事件样式只跟 fresh 走：未读带 event，读过的不带', () => {
    const unread = render(createElement(PetRow, { sessions: [sess('claude', 'done', true)] }))
    assert.match(unread, /class="pet s-done event focus"/)
    assert.equal(eventCount(unread), 1)
    const read = render(createElement(PetRow, { sessions: [sess('claude', 'done', false)] }))
    assert.equal(eventCount(read), 0)
  })

  test('Claude 走 <img> 加载 clawd 素材，不再内联手绘 svg', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'blocked', true)] }))
    assert.match(html, /<img[^>]+src="pets\/clawd-notification\.svg"/)
    assert.doesNotMatch(html, /<svg/)
  })

  test('Codex 走内联 <svg>（脚本驱动，<img> 会禁脚本、<object> 的文档画布又不透明）', () => {
    const html = render(createElement(PetRow, { sessions: [sess('codex', 'blocked', true)] }))
    // 素材由挂载时的 effect 插进去（那半截脚本得等元素进文档才跑），静态渲染只剩这个挂载点
    assert.match(html, /class="pet-art"/)
    assert.doesNotMatch(html, /<img/)
    assert.doesNotMatch(html, /<object/)
  })

  test('折叠卡换 mini 素材', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'done', true)], compact: true }))
    assert.match(html, /src="pets\/clawd-mini-happy\.svg"/)
  })

  test('compact 变体整排带 compact 类（折叠卡用的小号）', () => {
    const html = render(createElement(PetRow, { sessions: pool, compact: true }))
    assert.match(html, /class="pets compact"/)
    assert.equal(html.match(/class="pet compact /g)?.length ?? 0, 4)
    assert.match(html, /class="pet-more compact"/)
  })
})

describe('Card 挂 pet', () => {
  test('普通卡挂完整尺寸的 pet', () => {
    const html = render(createElement(Card, { req: req(), sessions: [sess('claude', 'blocked', true)] }))
    assert.match(html, /class="pets"/)
    assert.doesNotMatch(html, /class="pets compact"/)
  })

  test('折叠的父需求卡仍挂会话入口，收成小号', () => {
    const html = render(
      createElement(Card, { req: req(), sessions: [sess('claude', 'blocked', true)], childStat: { total: 1, done: 0 } }),
    )
    assert.match(html, /class="card[^"]*folded/)
    assert.match(html, /class="pets compact"/)
  })

  test('折叠卡的小号 pet 也长期存在——读过的会话照样能点回去', () => {
    const html = render(
      createElement(Card, { req: req(), sessions: [sess('claude', 'done', false)], childStat: { total: 1, done: 0 } }),
    )
    assert.match(html, /class="pet compact s-idle"/)
    assert.equal(eventCount(html), 0)
  })

  test('拖拽浮层不挂 pet', () => {
    const html = render(createElement(Card, { req: req(), sessions: [sess('claude', 'blocked', true)], overlay: true }))
    assert.doesNotMatch(html, /class="pets/)
  })
})
