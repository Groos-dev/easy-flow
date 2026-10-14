/**
 * 会话的实时状态：从 agent 应用自己的落盘文件读，只读、不写回。
 *
 * 两边都没有一个能直接用的「未读」字段，但「跑完了 / 卡在等人」有比未读更准的信号：
 *   Claude 桌面会话 → 会话记录里的 postTurnSummary.status_category
 *   Codex thread   → thread_history_1.sqlite 的 thread_turns.status
 * 字段位置与实测依据见需求 docs/easy-flow/research.md。
 *
 * hook 事件（server/hook.ts）是更快的「推」信号：有就优先用它，它是当下这一刻的形态；
 * 没有（服务重启、hook 没装、事件认不出）才退回落盘文件。所以读完不会比 hook 之前更差。
 *
 * 两条纪律：
 *   - 读不到一律 unknown，不猜。应用没装、目录搬走、字段缺失、库被锁都算读不到
 *   - 只读不写：会话是 agent 应用的东西，看板不替它做主（hook 状态只活在服务进程内，不落库）
 *
 * 已知缺口：Codex 的「等审批」在落盘文件里认不出来（只有 app-server 的 activeFlags 有，
 * 而那只对当前进程加载过的 thread 有效），所以 Codex 侧不会给出 blocked。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readdirOrEmpty, readTextOrNull } from './fsutil.ts'
import { hookStore, type HookStatus, type HookStore, type SessionActivity } from './hook.ts'

/** 状态字面量。服务端与渲染层共用这一套，展示层不再译第二遍 */
export const THREAD_STATES = ['running', 'done', 'blocked', 'failed', 'unknown'] as const
export type ThreadState = (typeof THREAD_STATES)[number]

/** 正在跑的 turn 多久没动静就当它没了：codex 崩掉会把 turn 永久留在 inProgress */
const RUNNING_TTL_MS = 30 * 60_000

export interface SessionStatus {
  state: ThreadState
  /** 细粒度活动（思考 / 干活 / 静止）：hook 驱动时有值，落盘兜底路径为空串 */
  activity: SessionActivity | ''
  /** 有你看过之后的新内容：Claude 拿 lastFocusedAt 代理，Codex 用官方未读集合 */
  fresh: boolean
  /** 需要人介入时，要人回答的那句话原文；其余为空串 */
  needsAction: string
  /** 状态时间（yyyy-mm-dd HH:mm，本机时区）；读不到为空串 */
  at: string
  /** 判据出处，详情页 hover 用 */
  detail: string
}

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
 * 给一批会话挂上实时状态。按数据源各扫一遍（不是每条会话各扫一遍），
 * 所以调用方一次传全量比逐条问划算。返回的每条都带 status，没有读不到的情形——
 * 读不到也是 unknown 这一种状态。
 */
export function withStatus<T extends { agent: string; session: string; cwd?: string }>(
  sessions: readonly T[],
  roots: ThreadRoots = defaultRoots(),
  hooks: HookStore = hookStore,
): Array<T & { status: SessionStatus }> {
  const claude = sessions.filter((s) => s.agent === 'claude')
  const codex = sessions.filter((s) => s.agent === 'codex')
  const records = claude.length ? claudeRecords(roots) : null
  const live = claude.length ? claudeLive(roots) : null
  const unread = codex.length ? codexUnread(roots) : null
  const turns = codex.length ? codexTurns(roots, codex.map((s) => s.session)) : null

  return sessions.map((s) => {
    const rec = s.agent === 'claude' ? records!.get(s.session) : undefined
    const hook = activeHook(hooks, s.session, s.agent, rec?.cliSessionId, s.cwd)
    const status =
      s.agent === 'claude'
        ? claudeStatus(rec, live!.get(s.session), hook)
        : s.agent === 'codex'
          ? codexStatus(turns!.get(s.session), unread!.has(s.session), hook)
          : // cursor 这类没有落盘状态可读
            unknownStatus(`${s.agent} 没有可读的状态来源`)
    return { ...s, status }
  })
}

/**
 * 取这条会话的 hook 状态。命中方式按可信度排，三级都限同一个 agent——
 * 同一个工作区里并排跑着 claude 与 codex 是常态，不分开就会互相点亮：
 *   1. session_id 直接等于登记 id
 *   2. 登记 id 是桌面应用的 `local_<uuid>`，hook 给的是内层 `<uuid>`——靠记录的 cliSessionId 翻译
 *   3. 前两条都没中再按工作目录兜：同目录下最近的那条（同一目录开两个会话时会认错，已知取舍）
 * 条目自身的过期在 HookStore 里判。
 */
