/**
 * 会话状态的**拉取源**与读口。
 *
 * 拉取时读一遍 agent 应用的落盘（只读、不写回），把观察写进状态层
 * （server/session-state.ts）；读口只查状态层，不碰文件。写的时候按「时刻新的覆盖旧的」合并，
 * 所以读的时候一次查表就够——没有优先级梯子，也没有第二个口径。
 *
 *   Claude 桌面会话 → 会话记录里的 postTurnSummary.status_category + CLI 进程文件
 *   Codex thread   → rollout jsonl（server/rollout.ts），细到每次工具调用
 * 字段位置与实测依据见需求 docs/easy-flow/research.md。
 *
 * 三条纪律：
 *   - 读不到一律 unknown，不猜。应用没装、目录搬走、字段缺失、库被锁都算读不到
 *   - 只读不写：会话是 agent 应用的东西，看板不替它做主（状态只活在服务进程内，不落库）
 *   - 说不出时刻的观察 observedAt 记 0：它只在状态层空着时落得下，盖不掉有时刻的那条
 *
 * 已知缺口：Codex 的「等审批」在落盘文件里认不出来（只有 app-server 的 activeFlags 有，
 * 而那只对当前进程加载过的 thread 有效），所以 Codex 侧不会给出 blocked。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { readdirOrEmpty, readTextOrNull } from './fsutil.ts'
import {
  isActive,
  unknownStatus,
  type SessionObservation,
  type SessionStateStore,
  type SessionStatus,
} from './session-state.ts'
import type { SessionAction } from './action.ts'
import { str } from './util.ts'
import { RolloutStore } from './rollout.ts'
import { codexUnread } from './codex-unread.ts'
import { codexTitles } from './codex-titles.ts'
import { changed, type SourceTable } from './source-file.ts'

/** 停在「在干活」多久没新事件就当它没了：会话崩了不会有收尾事件 */
const RUNNING_TTL_MS = 30 * 60_000

/** 三处外部数据的位置。默认本机；测试传临时目录 */
export interface ThreadRoots {
  /** macOS 的 Application Support，Claude 桌面应用数据目录在它下面 */
  appSupport: string
  /** ~/.claude */
  claudeHome: string
  /** ~/.codex */
  codexHome: string
}

export function defaultRoots(): ThreadRoots {
  const home = homedir()
  return {
    appSupport: join(home, 'Library', 'Application Support'),
    claudeHome: join(home, '.claude'),
    codexHome: join(home, '.codex'),
  }
}

export const PULL_INTERVAL_MS = 2_000

export function pullStatuses(
  sessions: readonly { agent: string; session: string }[],
  states: SessionStateStore,
  sources: SourceTable,
  roots: ThreadRoots = defaultRoots(),
): void {
  const claude = sessions.filter((s) => s.agent === 'claude')
  const codex = sessions.filter((s) => s.agent === 'codex')
  const live = claude.length ? claudeLive(roots) : null

  // 只有推送来源的 agent（程小帮）：没有落盘可读，但收尾的兜底不能少——
  // 会话崩了不会有 Stop，状态会永远停在「干活」。
  for (const s of sessions) {
    if (s.agent === 'claude' || s.agent === 'codex') continue
    const current = states.get(s.agent, states.keyOf(s.agent, s.session))
    if (!current) continue
    const settled = settleActive(current.status, false)
    if (settled !== current.status) states.put(s.agent, s.session, settled)
  }

  // 合并按时刻走，所以先后顺序无所谓
  if (live) for (const s of claude) pullClaude(s.session, roots, live, states, sources)
  if (codex.length) {
    const rollouts = new RolloutStore(roots.codexHome, sources).refresh(codex.map((s) => s.session))
    const unread = codexUnread(roots.codexHome, sources)
    for (const s of codex) {
      const observation = rollouts.get(s.session) ?? { status: unknownStatus('没有 codex 的 rollout 记录'), action: null }
      putSettled(states, 'codex', s.session, codexSeen(s.session, observation, unread), false)
    }
  }
}

/**
 * codex 的「跑完没看」：读过的落成静止。只动状态那一半。
 */
