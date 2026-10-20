/**
 * 程小帮的落盘：读它自己的库 `~/.chengxiaobang/data/chengxiaobang.sqlite`。
 *
 * 小帮没有 `SessionEnd`，hook 状态也只活在 easy-flow 进程内——服务一重启，光靠推送就什么都
 * 读不回来。与 claude 读桌面记录、codex 读 rollout 同一条思路：拉取只用来补推送的空档，
 * hook 事件的时刻更新，会正常盖过这里读到的旧结论。
 *
 * 只读、不写回。表是应用内部的（sessions / runs / messages）：库没建、被锁、表换过都当没有。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unknownStatus, type SessionObservation, type SessionStatus, type ThreadState } from './session-state.ts'

/** 小帮把库放在 `<root>/data/chengxiaobang.sqlite`，root 默认是 ~/.chengxiaobang */
function chengxiaobangDbPath(root: string): string {
  return join(root, 'data', 'chengxiaobang.sqlite')
}

/** 只读打开；库没建或被锁时返回 null，调用方一律当「没有」 */
function openDb(root: string): DatabaseSync | null {
  const path = chengxiaobangDbPath(root)
  if (!existsSync(path)) return null
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

interface Row {
  id?: unknown
  status?: unknown
  error?: unknown
  run_at?: unknown
  message_at?: unknown
  session_at?: unknown
  last_viewed_at?: unknown
}

/** 应用写的是 ISO 字符串；认不出就记 0，让带时刻的观察压过它 */
function at(value: unknown): number {
  if (typeof value !== 'string') return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * 一条会话的落盘结论。
 *
 * 依据是最近一轮 run 的状态：running 在干活、failed 失败、aborted 是被人按停（等同 blocked），
 * completed 再按有没有看过分 done / idle。没有 run 只有消息的会话算静止。
 */
function statusOf(row: Row, observedAt: number): SessionStatus {
  const run = typeof row.status === 'string' ? row.status : ''
  const error = typeof row.error === 'string' ? row.error : ''
  switch (run) {
    case 'running':
      return { state: 'working', needsAction: '', observedAt, detail: '程小帮库：这一轮还在跑' }
    case 'failed':
      return { state: 'failed', needsAction: '', observedAt, detail: error ? `程小帮库：失败（${error}）` : '程小帮库：失败' }
    case 'aborted':
      return { state: 'blocked', needsAction: '', observedAt, detail: '程小帮库：这一轮被停下' }
    case 'completed': {
      // 最后一轮跑完之后有没有被看过：看过就是静止，没看过留着「跑完待看」
      const seen = at(row.last_viewed_at)
      const state: ThreadState = seen && seen >= observedAt ? 'idle' : 'done'
      return { state, needsAction: '', observedAt, detail: `程小帮库：${state === 'done' ? '跑完待看' : '已看过'}` }
    }
    default:
      if (observedAt) return { state: 'idle', needsAction: '', observedAt, detail: '程小帮库：没有跑过' }
      return unknownStatus('程小帮库里没有这条会话的记录')
  }
}

/**
 * 按登记 id 读每条会话的最新观察。读不到的一律当「没有」——返回的表里缺席，
 * 调用方据此退回 unknown，不会拿假状态盖掉 hook 刚推来的那条。
 */
export function chengxiaobangObservations(
  root: string,
  sessions: readonly string[],
): Map<string, SessionObservation> {
  const out = new Map<string, SessionObservation>()
  if (!sessions.length) return out
  const db = openDb(root)
  if (!db) return out
  try {
    const marks = sessions.map(() => '?').join(', ')
    // 每条会话各取最近一轮 run 与最后一条消息；子查询比窗口函数好读，会话数也不大
    const rows = db
      .prepare(
        `SELECT s.id AS id,
                s.updated_at AS session_at,
                s.last_viewed_at AS last_viewed_at,
                r.status AS status,
                r.error AS error,
                r.updated_at AS run_at,
                m.created_at AS message_at
           FROM sessions s
           LEFT JOIN runs r ON r.id = (
             SELECT id FROM runs WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1
           )
           LEFT JOIN messages m ON m.id = (
             SELECT id FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1
           )
          WHERE s.id IN (${marks})`,
      )
      .all(...sessions) as unknown as Row[]

    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : ''
      if (!id) continue
      const observedAt = Math.max(at(row.run_at), at(row.message_at), at(row.session_at))
      out.set(id, { status: statusOf(row, observedAt), action: null })
    }
  } catch {
    /* 表不在 / 库被锁 / 版本换过：当没有 */
  } finally {
    db.close()
  }
  return out
}

interface TitleRow {
  id?: unknown
  title?: unknown
}

/**
 * 按登记 id 读小帮侧边栏里的标题。
 *
 * 应用里的 `sessions.title` 就是侧边栏显示的那个名字：新建时先写截断的占位，随后由 AI
 * 总结覆盖。空串是「还没起名」，当没有——调用方保留登记时那句。
 */
export function chengxiaobangTitles(root: string, sessions: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!sessions.length) return out
  const db = openDb(root)
  if (!db) return out
  try {
    const marks = sessions.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id, title FROM sessions WHERE id IN (${marks})`)
      .all(...sessions) as unknown as TitleRow[]
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : ''
      const title = typeof row.title === 'string' ? row.title : ''
      if (id && title) out.set(id, title)
    }
  } catch {
    /* 表不在 / 库被锁 / 版本换过：当没有 */
  } finally {
    db.close()
  }
  return out
}
