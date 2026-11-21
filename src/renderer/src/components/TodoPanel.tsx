import { todoSourceLabel } from '../../../shared/i18n.ts'
import { useLanguage } from '../lib/language'
import { t as tr } from "../../../shared/i18n.ts"
import type { Requirement, Todo } from '../lib/types'
import { CopyButton, InfoBlock, OneLine } from './InfoBits'

/**
 * 待办详情页的头部浮窗：与需求的 InfoPanel 同一套交互与零件。
 *
 * 这里只放元数据——文件在哪、挂在哪条需求上、从哪来、链接与时间线。
 * 内容（标题、摘要、进度）仍在正文那份 md 里，两边不重复。
 */
export default function TodoPanel({
  todo,
  req,
  onOpenRequirement,
}: {
  todo: Todo
  // 这条待办挂的需求；查不到（没挂 / 需求没了）时为 null
  req: Requirement | null
  onOpenRequirement: (project: string, slug: string) => void
}) {
  useLanguage()
  const channel = todo.channel === 'at_me' ? tr('Mentioned me') : todo.channel === 'p2p' ? tr('Direct message') : todo.channel
  const source = [todoSourceLabel(todo.source), channel].filter(Boolean).join(' · ')
  const timeline = tr("Created {0} · Updated {1}", [todo.created, todo.updated])

  return (
    <div className="info-panel" role="dialog" aria-label={tr("Todo details")}>
      <InfoBlock label={tr("File")}>
        <div className="info-row">
          <OneLine className="mono" text={todo.path} title={todo.path} />
          <CopyButton text={todo.path} label={tr("Path")} />
        </div>
      </InfoBlock>

      {/* 需求：没挂就整段不出现——空的一段不携带信息 */}
      {(req || todo.requirementId) && (
        <InfoBlock label={tr("Requirements")}>
          {req ? (
            <div className="info-row">
              <OneLine
                className="info-link"
                text={req.title}
                title={`${req.project}/${req.slug}`}
                onClick={() => onOpenRequirement(req.project, req.slug)}
              />
              <CopyButton text={req.id} label={tr("Requirement ID")} />
            </div>
          ) : (
            // 挂了指针但库里查不到（需求被删了）：把 id 亮出来，不给一个点不开的链接
            <div className="info-row">
              <OneLine
                className="mono"
                text={todo.requirementId}
                title={tr("Requirement not found in the database: {0}", [todo.requirementId])}
              />
              <CopyButton text={todo.requirementId} label={tr("Requirement ID")} />
            </div>
          )}
        </InfoBlock>
      )}

      <InfoBlock label={tr("Origin")}>
        <div className="info-row">
          <span className="k">{tr("Source")}</span>
          <span className="v">{source || tr("(not recorded)")}</span>
        </div>
        {todo.origin && (
          <div className="info-row">
            <span className="k">{tr("Sender")}</span>
            <span className="v">{todo.origin}</span>
          </div>
        )}
        {todo.chat && (
          <div className="info-row">
            <span className="k">{tr("Context")}</span>
            <span className="v">{todo.chat}</span>
          </div>
        )}
        {todo.session && (
          <div className="info-row">
            <span className="k">{tr("Sessions")}</span>
            <span className="v mono">{todo.session}</span>
            <CopyButton text={todo.session} label={tr("Sessions")} />
          </div>
        )}
        {todo.ref && (
          <div className="info-row">
            <span className="k">{tr("Deduplication key")}</span>
            <span className="v mono">{todo.ref}</span>
            <CopyButton text={todo.ref} label={tr("Deduplication key")} />
          </div>
        )}
        {todo.happened && (
          <div className="info-row">
            <span className="k">{tr("Source event time")}</span>
            <span className="v">{todo.happened}</span>
          </div>
        )}
        <div className="info-row">
          <span className="k">{tr("Timeline")}</span>
          <span className="v">{timeline}</span>
        </div>
      </InfoBlock>

      {todo.link && (
        <InfoBlock label={tr("Links")}>
          <OneLine className="info-link" text={todo.link} title={todo.link} href={todo.link} />
        </InfoBlock>
      )}
    </div>
  )
}
