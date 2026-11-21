import { t as tr } from "../../../shared/i18n.ts"
import type { Requirement, Session } from './types'
import { isCodeLink, linkLabel } from './links'
import { isEventState, sessionActive } from './threads'
import { relTime } from './time'

export type MiniAction =
  | { key: string; kind: 'session'; project: string; slug: string; session: Session }
  | {
      key: string
      kind: 'more'
      project: string
      slug: string
      group: 'sessions' | 'links'
      remaining: number
      expanded: boolean
    }
  | {
      key: string
      kind: 'link'
      project: string
      slug: string
      url: string
      type: 'MR' | 'link'
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
  expandedSessions?: boolean
  expandedLinks?: boolean
}

export function miniTime(ms: number): string {
  if (!ms) return ''
  const ago = Date.now() - ms
  if (ago < 60000) return tr("Just now")
  if (ago < 3600000) return tr("{0} minutes ago", [Math.floor(ago / 60000)])
  if (ago < 86400000) return tr("{0} hours ago", [Math.floor(ago / 3600000)])
  return relTime(ms)
}

export function needsHuman(sessions: Session[]): boolean {
  return sessions.some((s) => isEventState(s.status.state))
}

export function miniSessionOpenable(session: Session): boolean {
  return !!session.link || (session.agent === 'cursor' && !!session.cwd)
}

export function miniSearchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function buildMiniBlocks({ rows, sessions, query, expanded, expandedSessions = false, expandedLinks = false }: MiniInput): MiniBlock[] {
  const words = miniSearchTokens(query)
  const byReq = new Map<string, Session[]>()
  for (const s of sessions) {
    const list = byReq.get(s.requirementId)
    if (list) list.push(s)
    else byReq.set(s.requirementId, [s])
  }

  return rows
    // TODO: 特殊逻辑 后面删除
    .filter(({ req }) => req.project !== 'self')
    .map(({ req, projectName }) => {
      const ss = [...(byReq.get(req.id) ?? [])].sort(
        (a, b) => Number(isEventState(b.status.state)) - Number(isEventState(a.status.state))
          || sessionActive(b) - sessionActive(a),
      )
      return {
        key: `${req.project}:${req.slug}`,
        req,
        projectName,
        sessions: ss,
        active: ss.reduce((t, s) => Math.max(t, sessionActive(s)), req.mtime),
        needsHuman: needsHuman(ss),
      }
    })
    .filter(({ req, projectName }) =>
      words.every((word) =>
        `${req.title} ${req.slug} ${req.summary} ${projectName}`.toLowerCase().includes(word),
      ),
    )
    .sort((a, b) => {
      if (a.needsHuman !== b.needsHuman) return a.needsHuman ? -1 : 1
      return b.active - a.active
    })
    .map((block) => ({
      ...block,
      children: expanded === block.key ? actionsOf(block, expandedSessions, expandedLinks) : [],
    }))
}

function actionsOf(block: Omit<MiniBlock, 'children'>, expandedSessions: boolean, expandedLinks: boolean): MiniAction[] {
  const { key, req, sessions } = block
  const sessionLimit = Math.max(2, sessions.filter((s) => isEventState(s.status.state)).length)
  const sessionMore: MiniAction[] = sessions.length > sessionLimit ? [{
    key: `${key}|more|sessions`, kind: 'more', project: req.project, slug: req.slug,
    group: 'sessions', remaining: sessions.length - sessionLimit, expanded: expandedSessions,
  }] : []
  const linkMore: MiniAction[] = req.linkItems.length > 2 ? [{
    key: `${key}|more|links`, kind: 'more', project: req.project, slug: req.slug,
    group: 'links', remaining: req.linkItems.length - 2, expanded: expandedLinks,
  }] : []
  return [
    ...sessionMore,
    ...(expandedSessions ? sessions : sessions.slice(0, sessionLimit)).map((s) => ({
      key: `${key}|s|${s.agent}|${s.session}`,
      kind: 'session' as const,
      project: req.project,
      slug: req.slug,
      session: s,
    })),
    ...linkMore,
    ...(expandedLinks ? req.linkItems : req.linkItems.slice(0, 2)).map((l) => ({
      key: `${key}|link|${l.url}`,
      kind: 'link' as const,
      project: req.project,
      slug: req.slug,
      url: l.url,
      type: isCodeLink(l.url) ? ('MR' as const) : ('link' as const),
      value: linkLabel(l),
    })),
  ]
}