function activeHook(
  hooks: HookStore,
  session: string,
  agent: string,
  cliSessionId: string | undefined,
  cwd: string | undefined,
): HookStatus | undefined {
  return (
    hooks.get(session, agent) ??
    (cliSessionId ? hooks.get(cliSessionId, agent) : undefined) ??
    (cwd ? hooks.byCwd(cwd, agent) : undefined)
  )
}

// ------------------------------------------------------------------ Claude

interface ClaudeRecord {
  sessionId?: string
  /** CLI 那一层的会话 id（transcript / hook 的 session_id）；桌面记录里与 sessionId 不同名 */
  cliSessionId?: string
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

function claudeStatus(
  rec: ClaudeRecord | undefined,
  live: ClaudeLive | undefined,
  hook: HookStatus | undefined,
): SessionStatus {
  // hook 给的是「此刻在干什么」，比进程在不在、上一轮的结论都细，所以最先用
  if (hook) return hookStatus(hook, claudeFresh(rec))
  // 进程在跑是当下最硬的信号，优先于记录里那份（可能刚过期的）结论。
  // 进程只报 busy/idle，说不出在思考还是在干活，所以 activity 留空
  if (live && isRunning(live)) {
    return { state: 'running', activity: '', fresh: false, needsAction: '', at: stampOf(live.statusUpdatedAt), detail: 'CLI 进程在跑' }
  }
  if (!rec) return unknownStatus('没有桌面应用的会话记录（终端会话，或记录已被清掉）')

  const summary = rec.postTurnSummary
  // 结论是为某一轮生成的；对不上最新一轮说明后面又跑过，那份结论已经过期
  const stale =
    !!rec.postTurnSummaryFor && !!rec.lastAssistantUuid && rec.postTurnSummaryFor !== rec.lastAssistantUuid
  if (!summary || stale) return unknownStatus(stale ? '会话的结论落后于最新一轮' : '会话没有结论')

  const at = stampOf(rec.lastActivityAt)
  const fresh = claudeFresh(rec)
  switch (summary.status_category) {
    case 'blocked':
      return {
        state: 'blocked',
        activity: '',
        fresh,
        needsAction: summary.needs_action ?? '',
        at,
        detail: '桌面应用结论：blocked',
      }
    case 'review_ready':
    case 'completed':
      return { state: 'done', activity: '', fresh, needsAction: '', at, detail: `桌面应用结论：${summary.status_category}` }
    case 'failed':
      return { state: 'failed', activity: '', fresh, needsAction: '', at, detail: '桌面应用结论：failed' }
    default:
      return unknownStatus(`认不出的桌面应用结论：${summary.status_category}`)
  }
}

// ------------------------------------------------------------------ Codex

interface CodexTurn {
  status: string
  /** 这条 thread 最后一个条目的时间，用来判断「在跑」是不是还有动静 */
  lastItemAt: number
}

/**
 * 轮次状态。比读 rollout jsonl 尾部稳：那边会被 thread_settings_applied 这类
 * 元数据事件盖住，还得自己跳过它们。
 *
 * 排序认 `rollout_ordinal`（落盘顺序）而不是 `started_at`：后者在 9946 条里有 4353 条是 NULL，
 * 全 NULL 的 thread 上 SQLite 取的是扫到的第一行——也就是**最早**那条 turn。实测 1832 个
 * thread 里有 170 个会因此判错（117 个该显示跑完的显示成 unknown，19 个被打断的谎报跑完）。
 */
function codexTurns(roots: ThreadRoots, ids: readonly string[]): Map<string, CodexTurn> {
  const out = new Map<string, CodexTurn>()
  const file = join(roots.codexHome, 'thread_history_1.sqlite')
  if (!ids.length || !existsSync(file)) return out
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    // codex 正在写的时候别把看板挂住：等不到就抛，外层当读不到处理
    db.exec('PRAGMA busy_timeout = 2000')
    const turn = db.prepare('SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1')
    const last = db.prepare('SELECT MAX(created_at_ms) AS at FROM thread_items WHERE thread_id = ?')
    for (const id of ids) {
      const t = turn.get(id) as { status?: string } | undefined
      if (!t?.status) continue
      const l = last.get(id) as { at?: number | null } | undefined
      out.set(id, { status: t.status, lastItemAt: l?.at ?? 0 })
    }
  } catch {
    /* 库不在、被锁、表结构变了：一律当读不到 */
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉就算了，进程退出时也会释放 */
    }
  }
  return out
}

