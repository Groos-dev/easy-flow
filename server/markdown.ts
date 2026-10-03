/**
 * markdown 解析工具。被数据层（同步 md → sqlite）和 HTTP 层共用。
 * 这里只负责"读懂文件"，不持有任何状态。
 */
import { existsSync, readdirSync, statSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 单文件索引上限：超出只索引前 N 字节，避免大文档拖垮内存 */
const MAX_DOC_BYTES = 64 * 1024
/** 单需求索引总量上限 */
const MAX_REQ_BYTES = 512 * 1024

export interface Frontmatter {
  data: Record<string, string>
  body: string
}

export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const raw = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\s*\n/, '')
  const data: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    data[m[1]] = v
  }
  return { data, body }
}


// --------------------------------------------------------------------- 正文解析

export function section(body: string, heading: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}\\s*$`).test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

function sectionAny(body: string, headings: readonly string[]): string {
  for (const h of headings) {
    const text = section(body, h)
    if (text) return text
  }
  return ''
}

/**
 * 标题别名。历史需求的中英文标题不统一（「需求」/「需求摘要」/「Requirement summary」），
 * 这里做归一化，避免解析漏项。
 */
const HEADINGS = {
  summary: ['需求', '需求摘要', '需求概述', '任务范围', 'Requirement summary', 'Summary'],
  repos: ['涉及仓库', '仓库与软链', '仓库映射', '仓库关系', '仓库', 'Repos and symlinks', 'Repos'],
  links: ['链接', '相关链接', '参考链接', '文档索引', 'Doc index', 'Links'],
} as const

function firstParagraph(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('-') && !l.startsWith('|') && !l.startsWith('#'))
  return line ? line.replace(/\*\*/g, '').slice(0, 160) : ''
}

/** 摘要兜底：早期需求没有标准「需求」段，取 H1 之后的第一个非空段落 */
function fallbackSummary(body: string): string {
  const withoutH1 = body.replace(/^#\s.*$/m, '')
  for (const block of withoutH1.split(/\n\s*\n/)) {
    const text = block.trim()
    if (!text || text.startsWith('#') || text.startsWith('|') || text.startsWith('-')) continue
    return firstParagraph(text)
  }
  return ''
}

export interface RepoRef {
  short: string
  repo?: string
}

function parseRepos(body: string): RepoRef[] {
  const block = sectionAny(body, HEADINGS.repos)
  const repos: RepoRef[] = []
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (!cells.length) continue
    const [short, repo] = cells
    if (!short || /^-+$/.test(short)) continue
    if (/^(短名|short|short name|name)$/i.test(short)) continue
    repos.push({ short, repo })
  }
  return repos
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => !e.startsWith('.'))
  } catch {
    return []
  }
}

export interface DocFile {
  name: string
  content: string
  /** 文件真实修改时间（毫秒）。用于排序"最近动过的需求优先" */
  mtime: number
}

/**
 * 递归收集需求目录下所有 markdown。
 *
 * 排除三类：
 *   符号链接 —— 需求目录里的仓库软链指向整个代码仓，跟进去会把无关文档全索引进来
 *   指令文件 —— AGENTS.md / CLAUDE.md 是约束 agent 的规则，不是需求内容，
 *               不管在哪一层都不收（只排根级那个是不够的）
 *   子需求目录 —— 它自己是一份需求，文件归它自己；下探会让父需求的标签栏里
 *                 冒出一堆别人的 AGENTS.md
 */
export function readDocs(dir: string): DocFile[] {
  const out: DocFile[] = []
  let total = 0
  const walk = (d: string, prefix: string): void => {
    for (const entry of entries(d)) {
      if (total >= MAX_REQ_BYTES) return
      const p = join(d, entry)
      const rel = prefix ? `${prefix}/${entry}` : entry
      try {
        const lst = lstatSync(p)
        if (lst.isSymbolicLink()) continue
        if (lst.isDirectory()) {
          if (!isRequirementDir(p)) walk(p, rel)
          continue
        }
        if (!entry.endsWith('.md')) continue
        if (entry === 'AGENTS.md' || entry === 'CLAUDE.md') continue

        let content = readFileSync(p, 'utf8')
        if (content.length > MAX_DOC_BYTES) content = content.slice(0, MAX_DOC_BYTES)
        out.push({ name: rel, content, mtime: lst.mtimeMs })
        total += content.length
      } catch {
        /* 忽略读不到的条目 */
      }
    }
  }
  walk(dir, '')
  return out
}

export interface ParsedRequirement {
  /** 不透明 id，写在 AGENTS.md 的 frontmatter 里。老需求可能还没有 */
  id: string
  slug: string
  title: string
  /** 从正文推导的摘要，用于卡片展示 */
  summary: string
  repos: RepoRef[]
  links: string
  docs: DocFile[]
}

/**
 * 解析一个需求目录。状态不在这里——状态归 sqlite 管。
 *
 * 身份（id）读 AGENTS.md 的 frontmatter，卡片用的标题/摘要/仓库/链接读 requirement.md。
 * AGENTS.md 放 agent 指令，requirement.md 放需求描述；两者齐备才算需求
 * （见 listRequirementDirs），所以这里可以放心直接读。
 */
export function parseRequirement(dir: string, fallbackSlug: string): ParsedRequirement {
  const desc = parseFrontmatter(readFileSync(join(dir, 'requirement.md'), 'utf8'))
  const { data: identity } = parseFrontmatter(readFileSync(join(dir, 'AGENTS.md'), 'utf8'))

  const docs = readDocs(dir)
  const h1 = /^#\s+(.+)$/m.exec(desc.body)?.[1]?.trim()

  return {
    id: identity.id || '',
    slug: identity.slug || fallbackSlug,
    title: desc.data.title || h1 || fallbackSlug,
    summary: firstParagraph(sectionAny(desc.body, HEADINGS.summary)) || fallbackSummary(desc.body),
    repos: parseRepos(desc.body),
    links: sectionAny(desc.body, HEADINGS.links),
    docs,
  }
}

/** 需求目录的判据：AGENTS.md（agent 指令）与 requirement.md（需求描述）都在 */
function isRequirementDir(dir: string): boolean {
  return existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'requirement.md'))
}

/**
 * 列出 root 下文件齐备的直接子目录（需求目录）。
 * 软链不算：工位里的软链指向代码仓 worktree，而 worktree 里也会有需求文档，
 * 跟随进去就会把同一个需求认成两个。
 */
export function listRequirementDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return entries(root)
    .map((e) => join(root, e))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && !lstatSync(p).isSymbolicLink() && isRequirementDir(p)
      } catch {
        return false
      }
    })
}

/**
 * 数据目录结构：<dataDir>/<project>/<requirement>/
 *
 * 项目是虚拟概念——不一定对应代码仓，可以在这里放该项目的总规范
 * （约定为项目根目录下的 AGENTS.md，内容格式不限定）。
 */
export interface ProjectDir {
  slug: string
  root: string
}

/**
 * 列出所有项目目录。
 * 跳过下划线开头的目录（约定为存放非项目内容的收纳处，如 _inbox）；
 * 其余不含 AGENTS.md 的子目录也算项目——项目可以只放规范文件。
 */
export function listProjectDirs(dataDir: string): ProjectDir[] {
  if (!existsSync(dataDir)) return []
  return entries(dataDir)
    .filter((e) => !e.startsWith('_'))
    .map((e) => ({ slug: e, root: join(dataDir, e) }))
    .filter(({ root }) => {
      try {
        return statSync(root).isDirectory() && !lstatSync(root).isSymbolicLink()
      } catch {
        return false
      }
    })
}

/** 列出某个项目下的需求目录 */
export function listRequirementsIn(projectRoot: string): string[] {
  return listRequirementDirs(projectRoot)
}

/**
 * 列出 root 下"看着像需求、文件却不齐"的直接子目录。
 * 文件不齐就不会被识别成需求，只能在这里露面——仅供提示，不做任何过滤。
 * 跳过下划线开头的目录：那是约定的收纳处（如 _inbox），不是漏建的需求。
 */
export function listStrayDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return entries(root)
    .filter((e) => !e.startsWith('_'))
    .filter((e) => {
      const p = join(root, e)
      try {
        return statSync(p).isDirectory() && !isRequirementDir(p)
      } catch {
        return false
      }
    })
}

/** 读取项目级规范文件（约定为项目根目录的 AGENTS.md），不存在则返回 null */
export function readProjectConvention(projectRoot: string): string | null {
  const file = join(projectRoot, 'AGENTS.md')
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
