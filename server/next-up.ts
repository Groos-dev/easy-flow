/**
 * 「下一步该动哪个」的排名。
 *
 * 看板按状态分组，但状态不是优先级——它答不了「我现在该动哪个」。这里把手上所有信号
 * 揉成一个排名，每条带一句中文理由：没有理由的推荐是个黑盒，人不会信。
 *
 * 排序依据从硬到软（档位优先，优先级只在档内调先后，不跨档）：
 *   1. agent 卡住等你 —— 不回答它就一直停着，唯一「不动就真的停住」的
 *   2. agent 跑完 / 跑失败没看 —— 结果没人验收，等于白跑
 *   3. Review 停太久 —— 代码在等评审/合并，流程堵在这儿
 *   4. 澄清停太久 —— 需求没定清楚，后面的活都排在它后面
 *
 * 关键：**没有 agent 的需求也要进榜**。停了 5 天的澄清需求恰恰最该被推，
 * 而它在任何「按 agent 排」的视图里都是隐形的，所以第 3、4 档纯看需求状态。
 *
 * 只读、纯函数：输入需求与会话，输出排名与理由，便于单测断言。
 */
import type { Requirement, Session } from './db.ts'
import type { SessionStatus } from './threads.ts'

/** 带实时状态的会话。状态由 threads.withStatus 读 agent 落盘文件补上 */
export type RankableSession = Session & { status: SessionStatus }

/** 两级：现在就得动 / 有空再看 */
export type NextUpLevel = 'now' | 'soon'

export interface NextUpItem {
  /** 需求 slug（没有会话信号时，点开需求用） */
  slug: string
  project: string
  title: string
  /** 需求状态，界面上并排摆一枚小药丸 */
  status: string
  level: NextUpLevel
  /** 命中的档位，1 最硬、4 最软。前端不读，单测拿它断言顺序 */
  tier: number
  /** 一句话理由，中文 */
  reason: string
  /** 第二行的补充；没有则空串 */
  detail: string
  /** 命中的会话；没有会话信号时是 null，界面据此决定回会话还是开需求 */
  session: { agent: string; link: string } | null
}

export interface NextUpConfig {
  /** 同一档内的先后：p0 最靠前；没设优先级的排最后 */
  priorityRank: Record<string, number>
  /** 「停太久」的阈值（天）：没到这个天数就不推，免得刚进这栏就被催 */
  staleDays: { review: number; clarify: number }
}

export const DEFAULT_NEXT_UP_CONFIG: NextUpConfig = {
  priorityRank: { p0: 0, p1: 1, p2: 2, p3: 3 },
  staleDays: { review: 2, clarify: 2 },
}

/** 档位。数字越小越硬，排序从它开始 */
const TIER = { blocked: 1, agentUnread: 2, reviewStale: 3, clarifyStale: 4 } as const

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

const DAY_MS = 86_400_000

interface Candidate {
  item: NextUpItem
  priority: number
  /** 排序用的「等了多久」起点（epoch ms），小的（等得久的）在前 */
  since: number
}

/** 排名。按档位、档内优先级、等待时长、slug 依次定序，稳定可测 */
export function rankNextUp(
  requirements: readonly Requirement[],
  sessions: readonly RankableSession[],
  now: number = Date.now(),
  config: NextUpConfig = DEFAULT_NEXT_UP_CONFIG,
): NextUpItem[] {
  const byReq = new Map<string, RankableSession[]>()
  for (const s of sessions) {
    const list = byReq.get(s.requirementId)
    if (list) list.push(s)
    else byReq.set(s.requirementId, [s])
  }

  const candidates: Candidate[] = []
  for (const req of requirements) {
    const c = candidateOf(req, byReq.get(req.id) ?? [], now, config)
    if (c) candidates.push(c)
  }

  candidates.sort(
    (a, b) =>
      a.item.tier - b.item.tier ||
      a.priority - b.priority ||
      a.since - b.since ||
      a.item.slug.localeCompare(b.item.slug),
  )
  return candidates.map((c) => c.item)
}