function codexSeen(id: string, observation: SessionObservation, unread: Set<string> | null): SessionObservation {
  const { status } = observation
  if (status.state !== 'done' || !unread || unread.has(id)) return observation
  return { ...observation, status: { ...status, state: 'idle' } }
}

/** 标题往哪写。index.ts 传 db，测试传一个收集器 */
export interface TitleTable {
  setSessionTitle(agent: string, session: string, title: string): void
}

/**
 * 把 agent 应用里的标题同步进登记记录（session 表的 title）。
 *
 * claude 读桌面记录的 `title`，桌面记录没有时退到 CLI 进程文件的 `name`（终端会话只有这个）；
 * codex 读它自己 threads 表里的 `name`。原样写，不裁剪。应用里还没起名、或者读不到，
 * 就不写——保留登记时那句。
 */
export function pullTitles(
  sessions: readonly { agent: string; session: string }[],
  titles: TitleTable,
  roots: ThreadRoots = defaultRoots(),
): void {
  const claude = sessions.filter((s) => s.agent === 'claude')
  if (claude.length) {
    const records = claudeRecords(roots, claude.map((s) => s.session))
    const live = claudeLive(roots)
    for (const s of claude) {
      const title = str(records.get(s.session)?.title) || str(live.get(s.session)?.name)
      if (title) titles.setSessionTitle('claude', s.session, title)
    }
  }

  const codex = sessions.filter((s) => s.agent === 'codex')
  if (codex.length) {
    const found = codexTitles(roots.codexHome)
    for (const s of codex) {
      const title = found.get(s.session)
      if (title) titles.setSessionTitle('codex', s.session, title)
    }
  }
}

/**
 * 读口：按登记 id 取每条会话的最新观察（状态 + 动作）。查不到就是 unknown。
 */
export function readObservations<T extends { agent: string; session: string }>(
  sessions: readonly T[],
  states: SessionStateStore,
): Array<T & { status: SessionStatus; action: SessionAction | null }> {
  return sessions.map((s) => {
    const stored = states.get(s.agent, states.keyOf(s.agent, s.session))
    const status = stored?.status ?? unknownStatus(`${s.agent} 没有可读的状态来源`)
    return { ...s, status, action: stored?.action ?? null }
  })
}

/**
 * 板侧写状态（点 pet）时该用哪个 key。与读口用的是同一个翻译——
 * 桌面会话的登记 id 是 `local_<uuid>`，而 hook 报的是内层 `<uuid>`，不翻就落在两个格子里，
 * 「下一个事件直接覆盖」就不成立。没有记录的（终端会话、codex）用登记 id——hook 报的也是它。
 */
export function hookKeyOf(agent: string, session: string, roots: ThreadRoots = defaultRoots()): string {
  return stateKeyOf(agent, session, agent === 'claude' ? claudeRecords(roots, [session]).get(session) : undefined)
}

function stateKeyOf(agent: string, session: string, rec: ClaudeRecord | undefined): string {
  if (agent !== 'claude') return session
  return rec?.cliSessionId || session
}

/**
 * 把一条 claude 会话的落盘观察写进状态层：进程在跑、记录里的上一轮结论，谁的时刻新谁说话。
 * 两边都写，不在这儿判优先级——那是状态层的活。
 */
