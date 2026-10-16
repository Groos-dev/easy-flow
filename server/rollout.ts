/**
 * Codex 的落盘兜底：增量 tail ~/.codex/sessions 下的 rollout jsonl。
 *
 * hook（server/hook.ts）是「推」，但它对 Codex 覆盖不全——OpenAI 没公开事件表、subagent 也不报。
 * hook 没装 / 服务没开 / 事件丢了时，第二条腿读 Codex 自己写的 transcript，把「此刻在干什么」
 * 还原成与 hook 同一套字面量（activity: idle|thinking|working），不再退回 thread_turns.status
 * 那种 turn 级四档。顺带把 function_call 里的工具名与参数归一成一句动作（见 action.ts）。
 *
 * 对齐 clawd-on-desk 的 logConfig：sessionDir=<codexHome>/sessions、filePattern=rollout-*.jsonl、
 * pollIntervalMs=1500。照抄它两件事：
 *   - 增量按字节读：每个文件记 offset，只读到最后一个换行，写了一半的尾行留到下次
 *   - 只扫近几天：当天及前两天，加上跟过的会话所在的日期目录，不遍历整棵树
 * 读的位置（offset）记在 source_file 上，所以增量读跨重启也成立。
 *
 * 事件 → 状态的依据是本机实测：一轮里 reasoning / function_call / function_call_output 各成一条，
 * 粒度与 Claude 的 PreToolUse / PostToolUse 同级；task_started / task_complete / turn_aborted
 * 划出这一轮的边界（分布见需求 requirement.md）。只读、不写，读不到就是读不到。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readdirOrEmpty } from './fsutil.ts'
import { parseJsonOrNull, str } from './util.ts'
import type { SessionObservation, SessionStatus, ThreadState } from './session-state.ts'
import { actionOf, type SessionAction } from './action.ts'
import type { SourceTable } from './source-file.ts'

/** rollout 落在 <codexHome>/sessions/<年>/<月>/<日>/ 这层日期目录下 */
const SESSION_DIR = 'sessions'
/** 文件名模式，照 clawd 的 rollout-*.jsonl。末尾就是 thread id */
const FILE_PREFIX = 'rollout-'
const FILE_SUFFIX = '.jsonl'
/** 近几天：当天及前两天。跑了好几天、rollout 落在更早日期目录里的会话靠缓存兜住 */
const RECENT_DAYS = 3

/** 文件名里的 thread id：rollout-<ISO 日期>-<id>.jsonl。认不出返回 null，不猜 */
const THREAD_ID_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/

function threadIdOf(file: string): string | null {
  if (!file.startsWith(FILE_PREFIX) || !file.endsWith(FILE_SUFFIX)) return null
  return THREAD_ID_RE.exec(file)?.[1] ?? null
}

/** 某天的 rollout 目录。测试与「近几天」的计算共用，别两处各写一遍日期格式 */
export function sessionDirFor(codexHome: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return join(codexHome, SESSION_DIR, String(at.getFullYear()), p(at.getMonth() + 1), p(at.getDate()))
}

/** rollout 的一行。只挑认得的字段，其余原样不关心 */
interface RolloutLine {
  type?: unknown
  payload?: { type?: unknown; error?: unknown; name?: unknown; arguments?: unknown } | null
  timestamp?: unknown
}

/**
 * 一行 → 一条状态，认不出返回 null（调用方忽略）。
 *
 * 口径与 hook 对齐：reasoning / function_call_output 是「思考」，function_call 是「干活」；
 * task_started 起一轮、task_complete 收一轮、turn_aborted 是打断（同 hook 的 Interrupt → blocked）。
 * session_meta 是第一行，落在「会话活着、还没干活」——与 hook 的 SessionStart 同义。
 */
export function rolloutStatusOf(line: RolloutLine, observedAt: number): SessionStatus | null {
  const type = str(line.type)
  const sub = str(line.payload?.type)
  const of = (state: ThreadState): SessionStatus => ({
    state,
    needsAction: '',
    observedAt,
    detail: `rollout 事件：${sub ? `${type}/${sub}` : type}`,
  })
  if (type === 'session_meta') return of('idle')
  if (type === 'event_msg') {
    switch (sub) {
      case 'task_started':
        return of('thinking')
      case 'task_complete':
        // 带 error 的这轮没跑完（如 stream disconnected）：落到 failed，不假装 done
        return line.payload?.error ? of('failed') : of('done')
      case 'turn_aborted':
        return of('blocked')
      default:
        return null
    }
  }
  if (type === 'response_item') {
    switch (sub) {
      case 'reasoning':
      case 'function_call_output':
        return of('thinking')
      case 'function_call':
      case 'web_search_call':
        return of('working')
      default:
        return null
    }
  }
  return null
}

/**
 * 一行 → 一句动作，认不出返回 null。
 *
 * 只有 function_call 有——hook 没接上时，气泡里那句「在干什么」就靠这儿。
 * 动作的时刻就是这一行的时刻。
 */
export function rolloutActionOf(line: RolloutLine, observedAt: number): SessionAction | null {
  if (str(line.type) !== 'response_item' || str(line.payload?.type) !== 'function_call') return null
  // 参数存成一串 JSON，解不开就当没有——不猜里面长什么样
  return actionOf(str(line.payload?.name), parseJsonOrNull(str(line.payload?.arguments)), observedAt)
}