function candidateOf(
  req: Requirement,
  sessions: RankableSession[],
  now: number,
  config: NextUpConfig,
): Candidate | null {
  // 已完成的不必再推
  if (req.status === '已完成') return null

  const priority = config.priorityRank[req.priority] ?? 9
  const signal = hardestSession(sessions)

  if (signal) {
    const { session } = signal
    const blocked = signal.tier === TIER.blocked
    const failed = session.status.state === 'failed'
    const label = AGENT_LABELS[session.agent] ?? session.agent
    return {
      priority,
      since: sinceOf(req, session),
      item: {
        ...identity(req),
        level: blocked ? 'now' : 'soon',
        tier: signal.tier,
        reason: blocked
          ? `${label} 卡住了`
          : failed
            ? `${label} 跑失败了没人看`
            : `${label} 跑完了没看`,
        detail: blocked
          ? session.status.needsAction
          : failed
            ? '上一轮跑失败了，结果还没人看。'
            : '上一轮已经结束，结果还没人验收。',
        session: { agent: session.agent, link: session.link },
      },
    }
  }

  // 没有会话信号的需求靠状态进榜——这一档才兜住「没有 agent 的需求」
  const days = daysSince(req.updated, now)
  if (req.status === 'Review' && days >= config.staleDays.review) {
    return {
      priority,
      since: sinceOf(req),
      item: {
        ...identity(req),
        level: 'soon',
        tier: TIER.reviewStale,
        reason: `Review 停了 ${days} 天`,
        detail: '代码在评审里没人动。',
        session: null,
      },
    }
  }
  if (req.status === '澄清' && days >= config.staleDays.clarify) {
    return {
      priority,
      since: sinceOf(req),
      item: {
        ...identity(req),
        level: 'soon',
        tier: TIER.clarifyStale,
        reason: `澄清停了 ${days} 天`,
        detail: '需求还没定清楚，后面的活都排在它后面。',
        session: null,
      },
    }
  }
  return null
}

/**
 * 一条需求挂多条会话时取最硬的那条。卡住不看已读——它一直停着，正是要人推的；
 * 跑完/跑失败只在**未读**（fresh）时算，看过了就不占版面。正在跑、读不到状态的不进榜。
 */
function hardestSession(
  sessions: readonly RankableSession[],
): { tier: number; session: RankableSession } | null {
  let best: { tier: number; session: RankableSession } | null = null
  for (const s of sessions) {
    const tier = sessionTier(s)
    if (tier !== null && (!best || tier < best.tier)) best = { tier, session: s }
  }
  return best
}

function sessionTier(s: RankableSession): number | null {
  if (s.status.state === 'blocked') return TIER.blocked
  if ((s.status.state === 'done' || s.status.state === 'failed') && s.status.fresh) {
    return TIER.agentUnread
  }
  return null
}

function identity(req: Requirement): Pick<NextUpItem, 'slug' | 'project' | 'title' | 'status'> {
  return { slug: req.slug, project: req.project, title: req.title, status: req.status }
}

/** 档内排序的起点：优先取会话状态时间，其次需求更新时间，最后文件修改时间 */
function sinceOf(req: Requirement, session?: RankableSession): number {
  const at = session ? parseLocalTime(session.status.at) : 0
  return at || parseLocalTime(req.updated) || req.mtime || 0
}

/** 从某个时间戳到今天过了几天（向下取整）。解析不出返回 -1，调用方据此不推 */
function daysSince(stamp: string, now: number): number {
  const t = parseLocalTime(stamp)
  return t ? Math.floor((now - t) / DAY_MS) : -1
}

/** 库里的本机时间戳：'yyyy-mm-dd' 或 'yyyy-mm-dd HH:mm'。解析不出返回 0 */
function parseLocalTime(stamp: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec((stamp ?? '').trim())
  if (!m) return 0
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)).getTime()
}
