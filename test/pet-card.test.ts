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
import type { Requirement, Session, SessionAction } from '../src/renderer/src/lib/types.ts'

function sess(
  agent: string,
  state: Session['status']['state'],
  link = '',
  observedAt = 0,
  title = '',
  action: SessionAction | null = null,
  needsAction = '',
): Session {
  return {
    requirementId: 'req-x',
    agent,
    session: `${agent}-${state}-${title}`,
    title,
    cwd: '',
    link,
    created: '',
    updated: '',
    status: { state, needsAction, observedAt, detail: '' },
    action,
  }
}

const act = (text: string): SessionAction => ({ text, calledAt: 1 })

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
  sess('claude', 'blocked'),
  sess('codex', 'working'),
  sess('claude', 'done'),
  sess('codex', 'failed'),
  sess('claude', 'working'),
]

const petCount = (html: string) => html.match(/class="pet /g)?.length ?? 0
const focusCount = (html: string) => html.match(/ focus"/g)?.length ?? 0
const eventCount = (html: string) => html.match(/class="pet[^"]*?\bevent\b/g)?.length ?? 0
const moreCount = (html: string) => html.match(/class="pet-more[^"]*"[^>]*>\+(\d+)</)?.[1] ?? ''

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('PetRow 渲染', () => {
  test('1/2/3 个会话出等量 pet、无 +N；4 个出 3 只 + 1', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const html = render(createElement(PetRow, { sessions: pool.slice(0, n) }))
      assert.equal(petCount(html), Math.min(n, 3), `${n} 个会话`)
      assert.equal(moreCount(html), n > 3 ? String(n - 3) : '', `${n} 个会话的 +N`)
    }
  })

  test('同一时刻最多一只带 .focus', () => {
    assert.equal(focusCount(render(createElement(PetRow, { sessions: pool }))), 1)
  })

  test('都只有正在跑时没有 .focus', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'working'), sess('codex', 'working')] }))
    assert.equal(focusCount(html), 0)
  })

  test('读得到的会话都挂 pet，读不到的才不渲染', () => {
    assert.equal(render(createElement(PetRow, { sessions: [] })), '')
    assert.equal(render(createElement(PetRow, { sessions: [sess('cursor', 'unknown')] })), '')
    assert.equal(petCount(render(createElement(PetRow, { sessions: [sess('claude', 'done')] }))), 1)
  })

  test('姿势就是状态：跑完待看 / 静止各画各的', () => {    const done = render(createElement(PetRow, { sessions: [sess('claude', 'done')] }))
    assert.match(done, /src="pets\/clawd-happy.svg"/)
    assert.match(done, /aria-label="Claude Code · 跑完待看"/)
    const idle = render(createElement(PetRow, { sessions: [sess('claude', 'idle')] }))
    assert.match(idle, /src="pets\/clawd-idle-follow.svg"/)
    assert.match(idle, /aria-label="Claude Code · 静止"/)
  })

  test('静止越久越困：静 1 分钟打哈欠、静 1 小时睡着', () => {
    const now = Date.now()
    const art = (idleMs: number) =>
      render(createElement(PetRow, { sessions: [sess('claude', 'idle', '', now - idleMs)] }))
    assert.match(art(0), /src="pets\/clawd-idle-follow\.svg"/)
    assert.match(art(60_000), /src="pets\/clawd-idle-yawn\.svg"/)
    assert.match(art(20 * 60_000), /src="pets\/clawd-idle-doze\.svg"/)
    assert.match(art(60 * 60_000), /src="pets\/clawd-sleeping\.svg"/)
  })

  test('事件边框跟状态走：事件型三档带 event，静止不带', () => {    const done = render(createElement(PetRow, { sessions: [sess('claude', 'done')] }))
    assert.match(done, /class="pet s-done event focus"/)
    assert.equal(eventCount(done), 1)
    assert.equal(eventCount(render(createElement(PetRow, { sessions: [sess('claude', 'idle')] }))), 0)
  })

  test('Claude 走 <img> 加载 clawd 素材，不再内联手绘 svg', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'blocked')] }))
    assert.match(html, /<img[^>]+src="pets\/clawd-notification\.svg"/)
    assert.doesNotMatch(html, /<svg/)
  })

  test('Codex 走内联 <svg>（脚本驱动，<img> 会禁脚本、<object> 的文档画布又不透明）', () => {
    const html = render(createElement(PetRow, { sessions: [sess('codex', 'blocked')] }))
    // 素材由挂载时的 effect 插进去（那半截脚本得等元素进文档才跑），静态渲染只剩这个挂载点
    assert.match(html, /class="pet-art"/)
    assert.doesNotMatch(html, /<img/)
    assert.doesNotMatch(html, /<object/)
  })

  test('折叠卡换 mini 素材', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'done')], compact: true }))
    assert.match(html, /src="pets\/clawd-mini-happy\.svg"/)
  })

  test('compact 变体整排带 compact 类（折叠卡用的小号）', () => {
    const html = render(createElement(PetRow, { sessions: pool, compact: true }))
    assert.match(html, /class="pets compact"/)
    assert.equal(html.match(/class="pet compact /g)?.length ?? 0, 3)
    assert.match(html, /class="pet-more compact"/)
  })
})

