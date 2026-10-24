import type { CodeLink, CodeLinkStatus, PipelineState } from './types'

// 流水线汇总的图标：够小，跟状态列并排不抢戏
export const PIPELINE_ICON: Record<PipelineState, string> = {
  success: '✓',
  failed: '✕',
  running: '◔',
  skipped: '–',
}

// hover 用中文说清楚到哪一步，图标本身认不出来
export const PIPELINE_LABEL: Record<PipelineState, string> = {
  success: '通过',
  failed: '失败',
  running: '进行中或等待手动执行',
  skipped: '已取消或跳过',
}

// 合入/关闭的 MR 再看流水线是历史噪音，只有还开着的才带
export function showsPipeline(status: CodeLinkStatus): boolean {
  return status.state === 'open' && status.pipeline !== null
}

/**
 * 代码链接显示什么：显式别名优先，没给就从 URL 推一个。
 * 推的时候认两种常见形态——GitLab MR 出 "<仓库> !<iid>"，GitHub PR 出 "<仓库> #<iid>"；
 * 其余取路径末段。同一条需求的几条链接前缀往往一样，短名字才分得清哪条是哪个仓库。
 */
export function codeLinkLabel(link: CodeLink): string {
  if (link.label) return link.label

  const gitlab = /\/([^/]+)\/-\/merge_requests\/(\d+)/.exec(link.url)
  if (gitlab) return `${gitlab[1]} !${gitlab[2]}`

  const github = /\/([^/]+)\/pull\/(\d+)/.exec(link.url)
  if (github) return `${github[1]} #${github[2]}`

  const path = link.url.replace(/[?#].*$/, '').replace(/\/+$/, '')
  return path.slice(path.lastIndexOf('/') + 1) || link.url
}

/**
 * 飞书任务链接显示什么：整条 URL 摆在浮窗里又长又全一样，扫不出是哪条。
 * 取域名之后的路径，并把详情页用的 /detail 段去掉（`/onex/story/detail/123` → `onex/story/123`）。
 */
export function feishuTaskLabel(url: string): string {
  const path = url
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\/detail(?=\/|$)/i, '')
    .replace(/^\//, '')
  return path || url
}
