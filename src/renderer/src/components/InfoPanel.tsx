import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import type { ContextPayload, Requirement } from '../lib/types'
import { CheckIcon, CopyIcon } from './icons'

/**
 * 浮窗里的一段：标题行点一下收起/展开，右边跟一个计数。
 * 默认展开——浮窗的作用就是一眼看到东西，收起是内容多了之后的减法。
 */
function InfoBlock({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="info-block">
      <button className="info-block-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="info-block-label">{label}</span>
        {count !== undefined && <span className="info-count">· {count}</span>}
        <svg
          className={`info-caret${open ? ' open' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {open && <div className="info-block-body">{children}</div>}
    </section>
  )
}

/**
 * 长文本一律占一行：放不下就截断成省略号，完整内容挂在 title 上，
 * 悬停时由系统提示给出（原生行为，够用且不额外占地方）。
 * 传了 href 就当外链渲染（新窗口打开），传了 onClick 就是可点的一行。
 */
function OneLine(props: {
  text: string
  className: string
  title?: string
  href?: string
  disabled?: boolean
  onClick?: () => void
}) {
  const cls = `line ${props.className}${props.disabled ? ' disabled' : ''}`

  if (props.href) {
    return (
      <a className={cls} href={props.href} target="_blank" rel="noreferrer" title={props.title}>
        {props.text}
      </a>
    )
  }

  const clickable = !!props.onClick && !props.disabled
  return (
    <div
      className={cls}
      title={props.title}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? props.onClick : undefined}
      onKeyDown={(e) => {
        if (clickable && e.key === 'Enter') props.onClick?.()
      }}
    >
      {props.text}
    </div>
  )
}

/**
 * 头部浮窗：需求的工作区与链接。
 *
 * 数据全部来自详情页已经拉过的两份载荷（列表里的 Requirement + /api/context），
 * 所以打开它不产生新请求。工作区那段只有服务端知道——归属存在 sqlite 里。
 */
export default function InfoPanel({ req, ctx }: { req: Requirement; ctx: ContextPayload | null }) {
  const [copied, setCopied] = useState('')
  const worktrees = ctx?.worktrees ?? []

  /** 复制到剪贴板。失败就什么也不说，别谎报"已复制" */
  function copy(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(text)
        setTimeout(() => setCopied(''), 1200)
      })
      .catch(() => {})
  }

  /** 复制按钮：图标按钮，复制成功后短暂变勾 */
  const copyButton = (text: string, label: string) => (
    <button
      className="info-action"
      onClick={() => copy(text)}
      title={`复制${label}`}
      aria-label={`复制${label}`}
    >
      {copied === text ? <CheckIcon /> : <CopyIcon />}
    </button>
  )

  const groups = [
    { title: '飞书任务', items: req.feishuTaskLinks.map((url) => ({ label: url, url })) },
    { title: '代码链接', items: req.codeLinks.map((url) => ({ label: url, url })) },
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
          {copyButton(req.path, '路径')}
        </div>
      </InfoBlock>

      {/* 没有工作区就整段不出现——空列表本身不携带信息 */}
      {worktrees.length > 0 && (
        <InfoBlock label="worktree" count={worktrees.length}>
          {worktrees.map((w) => (
            <div className="wt" key={w.id}>
              <div className="wt-head">
                <span className="v mono">{w.repo}</span>
                {w.orphan && <span className="wt-orphan">目录已失联</span>}
                <span className="spacer" />
                {copyButton(w.path, '路径')}
              </div>
              <div className="wt-meta">
                <OneLine className="mono" text={w.branch} title={w.branch} />
              </div>
              <OneLine
                className="info-path mono"
                text={w.path}
                title={w.orphan ? `目录已失联：${w.path}` : w.path}
                disabled={w.orphan}
                onClick={() => void api.openWorktree(w.id).catch(() => {})}
              />
            </div>
          ))}
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