describe('PetRow 的气泡', () => {
  const bubbleOf = (html: string) => html.match(/<div class="(bubble[^"]*)" title="([^"]*)"/) ?? []

  test('干活且有实时动作：气泡报动作，位置在 pet 头顶那一格', () => {
    const html = render(
      createElement(PetRow, { sessions: [sess('claude', 'working', '', 0, '收口 hook 管道', act('改 hook.ts'))] }),
    )
    assert.deepEqual(bubbleOf(html).slice(1), ['bubble', '改 hook.ts'])
    assert.match(html, /<div class="slot"><div class="bubble"/)
    assert.match(html, /<span class="bubble-text">改 hook\.ts<\/span>/)
  })

  test('没有实时动作、或不在干活：气泡报 title', () => {
    const idle = render(createElement(PetRow, { sessions: [sess('claude', 'idle', '', 0, '补单测')] }))
    assert.deepEqual(bubbleOf(idle).slice(1), ['bubble t-title', '补单测'])
    const blocked = render(createElement(PetRow, { sessions: [sess('claude', 'blocked', '', 0, '等你确认')] }))
    assert.deepEqual(bubbleOf(blocked).slice(1), ['bubble t-blocked', '等你确认'])
  })

  test('卡住那句原文进气泡：压过 title 与动作', () => {
    const html = render(
      createElement(PetRow, {
        sessions: [sess('claude', 'blocked', '', 0, '1N-WS 出票重试', act('改 hook.ts'), '要不要把重试次数提到 3 次？')],
      }),
    )
    assert.deepEqual(bubbleOf(html).slice(1), ['bubble t-blocked', '要不要把重试次数提到 3 次？'])
  })

  test('调子跟状态走：跑完绿边、失败红字、干活没动作退回暗调', () => {
    const tone = (s: Session) => bubbleOf(render(createElement(PetRow, { sessions: [s] })))[1]
    assert.equal(tone(sess('claude', 'done', '', 0, '跑完了')), 'bubble t-done')
    assert.equal(tone(sess('claude', 'failed', '', 0, '挂了')), 'bubble t-failed')
    assert.equal(tone(sess('claude', 'working', '', 0, '没动作')), 'bubble t-title')
  })

  test('title 与动作都空就不画气泡', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'idle')] }))
    assert.doesNotMatch(html, /class="bubble/)
    assert.equal(petCount(html), 1)
  })

  test('读不到状态的会话不画 pet，也就不留空气泡', () => {
    const html = render(createElement(PetRow, { sessions: [sess('cursor', 'unknown', '', 0, '读不到的')] }))
    assert.equal(html, '')
  })

  test('收起的里头有卡住 / 失败的，+N 那格带 attention', () => {
    const urgent: Session[] = [
      sess('claude', 'blocked', '', 0, '等你确认'),
      sess('codex', 'failed', '', 0, '挂了'),
      sess('claude', 'blocked', '', 0, '另一条等你'),
      sess('codex', 'failed', '', 0, '又挂了'),
      sess('claude', 'failed', '', 0, '还挂了'),
    ]
    const html = render(createElement(PetRow, { sessions: urgent }))
    assert.match(html, /class="pet-more attention" title="还有 2 个会话未展示，其中 2 个在等你处理"/)
    const calm = render(createElement(PetRow, { sessions: pool }))
    assert.match(calm, /class="pet-more" title="还有 2 个会话未展示"/)
  })

  test('折叠卡的小号 pet 不挂气泡——挂了就把一行窄条撑成三层高', () => {
    const html = render(createElement(PetRow, { sessions: [sess('claude', 'working', '', 0, '收口', act('改 hook.ts'))], compact: true }))
    assert.doesNotMatch(html, /class="bubble/)
    assert.equal(petCount(html), 1)
  })
})

describe('Card 挂 pet', () => {
  test('卡片不再单独高亮：要人回答的那句话只从气泡出', () => {
    const html = render(
      createElement(Card, {
        req: req(),
        sessions: [sess('claude', 'blocked', '', 0, '等你确认', null, '要不要把重试次数提到 3 次？')],
      }),
    )
    assert.doesNotMatch(html, /card-need/)
    assert.doesNotMatch(html, /needs-you/)
    assert.match(html, /class="bubble t-blocked" title="要不要把重试次数提到 3 次？"/)
  })

  test('普通卡挂完整尺寸的 pet', () => {
    const html = render(createElement(Card, { req: req(), sessions: [sess('claude', 'blocked')] }))
    assert.match(html, /class="pets"/)
    assert.doesNotMatch(html, /class="pets compact"/)
  })

  test('折叠的父需求卡仍挂会话入口，收成小号', () => {
    const html = render(
      createElement(Card, { req: req(), sessions: [sess('claude', 'blocked')], childStat: { total: 1, done: 0 } }),
    )
    assert.match(html, /class="card[^"]*folded/)
    assert.match(html, /class="pets compact"/)
  })

  test('折叠卡的小号 pet 也长期存在——点过的会话照样能点回去', () => {
    const html = render(
      createElement(Card, { req: req(), sessions: [sess('claude', 'idle')], childStat: { total: 1, done: 0 } }),
    )
    assert.match(html, /class="pet compact s-idle"/)
    assert.equal(eventCount(html), 0)
  })

  test('拖拽浮层不挂 pet', () => {
    const html = render(createElement(Card, { req: req(), sessions: [sess('claude', 'blocked')], overlay: true }))
    assert.doesNotMatch(html, /class="pets/)
  })
})
