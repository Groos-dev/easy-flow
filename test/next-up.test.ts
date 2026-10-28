/**
 * 「下一步该动哪个」的排名回归。
 *
 * 排序规则在 server/next-up.ts，是纯函数，所以这里直接构造需求与会话、断言名次与理由，
 * 不必起服务、不碰真实 agent 落盘文件。最后一条顺带走一遍 HTTP 接口。
 *
 * 运行：pnpm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import {
  rankNextUp,
  DEFAULT_NEXT_UP_CONFIG,
  type NextUpConfig,
  type RankableSession,
} from '../server/next-up.ts'
import { createBoardApp } from '../server/index.ts'
import type { Requirement, Session, SessionAgent } from '../server/db.ts'
import type { SessionStatus, ThreadState } from '../server/session-state.ts'

// 夹具目录按 cwd 派生：多个 worktree 并行跑测试时互不干扰
const TMP = join(tmpdir(), `easy-flow-nextup-test-${basename(process.cwd())}`)

// 固定「现在」：2026-10-14 12:00 本机时间，好把天数算准
const NOW = new Date(2026, 9, 14, 12, 0).getTime()

function req(p: Partial<Requirement> & { slug: string }): Requirement {
  return {
    project: 'demo',
    id: `req-${p.slug}`,
    parentId: '',
    title: p.slug,
    status: '澄清',
    priority: '',
    summary: '',
    repos: [],
    links: '',
    linkItems: [],
    docs: [],
    path: `/tmp/${p.slug}`,
    mtime: 0,
    updated: '',
    ...p,
  }
}

function sess(
  requirementId: string,
  agent: SessionAgent,
  state: ThreadState,
  opts: { link?: string; observedAt?: number; needsAction?: string } = {},
): RankableSession {
  const session: Session = {
    requirementId,
    agent,
    session: `${agent}-1`,
    title: '',
    cwd: '',
    link: opts.link ?? `app://${agent}/1`,
    created: '',
    updated: '',
  }
  const status: SessionStatus = {
    state,
    needsAction: opts.needsAction ?? '',
    observedAt: opts.observedAt ?? 0,
    detail: '',
  }
  return { ...session, status }
}

describe('下一步 · 排名', () => {
  test('agent 卡住 → 第 1 档、现在就得动，理由带 agent 名与要人回答的原文', () => {
    const items = rankNextUp(
      [req({ slug: 'a', status: '执行中' })],
      [sess('req-a', 'claude', 'blocked', { needsAction: '要我把 mock 清掉吗？' })],
      NOW,
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 1)
    assert.equal(items[0].level, 'now')
    assert.equal(items[0].reason, 'Claude Code 卡住了')
    assert.equal(items[0].detail, '要我把 mock 清掉吗？')
    assert.equal(items[0].session?.agent, 'claude')
    assert.equal(items[0].session?.link, 'app://claude/1')
  })

  test('卡住的会话一直停在榜上——要人推正是它停着的理由', () => {
    const items = rankNextUp([req({ slug: 'a', status: '执行中' })], [sess('req-a', 'codex', 'blocked')], NOW)
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 1)
  })

  test('agent 跑完 → 第 2 档、有空再看', () => {
    const items = rankNextUp(
      [req({ slug: 'a', status: 'Review', updated: '2026-10-14' })],
      [sess('req-a', 'codex', 'done')],
      NOW,
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 2)
    assert.equal(items[0].level, 'soon')
    assert.equal(items[0].reason, 'Codex 跑完了')
    assert.equal(items[0].session?.link, 'app://codex/1')
  })

  test('点过的（idle）与正在跑的不进榜', () => {
    assert.deepEqual(
      rankNextUp([req({ slug: 'a', status: '执行中' })], [sess('req-a', 'codex', 'idle')], NOW),
      [],
    )
    assert.deepEqual(
      rankNextUp([req({ slug: 'a', status: '执行中' })], [sess('req-a', 'codex', 'working')], NOW),
      [],
    )
  })

  test('agent 跑失败 → 与「跑完」同档，理由说的是「跑失败了」', () => {
    const items = rankNextUp(
      [req({ slug: 'a', status: '执行中' })],
      [sess('req-a', 'codex', 'failed')],
      NOW,
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 2)
    assert.equal(items[0].reason, 'Codex 跑失败了')
  })

  test('Review 停太久 → 第 3 档，理由给出天数', () => {
    const items = rankNextUp([req({ slug: 'a', status: 'Review', updated: '2026-10-09' })], [], NOW)
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 3)
    assert.equal(items[0].level, 'soon')
    assert.equal(items[0].reason, 'Review 停了 5 天')
    assert.equal(items[0].session, null)
  })

  test('Review 刚动过（没到阈值）→ 不推', () => {
    assert.deepEqual(rankNextUp([req({ slug: 'a', status: 'Review', updated: '2026-10-13' })], [], NOW), [])
  })

  test('没有 agent 的澄清需求停了 5 天照样进榜——这一档兜住没有会话的需求', () => {
    const items = rankNextUp([req({ slug: 'a', status: '澄清', updated: '2026-10-09' })], [], NOW)
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 4)
    assert.equal(items[0].reason, '澄清停了 5 天')
    assert.equal(items[0].session, null)
  })

  test('档位优先：卡住 > 跑完没看 > Review > 澄清，跨档不看优先级', () => {
    const items = rankNextUp(
      [
        req({ slug: 'd', status: '澄清', priority: 'p0', updated: '2026-10-05' }),
        req({ slug: 'c', status: 'Review', priority: 'p0', updated: '2026-10-05' }),
        req({ slug: 'b', status: '执行中' }),
        req({ slug: 'a', status: '执行中' }),
      ],
      [sess('req-a', 'claude', 'blocked'), sess('req-b', 'codex', 'done')],
      NOW,
    )
    assert.deepEqual(items.map((i) => i.slug), ['a', 'b', 'c', 'd'])
    assert.deepEqual(items.map((i) => i.tier), [1, 2, 3, 4])
  })

  test('优先级只在同档内调先后：档位低的 p3 也排在档位高的 p0 前面', () => {
    const items = rankNextUp(
      [
        req({ slug: 'review-p3', status: 'Review', priority: 'p3', updated: '2026-10-05' }),
        req({ slug: 'clarify-p0', status: '澄清', priority: 'p0', updated: '2026-10-05' }),
      ],
      [],
      NOW,
    )
    assert.deepEqual(items.map((i) => i.slug), ['review-p3', 'clarify-p0'])
  })

  test('同档内 p0 排在 p3 前', () => {
    const items = rankNextUp(
      [
        req({ slug: 'x', status: '澄清', priority: 'p3', updated: '2026-10-05' }),
        req({ slug: 'y', status: '澄清', priority: 'p0', updated: '2026-10-05' }),
      ],
      [],
      NOW,
    )
    assert.deepEqual(items.map((i) => i.slug), ['y', 'x'])
  })

  test('同档同优先级：谁等得久谁在前，等得一样久按 slug 兜底', () => {
    const items = rankNextUp(
      [
        req({ slug: 'x', status: '澄清', priority: 'p2', updated: '2026-10-07' }),
        req({ slug: 'y', status: '澄清', priority: 'p2', updated: '2026-10-05' }),
        req({ slug: 'z', status: '澄清', priority: 'p2', updated: '2026-10-05' }),
      ],
      [],
      NOW,
    )
    assert.deepEqual(items.map((i) => i.slug), ['y', 'z', 'x'])
  })

  test('failed 也进第 2 档', () => {
    const items = rankNextUp([req({ slug: 'a', status: '执行中' })], [sess('req-a', 'codex', 'failed')], NOW)
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 2)
    assert.equal(items[0].reason, 'Codex 跑失败了')
  })

  test('时间戳空或落在未来：天数算不出或为负，不推', () => {
    assert.deepEqual(rankNextUp([req({ slug: 'a', status: 'Review', updated: '' })], [], NOW), [])
    assert.deepEqual(rankNextUp([req({ slug: 'b', status: '澄清', updated: '2026-11-01' })], [], NOW), [])
  })

  test('阈值可配：把澄清阈值调高，同一条需求就不再推', () => {
    const config: NextUpConfig = { ...DEFAULT_NEXT_UP_CONFIG, staleDays: { review: 2, clarify: 30 } }
    assert.deepEqual(
      rankNextUp([req({ slug: 'a', status: '澄清', updated: '2026-10-09' })], [], NOW, config),
      [],
    )
  })

  test('已完成的需求不推，哪怕名下有卡住的会话', () => {
    assert.deepEqual(
      rankNextUp([req({ slug: 'a', status: '已完成', updated: '2026-09-01' })], [sess('req-a', 'codex', 'blocked')], NOW),
      [],
    )
  })

  test('一条需求挂多条会话时取最硬的那条', () => {
    const items = rankNextUp(
      [req({ slug: 'a', status: '执行中' })],
      [
        sess('req-a', 'codex', 'done'),
        sess('req-a', 'claude', 'blocked', { needsAction: '回答我' }),
      ],
      NOW,
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].tier, 1)
    assert.equal(items[0].session?.agent, 'claude')
  })

  test('会话按需求归属对号入座，不串台', () => {
    assert.deepEqual(rankNextUp([req({ slug: 'a', status: '执行中' })], [sess('req-b', 'codex', 'blocked')], NOW), [])
  })
})

// ---------------------------------------------------------------- HTTP

describe('下一步 · HTTP', () => {
  test('GET /api/next-up 只算当前项目，别的项目的停滞不进榜', async () => {
    rmSync(TMP, { recursive: true, force: true })
    for (const [proj, slug, id] of [
      ['onex', 'alpha', 'req-alpha'],
      ['other', 'beta', 'req-beta'],
    ] as const) {
      const dir = join(TMP, proj, slug)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'AGENTS.md'), `---\nid: ${id}\n---\n\n`, 'utf8')
      writeFileSync(join(dir, 'requirement.md'), `# ${slug}\n\n## 需求\n\n${slug}\n`, 'utf8')
    }

    const app = createBoardApp({ dataDir: TMP })
    app.db.setStatus('alpha', 'Review', 'onex')
    app.db.setStatus('beta', 'Review', 'other')
    // setStatus 会把 updated 写成今天，所以直接改库里的日期，才构得出「停太久」
    const raw = new DatabaseSync(app.db.file)
    raw.prepare('UPDATE requirement SET updated = ? WHERE project = ?').run('2026-09-01', 'onex')
    raw.prepare('UPDATE requirement SET updated = ? WHERE project = ?').run('2026-09-01', 'other')
    raw.close()
    // 两个项目都停滞，看的是当前项目——显式定住 onex
    app.db.setProject('onex')

    const server = createServer((rq, rs) => void app.handle(rq, rs))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    try {
      const r = (await (await fetch(`${base}/api/next-up`)).json()) as {
        items: Array<{ slug: string; level: string; reason: string }>
      }
      assert.deepEqual(r.items.map((i) => i.slug), ['alpha'])
      assert.equal(r.items[0].level, 'soon')
      assert.match(r.items[0].reason, /^Review 停了 \d+ 天$/)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      app.close()
    }
  })
})
