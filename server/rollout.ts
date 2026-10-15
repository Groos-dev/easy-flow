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
 *   - 只扫近几天：当天及前两天，加上缓存里「读到过文件」的日期目录，不遍历整棵树
 * 本实现按请求读（看板每 20s 拉一次 /api/sessions），节奏交给看板的轮询，不另起常驻定时器；
 * 增量读保证重复读只 stat + 读新增字节，「轮询不拖慢任何东西」。
 *
 * 事件 → 状态的依据是本机实测：一轮里 reasoning / function_call / function_call_output 各成一条，
 * 粒度与 Claude 的 PreToolUse / PostToolUse 同级；task_started / task_complete / turn_aborted
 * 划出这一轮的边界（分布见需求 requirement.md）。只读、不写，读不到就是读不到。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readdirOrEmpty } from './fsutil.ts'
import type { SessionStatus, ThreadState } from './session-state.ts'

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

interface Tracked {
  /** 认领的文件绝对路径。同一条会话换文件（fork / 重建）时不接新的 */
  path: string
  /** 已读到的字节数，只到最后一个换行——写了一半的尾行留到下次 */
  offset: number
  /** fold 出来的最新状态；只有认不出的事件时保持 undefined */
  status?: SessionStatus
}

/**
 * 进程内的一份 rollout 观察表：offset 与状态都留在内存里，所以「别每次全量读」是真的——
 * 重复读只 stat + 读新增字节。一个 codexHome 一份（见 rolloutStore），跨请求长期复用。
 */
export class RolloutStore {
  private byId = new Map<string, Tracked>()
  /** 读到过文件的日期目录：会话跑过近三天后，靠它继续被扫到 */
  private dirs = new Set<string>()

  constructor(private readonly codexHome: string) {}

  /**
   * 增量读一遍。只处理 ids 里的会话（外加已经在追踪的），读不到的会话不进表。
   * now 可注入，便于测试跨越「近几天」的窗口。
   */
  refresh(ids: Iterable<string>, now = Date.now()): void {
    const want = new Set(ids)
    for (const dir of this.candidateDirs(now)) {
      for (const file of readdirOrEmpty(dir)) {
        const id = threadIdOf(file)
        if (!id) continue
        const path = join(dir, file)
        if (!want.has(id) && !this.byId.has(id)) continue
        this.dirs.add(dir)
        this.readFile(path, id)
      }
    }
  }

  /** 某条会话的最新状态。没读到 / 认不出返回 undefined，调用方自己给 unknown */
  get(id: string): SessionStatus | undefined {
    return this.byId.get(id)?.status
  }

  /** 近几天 + 缓存里的日期目录，去重后按顺序返回 */
  private candidateDirs(now: number): string[] {
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
    for (const dir of this.dirs) push(dir)
    return out
  }

  private readFile(path: string, id: string): void {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return // 文件没了：当读不到
    }
    const known = this.byId.get(id)
    // 同一条会话认领过的文件不同（fork / 重建）：认最早认领的那个，别把两条流混进一份 offset
    if (known && known.path !== path) return
    const track: Tracked = known ?? { path, offset: 0 }
    this.byId.set(id, track)
    if (size < track.offset) track.offset = 0 // 被截断 / 换过：从头再读，别拿旧 offset 跳字节
    if (size <= track.offset) return

    const buf = readBytes(path, track.offset, size - track.offset)
    if (!buf) return
    const cut = buf.lastIndexOf(0x0a) // '\n'
    if (cut < 0) return // 全是半行：等下次
    const text = buf.subarray(0, cut).toString('utf8')
    track.offset += cut + 1
    for (const line of text.split('\n')) {
      const ev = parseLine(line)
      if (!ev) continue // 空行 / 写坏的行 / 不是 JSON：忽略，不拖垮整条
      const parsed = Date.parse(str(ev.timestamp))
      const status = rolloutStatusOf(ev, Number.isFinite(parsed) ? parsed : Date.now())
      if (status) track.status = status
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

const stores = new Map<string, RolloutStore>()

/** 一个 codexHome 一份 store：offset 与状态跨请求复用 */
export function rolloutStore(codexHome: string): RolloutStore {
  let store = stores.get(codexHome)
  if (!store) stores.set(codexHome, (store = new RolloutStore(codexHome)))
  return store
}
