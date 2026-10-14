import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import { AGENT_LABELS, THREAD_STATE_CLASS, THREAD_STATE_LABEL } from '../lib/labels'
import { codeLinkLabel } from '../lib/links'
import { isEventState } from '../lib/threads'
import { TODO_STATUS_LABEL, type ContextPayload, type Requirement } from '../lib/types'
import { CopyButton, InfoBlock, OneLine } from './InfoBits'
import LaunchSession from './LaunchSession'

/**
 * 需求详情页的头部浮窗：目录、工作区、会话、关联待办与链接。零件见 InfoBits，与待办的 TodoPanel 共用。
 *
 * 工作区、会话与关联待办来自详情页已加载的 /api/context；打开浮窗本身不发请求，
 * 展开新会话入口时才按需读取 provider 列表。关系存在 sqlite 里。
 */
export default function InfoPanel({
  req,
  ctx,
  onOpenTodo,
}: {
  req: Requirement
  ctx: ContextPayload | null
  /** 点一条关联待办即在详情页打开它 */
  onOpenTodo: (id: string) => void
}) {
  const worktrees = ctx?.worktrees ?? []
  const sessions = ctx?.sessions ?? []
  // 只列未完成的：已完成 / 已取消的不占版面
  const openTodos = (ctx?.todos ?? []).filter((t) => t.status === 'todo' || t.status === 'in_progress')

  const groups = [
    { title: '飞书任务', items: req.feishuTaskLinks.map((url) => ({ label: url, url })) },
    { title: '代码链接', items: req.codeLinks.map((l) => ({ label: codeLinkLabel(l), url: l.url })) },
    { title: '扩展链接', items: req.extLinks.map((l) => ({ label: l.detail, url: l.url })) },
  ].filter((g) => g.items.length)

  // md 里的那段（解析器把「链接」「相关链接」「文档索引」都收了进来）。
  // 但「文档索引」常常只是一张文件/内容表——那是文档清单，文档标签栏已经有了，
  // 不该冒充链接：整段里一个 http 都没有就不展示。
  const mdLinks = /https?:\/\//i.test(req.links) ? req.links : ''

  return (
    <div className="info-panel" role="dialog" aria-label="需求信息与链接">
      <InfoBlock label="目录">
        <div className="info-row">
          <OneLine
            className="info-path mono"
            text={req.path}
            title={req.path}
            onClick={() => void api.open(req.slug, req.project).catch(() => {})}
          />
          <CopyButton text={req.path} label="路径" />
        </div>
      </InfoBlock>

      {/* 没有工作区就整段不出现——空列表本身不携带信息 */}
      {worktrees.length > 0 && (
        <InfoBlock label="worktree" count={worktrees.length}>
          {worktrees.map((w) => (
            <div className="wt" key={w.id}>
              <div className="wt-head">
                <span className="v mono">{w.repo}</span>
                {w.missing && <span className="wt-missing">目录已失联</span>}
                <span className="spacer" />
                <CopyButton text={w.path} label="路径" />
              </div>
              <div className="wt-meta">
                <OneLine className="mono" text={w.branch} title={w.branch} />
              </div>
              <OneLine
                className="info-path mono"
                text={w.path}
                title={w.missing ? `目录已失联：${w.path}` : w.path}
                disabled={w.missing}
                onClick={() => void api.openWorktree(w.id).catch(() => {})}
              />
            </div>
          ))}
        </InfoBlock>
      )}

      {/* ctx 未到时不能把空列表误当成需求没有工作区 */}
      {ctx && (
        <InfoBlock label="会话" count={sessions.length}>
          {/* 新会话入口与已有会话放在一起，工作区选择和登记结果都能就近核对 */}
          <LaunchSession req={req} worktrees={worktrees} />
          {/* 有 deeplink 的点一行就回到原会话；新会话入口不碰已有回跳 */}
          {sessions.map((s) => {
            // 已读的事件不再占位：卡片角标已经消失，这里再挂一行「需要人介入」只会让人
            // 以为还没处理。正在跑不是事件、unknown 是读不到，都照常显示。
            const showState = !isEventState(s.status.state) || s.status.fresh
            return (
              <div className="wt" key={`${s.agent}:${s.session}`}>
                <div className="wt-head">
                  <span className="v">{AGENT_LABELS[s.agent] ?? s.agent}</span>
                  {showState && (
                    <>
                      {/* 状态是读 agent 应用的落盘文件得来的，hover 看判据出处 */}
                      <span
                        className={`thread-dot ${THREAD_STATE_CLASS[s.status.state] ?? ''}`}
                        title={`${s.status.detail}${s.status.at ? ` · ${s.status.at}` : ''}`}
                      />
                      <span className="thread-state">
                        {THREAD_STATE_LABEL[s.status.state] ?? s.status.state}
                      </span>
                      {/* 未读才是角标亮的原因；这里标出来，好让人对上卡片上的那个 */}
                      {s.status.fresh && (
                        <span className="thread-unread">未读</span>
                      )}
                    </>
                  )}
                  <span className="spacer" />
                  <CopyButton text={s.session} label="会话 id" />
                </div>
                {/* 需要人介入时把那句话原文摆出来——看板上就能答，不用先进应用 */}
                {showState && s.status.needsAction && (
                  <OneLine className="thread-need" text={s.status.needsAction} title={s.status.needsAction} />
                )}
                {s.title && (
                  <div className="wt-meta">
                    <OneLine className="" text={s.title} title={s.title} />
                  </div>
                )}
                <OneLine
                  className={`mono ${s.link ? 'info-path' : 'info-path disabled'}`}
                  text={s.session}
                  title={s.link ? `在 ${AGENT_LABELS[s.agent] ?? s.agent} 里打开：${s.link}` : s.session}
                  href={s.link || undefined}
                />
                {s.cwd && <OneLine className="wt-meta mono" text={s.cwd} title={s.cwd} />}
              </div>
            )
          })}
        </InfoBlock>
      )}

      {/* 关联待办：立项时在 todo 侧登记的指针反查出来的。只列未完成的，颜色区分状态 */}
      {openTodos.length > 0 && (
        <InfoBlock label="关联待办" count={openTodos.length}>
          {openTodos.map((t) => {
            const label = TODO_STATUS_LABEL[t.status] ?? t.status
            return (
              <div className="wt" key={t.id}>
                <div className="wt-head">
                  <span className="todo-dot" data-status={t.status} title={label} />
                  <span className="v">{label}</span>
                  <span className="spacer" />
                  <span className="wt-meta mono">{t.id}</span>
                </div>
                <OneLine className="" text={t.title} title={t.title} onClick={() => onOpenTodo(t.id)} />
              </div>
            )
          })}
        </InfoBlock>
      )}

      {(groups.length > 0 || mdLinks) && (
        <InfoBlock
          label="链接"
          count={groups.reduce((n, g) => n + g.items.length, 0) + (mdLinks ? 1 : 0)}
        >
          {groups.map((g) => (
            <div className="info-row" key={g.title}>
              <span className="k">{g.title}</span>
              <span className="v">
                {g.items.map((it) => (
                  <OneLine
                    key={it.url}
                    className="info-link"
                    text={it.label}
                    title={it.url}
                    href={it.url}
                  />
                ))}
              </span>
            </div>
          ))}
          {mdLinks && (
            <article className="markdown-body info-md">
              {/* 外链必须带 target：不带的话会在应用窗口里直接跳走 */}
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{ a: (props) => <a href={props.href} target="_blank" rel="noreferrer">{props.children}</a> }}
              >
                {mdLinks}
              </Markdown>
            </article>
          )}
        </InfoBlock>
      )}
    </div>
  )
}