function pullClaude(
  session: string,
  roots: ThreadRoots,
  live: Map<string, ClaudeLive>,
  states: SessionStateStore,
  sources: SourceTable,
): void {
  const proc = live.get(session)
  const alive = !!proc && isRunning(proc)
  const key = states.keyOf('claude', session)
  const path = recordPathFor(session, roots)

  // 记录文件没变：库里那条就是对的，只收一次尾（停在半途太久要降档），不重算
  if (path && !changed(sources, path)) {
    const current = states.get('claude', key)
    const settled = current ? settleActive(current.status, alive) : undefined
    if (settled && settled !== current?.status) states.put('claude', key, settled)
    return
  }

  const rec = path ? claudeRecords(roots, [session]).get(session) : undefined
  const stateKey = stateKeyOf('claude', session, rec)
  states.alias('claude', session, stateKey)

  // 进程在跑是「此刻的事实」，不是一条带时刻的观察——所以时刻记现在，不是文件里的 statusUpdatedAt
  // （那个只在 busy/idle 切换时写，比记录里的 lastActivityAt 旧得多，拿它排序会被上一轮的结论顶掉）。
  // 表里已经在干活就让它说话：hook 分得出「思考 / 干活」，而进程文件只报 busy/idle，说不出是哪种。
  if (alive && !isActive(states.get('claude', stateKey)?.status.state ?? 'unknown')) {
    states.put('claude', stateKey, {
      state: 'working',
      needsAction: '',
      observedAt: Date.now(),
      detail: 'CLI 进程在跑',
    })
  }

  putSettled(states, 'claude', stateKey, { status: claudeRecordStatus(rec), action: null }, alive)
  if (path) sources.touchSource(path, { mtimeMs: statSync(path).mtimeMs })
}

/**
 * 落一条落盘观察：先写，再收尾（停在半途太久要降档）。
 */
function putSettled(
  states: SessionStateStore,
  agent: string,
  session: string,
  observation: SessionObservation,
  alive: boolean,
): void {
  states.put(agent, session, observation.status, observation.action)
  const current = states.get(agent, session)
  const settled = current ? settleActive(current.status, alive) : undefined
  if (settled && settled !== current?.status) states.put(agent, session, settled)
}

