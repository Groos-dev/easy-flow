// 链接的纯函数：命令行与看板共用一份口径，免得同一件事在两处各写一遍

export interface CodeLinkRef {
  kind: 'gitlab' | 'github'
  host: string
  project: string
  iid: string
}

// GitLab MR / GitHub PR 的地址形态。状态查询与图标都认这一条
export function parseCodeLink(url: string): CodeLinkRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // host 会原样进 glab 的 --hostname，别让一个以 - 开头的串被当成参数
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i.test(parsed.host)) return null

  const gitlab = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(parsed.pathname)
  if (gitlab) {
    return { kind: 'gitlab', host: parsed.host, project: gitlab[1], iid: gitlab[2] }
  }

  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null
  // owner/repo 会拼进 gh 的 API 路径，不允许点段与转义字符
  const github = /^\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/pull\/(\d+)\/?$/i.exec(parsed.pathname)
  if (github && github[1] !== '.' && github[1] !== '..' && github[2] !== '.' && github[2] !== '..') {
    return { kind: 'github', host: parsed.host, project: `${github[1]}/${github[2]}`, iid: github[3] }
  }
  return null
}

// 迷你面板用它决定合并请求图标
export function isCodeLink(url: string): boolean {
  return parseCodeLink(url) !== null
}

// 飞书 / Lark 的域名。这几种链接的短名取域名后的整段路径，才认得出是哪个任务
const FEISHU_HOST = /(^|\.)(feishu\.cn|larkenterprise\.com|larksuite\.com)$/i

/**
 * 一条链接的展示短名。
 * 有标题就用标题；没有标题就从地址推一个——整条地址又长又全一样，扫不出是哪条。
 * GitLab 出「<仓库> !<编号>」。
 * GitHub 出「<仓库> #<编号>」。
 * 飞书 / Lark 出域名后的路径，去掉详情页的 /detail 段。
 * 其余取路径末段，没有路径就用域名。
 * 同一条需求的几条链接前缀往往一样，短名字才分得清哪条是哪个仓库。
 */
export function linkLabel(link: { title: string; url: string }): string {
  if (link.title) return link.title

  const ref = parseCodeLink(link.url)
  if (ref) {
    const repo = ref.project.split('/').pop() ?? ref.project
    return `${repo} ${ref.kind === 'gitlab' ? '!' : '#'}${ref.iid}`
  }

  let parsed: URL
  try {
    parsed = new URL(link.url)
  } catch {
    return link.url
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  if (!path) return parsed.hostname || link.url

  if (FEISHU_HOST.test(parsed.hostname)) {
    return path.replace(/^\//, '').replace(/\/detail(?=\/|$)/i, '')
  }
  return path.slice(path.lastIndexOf('/') + 1) || parsed.hostname || link.url
}
