/**
 * 会话状态的**拉取源**与读口。
 *
 * 看板每次请求时读一遍 agent 应用的落盘（只读、不写回），把观察写进状态层
 * （server/session-state.ts），再从状态层读出来。写的时候按「时刻新的赢」合并，
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
import { readdirOrEmpty, readTextOrNull } from './fsutil.ts'
import { isActive, sessionState, unknownStatus, type SessionStateStore, type SessionStatus } from './session-state.ts'
import { rolloutStore } from './rollout.ts'

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

/**
 * 给一批会话挂上实时状态：先把落盘的观察拉进状态层，再逐条读出来。
 * 按数据源各扫一遍（不是每条会话各扫一遍），所以调用方一次传全量比逐条问划算。
 * 返回的每条都带 status，没有读不到的情形——读不到也是 unknown 这一种状态。
 */
export function withStatus<T extends { agent: string; session: string }>(
  sessions: readonly T[],
  roots: ThreadRoots = defaultRoots(),
  states: SessionStateStore = sessionState,
): Array<T & { status: SessionStatus }> {
  const claude = sessions.filter((s) => s.agent === 'claude')
  const codex = sessions.filter((s) => s.agent === 'codex')
  const records = claude.length ? claudeRecords(roots) : null
  const live = claude.length ? claudeLive(roots) : null

  // 拉取：把文件源的观察写进状态层。合并按时刻走，所以先后顺序无所谓
  if (records && live) for (const s of claude) pullClaude(s.session, records, live, states)
  if (codex.length) {
    const rollouts = rolloutStore(roots.codexHome)
    rollouts.refresh(codex.map((s) => s.session))
    for (const s of codex) {
      states.put('codex', s.session, rollouts.get(s.session) ?? unknownStatus('没有 codex 的 rollout 记录'))
    }
  }

  // 读：一次查表，再加一条领域规则
  return sessions.map((s) => {
    const rec = s.agent === 'claude' ? records!.get(s.session) : undefined
    const proc = s.agent === 'claude' ? live!.get(s.session) : undefined
    const stored = states.get(s.agent, stateKeyOf(s.agent, s.session, rec))
    const status = stored
      ? settleActive(stored, !!proc && isRunning(proc))
      : unknownStatus(`${s.agent} 没有可读的状态来源`)
    return { ...s, status }
  })
}

/**
 * 板侧写状态（点 pet）时该用哪个 key。与读口用的是同一个翻译——
 * 桌面会话的登记 id 是 `local_<uuid>`，而 hook 报的是内层 `<uuid>`，不翻就落在两个格子里，
 * 「下一个事件直接覆盖」就不成立。没有记录的（终端会话、codex）用登记 id——hook 报的也是它。
 */
export function hookKeyOf(agent: string, session: string, roots: ThreadRoots = defaultRoots()): string {
  return stateKeyOf(agent, session, agent === 'claude' ? claudeRecords(roots).get(session) : undefined)
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
  records: Map<string, ClaudeRecord>,
  live: Map<string, ClaudeLive>,
  states: SessionStateStore,
): void {
  const rec = records.get(session)
  const key = stateKeyOf('claude', session, rec)

  // 进程在跑是「此刻的事实」，不是一条带时刻的观察——所以时刻记现在，不是文件里的 statusUpdatedAt
  // （那个只在 busy/idle 切换时写，比记录里的 lastActivityAt 旧得多，拿它排序会被上一轮的结论顶掉）。
  // 表里已经在干活就让它说话：hook 分得出「思考 / 干活」，而进程文件只报 busy/idle，说不出是哪种。
  const proc = live.get(session)
  if (proc && isRunning(proc) && !isActive(states.get('claude', key)?.state ?? 'unknown')) {
    states.put('claude', key, {
      state: 'working',
      needsAction: '',
      observedAt: Date.now(),
      detail: 'CLI 进程在跑',
    })
  }

  states.put('claude', key, claudeRecordStatus(rec))
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
      return { state: 'done', needsAction: '', observedAt, detail: `桌面应用结论：${summary.status_category}` }
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
function settleActive(status: SessionStatus, alive: boolean): SessionStatus {
  if (!isActive(status.state) || alive) return status
  return Date.now() - status.observedAt > RUNNING_TTL_MS
    ? unknownStatus('最后一条状态停在半途，早已没有动静')
    : status
}

// ------------------------------------------------------------------ Claude

interface ClaudeRecord {
  sessionId?: string
  /** CLI 那一层的会话 id（transcript / hook 的 session_id）；桌面记录里与 sessionId 不同名 */
  cliSessionId?: string
  /** 最后一轮活动的时刻。桌面记录这条观察的时刻就是它（进 observedAt） */
  lastActivityAt?: number
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
  status?: string
  statusUpdatedAt?: number
}

/**
 * 桌面应用的会话记录，键是 `local_<uuid>`——也就是 easy-flow 登记的那个 id。
 * 盘上是 <账号 uuid>/<org uuid>/local_<uuid>.json 两层，同层还躺着 .profile-origin.json 这类旁挂文件，
 * 按前缀挑出来即可。标准与第三方 provider 是同一 app 的两套数据目录（Claude / Claude-3p），
 * 切 provider 会换，所以都找。
 */
function claudeRecords(roots: ThreadRoots): Map<string, ClaudeRecord> {
  const out = new Map<string, ClaudeRecord>()
  for (const dir of claudeRecordDirs(roots)) {
    for (const file of readdirOrEmpty(dir)) {
      if (!file.startsWith('local_') || !file.endsWith('.json')) continue
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
