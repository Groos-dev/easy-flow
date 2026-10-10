import type { CodeLink } from './types'

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
