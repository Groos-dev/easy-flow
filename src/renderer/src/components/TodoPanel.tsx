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
  const source = [todo.source, todo.channel].filter(Boolean).join(' · ')
  const timeline = `入库 ${todo.created} · 更新 ${todo.updated}`

  return (
    <div className="info-panel" role="dialog" aria-label="待办信息">
      <InfoBlock label="文件">
        <div className="info-row">
          <OneLine className="mono" text={todo.path} title={todo.path} />
          <CopyButton text={todo.path} label="路径" />
        </div>
      </InfoBlock>

      {/* 需求：没挂就整段不出现——空的一段不携带信息 */}
      {(req || todo.requirementId) && (
        <InfoBlock label="需求">
          {req ? (
            <div className="info-row">
              <OneLine
                className="info-link"
                text={req.title}
                title={`${req.project}/${req.slug}`}
                onClick={() => onOpenRequirement(req.project, req.slug)}
              />
              <CopyButton text={req.id} label="需求 id" />
            </div>
          ) : (
            // 挂了指针但库里查不到（需求被删了）：把 id 亮出来，不给一个点不开的链接
            <div className="info-row">
              <OneLine
                className="mono"
                text={todo.requirementId}
                title={`库里没有这条需求：${todo.requirementId}`}
              />
              <CopyButton text={todo.requirementId} label="需求 id" />
            </div>
          )}
        </InfoBlock>
      )}

      <InfoBlock label="来路">
        <div className="info-row">
          <span className="k">来源</span>
          <span className="v">{source || '（未记）'}</span>
        </div>
        {todo.origin && (
          <div className="info-row">
            <span className="k">来源人</span>
            <span className="v">{todo.origin}</span>
          </div>
        )}
        {todo.chat && (
          <div className="info-row">
            <span className="k">上下文</span>
            <span className="v">{todo.chat}</span>
          </div>
        )}
        {todo.session && (
          <div className="info-row">
            <span className="k">会话</span>
            <span className="v mono">{todo.session}</span>
            <CopyButton text={todo.session} label="会话" />
          </div>
        )}
        {todo.ref && (
          <div className="info-row">
            <span className="k">去重键</span>
            <span className="v mono">{todo.ref}</span>
            <CopyButton text={todo.ref} label="去重键" />
          </div>
        )}
        {todo.happened && (
          <div className="info-row">
            <span className="k">源事件时间</span>
            <span className="v">{todo.happened}</span>
          </div>
        )}
        <div className="info-row">
          <span className="k">时间线</span>
          <span className="v">{timeline}</span>
        </div>
      </InfoBlock>

      {todo.link && (
        <InfoBlock label="链接">
          <OneLine className="info-link" text={todo.link} title={todo.link} href={todo.link} />
        </InfoBlock>
      )}
    </div>
  )
}