function recordPathFor(session: string, roots: ThreadRoots): string | null {
  for (const dir of claudeRecordDirs(roots)) {
    const path = join(dir, `${session}.json`)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * 桌面记录里的上一轮结论。没有记录 / 没有结论 / 结论落后于最新一轮，都记 observedAt 0——
 * 说不出时刻的观察不该盖掉有时刻的（比如一条刚到的 hook 事件）。
 */
function claudeRecordStatus(rec: ClaudeRecord | undefined): SessionStatus {
  if (!rec) return unknownStatus('没有桌面应用的会话记录（终端会话，或记录已被清掉）')

  const summary = rec.postTurnSummary
  // 结论是为某一轮生成的；对不上最新一轮说明后面又跑过，那份结论已经过期
  const stale =
    !!rec.postTurnSummaryFor && !!rec.lastAssistantUuid && rec.postTurnSummaryFor !== rec.lastAssistantUuid
  if (!summary || stale) return unknownStatus(stale ? '会话的结论落后于最新一轮' : '会话没有结论')

  const observedAt = rec.lastActivityAt ?? 0
  switch (summary.status_category) {
    case 'blocked':
      return { state: 'blocked', needsAction: summary.needs_action ?? '', observedAt, detail: '桌面应用结论：blocked' }
    case 'review_ready':
    case 'completed':
      return {
        state: seen(rec) ? 'idle' : 'done',
        needsAction: '',
        observedAt,
        detail: `桌面应用结论：${summary.status_category}`,
      }
    case 'failed':
      return { state: 'failed', needsAction: '', observedAt, detail: '桌面应用结论：failed' }
    default:
      return unknownStatus(`认不出的桌面应用结论：${summary.status_category}`)
  }
}

/**
 * 停在「在干活」太久就当它没了——会话崩了不会有收尾事件。
 * 进程还活着的不算：那条有 pid 兜底，进程在就是真在（CLI 只在状态切换时写文件，
 * 长时间 busy 不会刷新时刻，拿它当过期会误杀）。
 */
function seen(rec: ClaudeRecord): boolean {
  const act = rec.lastActivityAt
  if (!act) return false
  return (rec.lastFocusedAt ?? 0) >= act
}

function settleActive(status: SessionStatus, alive: boolean): SessionStatus {
  if (!isActive(status.state) || alive) return status
  if (Date.now() - status.observedAt <= RUNNING_TTL_MS) return status
  return { state: 'unknown', needsAction: '', observedAt: Date.now(), detail: '最后一条状态停在半途，早已没有动静' }
}

// ------------------------------------------------------------------ Claude

interface ClaudeRecord {
  sessionId?: string
  /** CLI 那一层的会话 id（transcript / hook 的 session_id）；桌面记录里与 sessionId 不同名 */
  cliSessionId?: string
  /** 应用里显示的会话标题 */
  title?: string
  /** 最后一轮活动的时刻。桌面记录这条观察的时刻就是它（进 observedAt） */
  lastActivityAt?: number
  lastFocusedAt?: number
  postTurnSummaryFor?: string
  lastAssistantUuid?: string
  postTurnSummary?: {
    status_category?: string
    needs_action?: string
  }
}

interface ClaudeLive {
  pid?: number
  sessionId?: string
  hostSessionId?: string
  /**
   * 会话名。桌面会话与记录里的 title 是同一句，终端会话只有这个。
   */
  name?: string
  status?: string
  statusUpdatedAt?: number
}

/**
 * 桌面应用的会话记录，键是 `local_<uuid>`——也就是 easy-flow 登记的那个 id。
 * 盘上是 <账号 uuid>/<org uuid>/local_<uuid>.json 两层，同层还躺着 .profile-origin.json 这类旁挂文件，
 * 按前缀挑出来即可。标准与第三方 provider 是同一 app 的两套数据目录（Claude / Claude-3p），
 * 切 provider 会换，所以都找。
 */
function claudeRecords(roots: ThreadRoots, sessions?: readonly string[]): Map<string, ClaudeRecord> {
  const out = new Map<string, ClaudeRecord>()
  const want = sessions ? new Set(sessions) : null
  for (const dir of claudeRecordDirs(roots)) {
    for (const file of readdirOrEmpty(dir)) {
      if (!file.startsWith('local_') || !file.endsWith('.json')) continue
      if (want && !want.has(file.slice(0, -'.json'.length))) continue
      const raw = readTextOrNull(join(dir, file))
      if (!raw) continue
      try {
        const rec = JSON.parse(raw) as ClaudeRecord
        if (rec?.sessionId) out.set(rec.sessionId, rec)
      } catch {
        /* 写了一半或坏了：当这条读不到 */
      }
    }
  }
  return out
}

/** 会话记录所在的那两层目录，先摊平再读 */
function claudeRecordDirs(roots: ThreadRoots): string[] {
  const dirs: string[] = []
  for (const app of readdirOrEmpty(roots.appSupport)) {
    if (!app.startsWith('Claude')) continue
    const base = join(roots.appSupport, app, 'claude-code-sessions')
    for (const account of readdirOrEmpty(base)) {
      for (const org of readdirOrEmpty(join(base, account))) dirs.push(join(base, account, org))
    }
  }
  return dirs
}

/** 活着的 CLI 进程才有这个文件，进程一退就没了。两个 id 都建索引，调用方传哪个都能命中 */
function claudeLive(roots: ThreadRoots): Map<string, ClaudeLive> {
  const out = new Map<string, ClaudeLive>()
  const dir = join(roots.claudeHome, 'sessions')
  for (const file of readdirOrEmpty(dir)) {
    if (!file.endsWith('.json')) continue
    const raw = readTextOrNull(join(dir, file))
    if (!raw) continue
    try {
      const rec = JSON.parse(raw) as ClaudeLive
      if (rec?.hostSessionId) out.set(rec.hostSessionId, rec)
      if (rec?.sessionId) out.set(rec.sessionId, rec)
    } catch {
      /* 同上 */
    }
  }
  return out
}

// ------------------------------------------------------------------ 零件

/**
 * 进程在不在。kill(pid, 0) 不发信号，只做存在性检查。
 * `~/.claude/sessions/<pid>.json` 是 CLI 自己写的，被 kill -9 时会残留成 status=busy，
 * 不核对 pid 的话看板会永远显示「正在跑」——而 running 不受已读影响，人只能手动删文件。
 */
function isRunning(live: ClaudeLive): boolean {
  if (live.status !== 'busy') return false
  // 文件里没记 pid（老版本）：无从核对，按在跑算
  if (!live.pid) return true
  try {
    process.kill(live.pid, 0)
    return true
  } catch {
    return false
  }
}
