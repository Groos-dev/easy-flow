import type { Requirement, Session } from './types'
import { codeLinkLabel, feishuTaskLabel } from './links'
import { isEventState } from './threads'
import { parseStamp, relTime } from './time'

const VISIBLE_STATUS = new Set(['执行中', 'Review'])

export type MiniAction =
  | { key: string; kind: 'detail'; project: string; slug: string }
  | { key: string; kind: 'session'; project: string; slug: string; session: Session }
  | {
      key: string
      kind: 'link'
      project: string
      slug: string
      url: string
      type: 'MR' | '链接'
      value: string
    }

export interface MiniBlock {
  key: string
  req: Requirement
  projectName: string
  sessions: Session[]
  active: number
  needsHuman: boolean
  children: MiniAction[]
}

export interface MiniRow {
  req: Requirement
  projectName: string
}

export interface MiniInput {
  rows: MiniRow[]
  sessions: Session[]
  query: string
  expanded: string
}

// hook 推送、拉取、点 pet 都写 observed_at；没观察过的会话退回登记时间
export function sessionActive(s: Session): number {
  return Math.max(s.status.observedAt, parseStamp(s.updated))
}

export function miniTime(ms: number): string {
  if (!ms) return ''
  const ago = Date.now() - ms
  if (ago < 60000) return '刚刚'
  if (ago < 3600000) return `${Math.floor(ago / 60000)} 分钟前`
  if (ago < 86400000) return `${Math.floor(ago / 3600000)} 小时前`
  return relTime(ms)
}

export function needsHuman(sessions: Session[]): boolean {
  return sessions.some((s) => isEventState(s.status.state))
}

function latestEvent(sessions: Session[]): number {
  return sessions.reduce(
    (t, s) => (isEventState(s.status.state) ? Math.max(t, s.status.observedAt) : t),
    0,
  )
}

export function buildMiniBlocks({ rows, sessions, query, expanded }: MiniInput): MiniBlock[] {
  const q = query.trim().toLowerCase()
  const byReq = new Map<string, Session[]>()
  for (const s of sessions) {
    const list = byReq.get(s.requirementId)
    if (list) list.push(s)
    else byReq.set(s.requirementId, [s])
  }

  return rows
    .map(({ req, projectName }) => {
      const ss = [...(byReq.get(req.id) ?? [])].sort((a, b) => sessionActive(b) - sessionActive(a))
      return {
        key: `${req.project}:${req.slug}`,
        req,
        projectName,
        sessions: ss,
        active: ss.reduce((t, s) => Math.max(t, sessionActive(s)), req.mtime),
        needsHuman: needsHuman(ss),
        eventAt: latestEvent(ss),
      }
    })
    // 有过滤词就穿透状态过滤：刚合入的需求也该搜得到
    .filter(({ req, projectName }) =>
      q
        ? `${req.title} ${req.slug} ${req.summary} ${projectName}`.toLowerCase().includes(q)
        : VISIBLE_STATUS.has(req.status),
    )
    .sort((a, b) => {
      if (a.needsHuman !== b.needsHuman) return a.needsHuman ? -1 : 1
      return a.needsHuman ? b.eventAt - a.eventAt : b.active - a.active
    })
    .map(({ eventAt: _eventAt, ...block }) => ({
      ...block,
      children: expanded === block.key ? actionsOf(block) : [],
    }))
}

function actionsOf(block: Omit<MiniBlock, 'children'>): MiniAction[] {
  const { key, req, sessions } = block
  return [
    { key: `${key}|detail`, kind: 'detail', project: req.project, slug: req.slug },
    ...sessions.map((s) => ({
      key: `${key}|s|${s.agent}|${s.session}`,
      kind: 'session' as const,
      project: req.project,
      slug: req.slug,
      session: s,
    })),
    ...req.codeLinks.map((l) => ({
      key: `${key}|mr|${l.url}`,
      kind: 'link' as const,
      project: req.project,
      slug: req.slug,
      url: l.url,
      type: 'MR' as const,
      value: codeLinkLabel(l),
    })),
    ...req.feishuTaskLinks.map((url) => ({
      key: `${key}|fs|${url}`,
      kind: 'link' as const,
      project: req.project,
      slug: req.slug,
      url,
      type: '链接' as const,
      value: feishuTaskLabel(url),
    })),
    ...req.extLinks.map((l) => ({
      key: `${key}|ext|${l.url}`,
      kind: 'link' as const,
      project: req.project,
      slug: req.slug,
      url: l.url,
      type: '链接' as const,
      value: l.detail || l.url,
    })),
  ]
}
