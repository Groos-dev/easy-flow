/**
 * Codex 的落盘兜底：增量 tail ~/.codex/sessions 下的 rollout jsonl。
 *
 * hook（server/hook.ts）是「推」，但它对 Codex 覆盖不全——OpenAI 没公开事件表、subagent 也不报。
 * hook 没装 / 服务没开 / 事件丢了时，第二条腿读 Codex 自己写的 transcript，把「此刻在干什么」
 * 还原成与 hook 同一套字面量（activity: idle|thinking|working），不再退回 thread_turns.status
 * 那种 turn 级四档。
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
import type { SessionStatus, ThreadState } from './session-state.ts'
import type { SourceTable } from './source-file.ts'

/** rollout 落在 <codexHome>/sessions/<年>/<月>/<日>/ 这层日期目录下 */
const SESSION_DIR = 'sessions'
/** 文件名模式，照 clawd 的 rollout-*.jsonl。末尾就是 thread id */
const FILE_PREFIX = 'rollout-'
const FILE_SUFFIX = '.jsonl'
/** 近几天：当天及前两天。跑了好几天、rollout 落在更早日期目录里的会话靠缓存兜住 */
const RECENT_DAYS = 3

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

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
  payload?: { type?: unknown; error?: unknown } | null
  timestamp?: unknown
}

/**
 * 一行 → 一条状态，认不出返回 null（调用方忽略）。
 *
 * 口径与 hook 对齐：reasoning / function_call_output 是「思考」，function_call 是「干活」；
 * task_started 起一轮、task_complete 收一轮、turn_aborted 是打断（同 hook 的 Interrupt → blocked）。
 * session_meta 是第一行，落在「会话活着、还没干活」——与 hook 的 SessionStart 同义。
 */
export function rolloutStatusOf(line: RolloutLine, at: number): SessionStatus | null {
  const type = str(line.type)
  const sub = str(line.payload?.type)
  const of = (state: ThreadState): SessionStatus => ({
    state,
    needsAction: '',
    observedAt: at,
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

interface Track {
  /** 认领的文件绝对路径。同一条会话换文件（fork / 重建）时不接新的 */
  path: string
  /** 已读到的字节数，只到最后一个换行——写了一半的尾行留到下次 */
  offset: number
  mtimeMs: number
  /** fold 出来的最新状态；只有认不出的事件时保持上一次的 */
  state: SessionStatus | null
}

export class RolloutStore {
  constructor(
    private readonly codexHome: string,
    private readonly sources: SourceTable,
  ) {}

  /** 增量读一遍，返回认到的会话状态。只处理 ids 里的会话（外加已经跟过的） */
  refresh(ids: Iterable<string>, now = Date.now()): Map<string, SessionStatus> {
    const want = new Set(ids)
    const tracked = new Map<string, Track>()
    for (const row of this.sources.listSources()) {
      const id = threadIdOf(basename(row.path))
      if (id) tracked.set(id, { path: row.path, offset: row.offset, mtimeMs: row.mtimeMs, state: row.state as SessionStatus | null })
    }

    for (const dir of this.candidateDirs(now, tracked)) {
      for (const file of readdirOrEmpty(dir)) {
        const id = threadIdOf(file)
        if (!id) continue
        if (!want.has(id) && !tracked.has(id)) continue
        this.readFile(join(dir, file), id, tracked)
      }
    }

    const out = new Map<string, SessionStatus>()
    for (const [id, track] of tracked) if (track.state) out.set(id, track.state)
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
    const track: Track = known ?? { path, offset: 0, mtimeMs: 0, state: null }
    tracked.set(id, track)

    let { offset, state } = track
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
          const status = rolloutStatusOf(ev, Number.isFinite(parsed) ? parsed : Date.now())
          if (status) state = status
        }
      }
    }

    track.offset = offset
    track.mtimeMs = stats.mtimeMs
    track.state = state
    if (!known || known.offset !== offset || known.mtimeMs !== stats.mtimeMs) {
      this.sources.touchSource(path, { mtimeMs: stats.mtimeMs, offset, state })
    }
  }
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