interface Track {
  /** 认领的文件绝对路径。同一条会话换文件（fork / 重建）时不接新的 */
  path: string
  /** 已读到的字节数，只到最后一个换行——写了一半的尾行留到下次 */
  offset: number
  mtimeMs: number
  /** fold 出来的最新观察；只有认不出的事件时保持上一次的 */
  observation: SessionObservation | null
  /** 缓存里那份认不出、这轮必须写回：不然 offset 重算成一样，旧形状会一直留在库里 */
  rewrite: boolean
}

export class RolloutStore {
  constructor(
    private readonly codexHome: string,
    private readonly sources: SourceTable,
  ) {}

  /** 增量读一遍，返回认到的会话观察。只处理 ids 里的会话（外加已经跟过的） */
  refresh(ids: Iterable<string>, now = Date.now()): Map<string, SessionObservation> {
    const want = new Set(ids)
    const tracked = new Map<string, Track>()
    for (const row of this.sources.listSources()) {
      const id = threadIdOf(basename(row.path))
      if (!id) continue
      // 缓存认不出就从头读：offset 一起归零，让这一轮把状态重新 fold 出来
      const observation = cachedObservation(row.state)
      tracked.set(id, {
        path: row.path,
        offset: observation ? row.offset : 0,
        mtimeMs: row.mtimeMs,
        observation,
        rewrite: !observation && row.state != null,
      })
    }

    for (const dir of this.candidateDirs(now, tracked)) {
      for (const file of readdirOrEmpty(dir)) {
        const id = threadIdOf(file)
        if (!id) continue
        if (!want.has(id) && !tracked.has(id)) continue
        this.readFile(join(dir, file), id, tracked)
      }
    }

    const out = new Map<string, SessionObservation>()
    for (const [id, track] of tracked) if (track.observation) out.set(id, track.observation)
    return out
  }

  /** 近几天 + 跟过的会话所在目录，去重后按顺序返回 */
  private candidateDirs(now: number, tracked: Map<string, Track>): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (dir: string) => {
      if (!seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
    const day = new Date(now)
    for (let i = 0; i < RECENT_DAYS; i++) {
      push(sessionDirFor(this.codexHome, day))
      day.setDate(day.getDate() - 1)
    }
    for (const track of tracked.values()) push(dirname(track.path))
    return out
  }

  private readFile(path: string, id: string, tracked: Map<string, Track>): void {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(path)
    } catch {
      return // 文件没了：当读不到
    }
    const known = tracked.get(id)
    // 同一条会话认领过的文件不同（fork / 重建）：认最早认领的那个，别把两条流混进一份 offset
    if (known && known.path !== path) return
    const track: Track = known ?? { path, offset: 0, mtimeMs: 0, observation: null, rewrite: false }
    tracked.set(id, track)

    let { offset, observation } = track
    if (stats.size < offset) offset = 0 // 被截断 / 换过：从头再读，别拿旧 offset 跳字节
    if (stats.size > offset) {
      const buf = readBytes(path, offset, stats.size - offset)
      const cut = buf ? buf.lastIndexOf(0x0a) : -1 // '\n'
      if (buf && cut >= 0) {
        const text = buf.subarray(0, cut).toString('utf8')
        offset += cut + 1
        for (const line of text.split('\n')) {
          const ev = parseLine(line)
          if (!ev) continue // 空行 / 写坏的行 / 不是 JSON：忽略，不拖垮整条
          const parsed = Date.parse(str(ev.timestamp))
          const observedAt = Number.isFinite(parsed) ? parsed : Date.now()
          const status = rolloutStatusOf(ev, observedAt)

          if (!status) {
            continue
          }
          const action = rolloutActionOf(ev, observedAt) ?? observation?.action ?? null
          observation = { status, action}
        }
      }
    }

    track.offset = offset
    track.mtimeMs = stats.mtimeMs
    track.observation = observation
    if (track.rewrite || !known || known.offset !== offset || known.mtimeMs !== stats.mtimeMs) {
      this.sources.touchSource(path, { mtimeMs: stats.mtimeMs, offset, state: observation })
      track.rewrite = false
    }
  }
}

/**
 * source_file 里缓存的那份观察。形状对不上就当没有——那是上一版写下的（当时还是裸的一条
 * SessionStatus），或者被人改坏了；调用方据此从头重读，而不是拿着半截数据往下走。
 */
function cachedObservation(raw: unknown): SessionObservation | null {
  if (!raw || typeof raw !== 'object') return null
  const { status, action } = raw as { status?: unknown; action?: unknown }
  if (!status || typeof status !== 'object') return null
  return { status: status as SessionStatus, action: (action as SessionAction | null) ?? null }
}

/** 从 from 起读 length 字节。读不到返回 null——调用方当没读到，不抛 */
function readBytes(path: string, from: number, length: number): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.allocUnsafe(length)
    const read = readSync(fd, buf, 0, length, from)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function parseLine(line: string): RolloutLine | null {
  if (!line) return null
  try {
    const obj: unknown = JSON.parse(line)
    return obj && typeof obj === 'object' ? (obj as RolloutLine) : null
  } catch {
    return null
  }
}