/**
 * 桌面应用的未读集合。identityKey 是登录身份 sha256，换账号会变，所以把所有 host 求并集。
 *
 * 只认 `unreadByIdentity`——那是 app 一直在维护、你一打开 thread 就清的那份。
 * `legacyMigration` 是 app 迁移老格式时**一次性**抄过去的快照，此后不再维护、也不清理
 * （本机：新集合 7 条、旧快照 14 条，差集 8 条是 adopt 之后被读掉的）。并上它，
 * 那 8 条会永远显示未读——app 里怎么读都消不掉。
 */
function codexUnread(roots: ThreadRoots): Set<string> {
  const out = new Set<string>()
  const raw = readTextOrNull(join(roots.codexHome, '.codex-global-state.json'))
  if (!raw) return out
  try {
    const state = (JSON.parse(raw) as CodexGlobalState)['electron-thread-read-state-v1']
    for (const byHost of Object.values(state?.unreadByIdentity ?? {})) {
      for (const ids of Object.values(byHost)) for (const id of ids) out.add(id)
    }
  } catch {
    /* 解析不了就当没有未读 */
  }
  return out
}

interface CodexGlobalState {
  'electron-thread-read-state-v1'?: {
    unreadByIdentity?: Record<string, Record<string, string[]>>
  }
}

function codexStatus(turn: CodexTurn | undefined, unread: boolean, hook: HookStatus | undefined): SessionStatus {
  // 与 claude 同一条管道：hook 有就更细，没有才读轮次库。
  // 未读仍按 codex 官方的集合判，别让 hook 把「跑完没看」一律说成没看过
  if (hook) return hookStatus(hook, unread)
  if (!turn) return unknownStatus('没有 codex 的轮次记录')
  const at = stampOf(turn.lastItemAt)
  switch (turn.status) {
    case 'completed':
      return { state: 'done', activity: '', fresh: unread, needsAction: '', at, detail: '最后一条 turn 已完成' }
    case 'failed':
      return { state: 'failed', activity: '', fresh: unread, needsAction: '', at, detail: '最后一条 turn 失败' }
    case 'inProgress':
      return Date.now() - turn.lastItemAt < RUNNING_TTL_MS
        ? { state: 'running', activity: '', fresh: false, needsAction: '', at, detail: '最后一条 turn 正在跑' }
        : unknownStatus('最后一条 turn 停在 inProgress，但早已没有动静')
    case 'interrupted':
      return unknownStatus('最后一条 turn 被中断')
    default:
      return unknownStatus(`认不出的 turn 状态：${turn.status}`)
  }
}

/**
 * 桌面应用只记「最后一次聚焦」，没有真正的已读标记，拿它代理；
 * 没有记录（终端会话）时只能算新——否则这类事件永远挂不上角标。
 */
function claudeFresh(rec: ClaudeRecord | undefined): boolean {
  return rec ? (rec.lastActivityAt ?? 0) > (rec.lastFocusedAt ?? 0) : true
}

/**
 * hook 状态 → SessionStatus。
 * fresh 是「有你看过之后的新内容」，各 agent 有自己的已读信号（claude 拿 lastFocusedAt 代理，
 * codex 用官方未读集合），由调用方算好传进来：running / idle 不算事件，一律 false；
 * 只有 blocked / done / failed 这三档才看它。
 */
function hookStatus(hook: HookStatus, eventFresh: boolean): SessionStatus {
  const eventish = hook.state === 'done' || hook.state === 'blocked' || hook.state === 'failed'
  const fresh = eventish ? eventFresh : false
  return {
    state: hook.state,
    activity: hook.activity,
    fresh,
    needsAction: hook.needsAction,
    at: stampOf(hook.at),
    detail: `hook 事件：${hook.event}`,
  }
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

/** 读不到时的状态。调用方拿不到条目时也该拿到它，而不是自己拼一个 */
export function unknownStatus(detail: string): SessionStatus {
  return { state: 'unknown', activity: '', fresh: false, needsAction: '', at: '', detail }
}

/** epoch ms → 库里的时间戳口径（yyyy-mm-dd HH:mm，本机时区），渲染层的 parseStamp 认这个 */
function stampOf(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
