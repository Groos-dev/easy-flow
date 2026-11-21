import { getLanguage, Language } from '../src/shared/i18n.ts'
import { t as tr } from "../src/shared/i18n.ts"
/**
 * 目录规范与模板。
 *
 * 项目与需求都由 agent 直接在文件系统里建目录，应用不提供创建入口。
 * 这里只做两件事：把模板补到 <dataDir>/_templates/ 下，以及只读地报告目录哪里不合规范。
 * 规范问题只用于 UI 提示：不拦截操作、不改状态、不过滤列表。
 *
 * 看板列（状态）、优先级与结构化链接（飞书任务 / MR / 扩展链接）只存在 easy-flow.db 里，
 * 不要在 md 里维护它们；requirement.md 的「链接」段是自由文本，会被读出来当展示用。
 * 规范与模板只描述文件结构。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { TODOS_DIR, listStrayDirs, parseFrontmatter, readProjectConvention } from './markdown.ts'

// 收纳目录。下划线开头，listProjectDirs 不会把它当成项目
export const TEMPLATES_DIR = '_templates'

function templatesDir(dataDir: string): string {
  return join(dataDir, TEMPLATES_DIR)
}

// 原来的创建入口在这里做过校验，入口移除后只用于提示
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// 写进单行结构的值先把换行压平，否则会把 frontmatter 和 H1 写坏
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 标题是不是把目录名原样抄了一遍。
 *
 * 看板卡片上能扫的只有标题，抄目录名等于没说「在做什么」——建需求时拦掉这一类。
 * 只逐字比，不做大小写与连字符的归一：英文短句标题推出来的目录名天然带连字符，
 * 一并归一的话「Retry seat issue on 1A timeout」这种正当标题也会被误伤。
 */
export function titleIsSlug(title: string, slug: string): boolean {
  return title.trim() === slug
}

/**
 * 项目规范正文。seed 版多一句"怎么用模板"的说明——
 * 那是给要复制它的人看的，真实项目里只会显得莫名其妙。
 */
export function renderProjectTemplate(name: string, seed = false): string {
  const howto = seed
    ? tr("\n     Template: copy this directory into the data directory and rename it to a project slug (lowercase letters and hyphens).")
    : ''
  return tr("---\nname: {0}\n---\n\n# Project conventions\n\n<!-- easy-flow: the display name comes from frontmatter name, or the directory name when empty. Changes appear on refresh.{1}\n     Status and priority live in easy-flow.db, never in Markdown.\n     See the easy-flow skill for the workflow. -->\n\n## Background\n\n## Conventions\n", [oneLine(name), howto])
}

// requirement.md：需求描述。编号写在开头，标题与摘要从正文来
function requirementDesc(title: string, summary: string, id = ''): string {
  const head = id ? `---\nid: ${id}\n---\n\n` : ''
  return tr("{0}# {1}\n\n## Summary\n\n{2}\n\n## Acceptance criteria\n\n## Repos\n\n| Short name | Repository |\n| --- | --- |\n\n## Links\n\n-\n", [head, oneLine(title), summary])
}

// context.md：需求的上下文。一开始只是骨架，边做边补
const requirementContextTemplate = () => tr("## Background\n\n## Constraints\n\n## Decisions\n")

const placeholderSummary = () => tr("Briefly describe the deliverable and its motivation.")

const requirementDescTemplate = () => requirementDesc(tr("Describe the requirement's action and outcome"), placeholderSummary())

// 补上 context.md 脚手架：缺才写，已有不动
export function ensureRequirementContext(dir: string): boolean {
  const file = join(dir, 'context.md')
  if (existsSync(file)) return false
  writeFileSync(file, requirementContextTemplate(), 'utf8')
  return true
}

// 不透明 id：人和 agent 都看不出它对应什么，换来的是改名搬家都不变
function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function newRequirementId(): string {
  return newId('req')
}

export function newWorktreeId(): string {
  return newId('wt')
}

// 给已有需求补编号：写在 requirement.md 开头，正文原样保留
export function setRequirementId(dir: string, id: string): void {
  const file = join(dir, 'requirement.md')
  const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  const frontmatter = Object.entries({ ...data, id })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}`, 'utf8')
}

/**
 * worktree 的 AGENTS.md：agent 在这里自证身份——需求目录没有反向指针，
 * 它是「这份工作区属于哪个需求」在文件系统里的唯一凭据。不承载需求内容。
 */
export function renderWorktreeAgents(input: {
  id: string
  requirementId: string
  requirementDir: string
  repo: string
  branch: string
  // design/ 软链指向的真实目录
  designDir: string
}): string {
  return tr("---\nid: {0}\nrequirement: {1}\n---\n\n<!-- easy-flow workspace: read requirement content through the requirement.md symlink.\n     Use the explicit frontmatter ID with easy-flow context wt-….\n     See the easy-flow skill for the workflow. -->\n\nRequirement directory: {2}\nRepository: {3}\nBranch: {4}\n\n## Design documents\n\n`design/` links to {5}.\nWrite design, decisions, and findings there. Files live in the requirement directory,\nare not committed to Git, and appear in the details panel's document tabs.\n", [input.id, input.requirementId, input.requirementDir, oneLine(input.repo), oneLine(input.branch), input.designDir])
}

/**
 * 把模板补到 <dataDir>/_templates/ 下：缺哪个补哪个，已存在不覆盖。
 * 整体静默失败——模板是锦上添花，不能因为它让看板打不开。
 */
export function ensureTemplates(dataDir: string): void {
  try {
    const root = templatesDir(dataDir)
    const files: Array<[string, string]> = [
      ['project/AGENTS.md', renderProjectTemplate('', true)],
      ['requirement/requirement.md', requirementDescTemplate()],
      ['requirement/context.md', requirementContextTemplate()],
    ]
    for (const [rel, content] of files) {
      const file = join(root, rel)
      if (existsSync(file)) continue
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
  } catch {
    /* 数据目录不可写等情况下跳过 */
  }
}

// ------------------------------------------------------------------ 创建

/**
 * 在数据目录下建一个项目目录，并写入项目规范（显示名取 frontmatter 的 name）。
 * 和需求一样只落文件，入库交给 syncProjects。
 */
export function createProjectDir(dataDir: string, slug: string, name = ''): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(tr("Project slug may only contain lowercase letters, digits and hyphens, and may not start with a hyphen: {0}", [slug]))
  }
  const dir = join(dataDir, slug)
  if (existsSync(dir)) throw new Error(tr("Directory already exists: {0}", [dir]))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), renderProjectTemplate(name), 'utf8')
  return dir
}

/**
 * 在项目目录下建一个需求（子需求就是往下再建一层，结构完全相同）。
 * requirement.md 与 context.md 一次写齐。已存在则报错，不静默复用，与 createProject 的取舍一致。
 */
export function createRequirementDir(
  root: string,
  slug: string,
  title: string,
  summary = '',
): { dir: string; id: string } {
  if (!SLUG_RE.test(slug)) {
    throw new Error(tr("Requirement slug may only contain lowercase letters, digits and hyphens, and may not start with a hyphen: {0}", [slug]))
  }
  const dir = join(root, slug)
  if (existsSync(dir)) throw new Error(tr("Directory already exists: {0}", [dir]))
  const id = newRequirementId()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'requirement.md'), requirementDesc(title, summary || placeholderSummary(), id), 'utf8')
  ensureRequirementContext(dir)
  return { dir, id }
}

/**
 * 只读地报告项目哪里不合规范，空数组表示合规。
 *
 * 需求侧没有可校验项：有 requirement.md 就是需求。
 */
export function projectIssues(slug: string, root: string): string[] {
  const issues: string[] = []
  if (!SLUG_RE.test(slug)) {
    issues.push(tr("Directory name does not follow the convention (use lowercase letters, digits, and hyphens)"))
  }
  if (!readProjectConvention(root)) {
    issues.push(tr("Missing project AGENTS.md (copy from {0}/project)", [TEMPLATES_DIR]))
  }

  const stray = listStrayDirs(root)
  if (stray.length) {
    const shown = stray.slice(0, 3).join('、')
    const more = stray.length > 3 ? tr(" and {0} more", [stray.length]) : ''
    issues.push(tr("Subdirectory {0}{1} is not a requirement (requires requirement.md) and will not appear on the board", [shown, more]))
  }
  return issues
}

// ------------------------------------------------------------------ 待办

/**
 * 待办 md：一条待办一份，放在 <dataDir>/_todos/<id>.md。
 * 「摘要」段是可恢复现场的交接说明（同步进库当卡片摘要），「进度」段按时间往下续。
 * 状态与来源等元数据只存在 easy-flow.db 里，不写进这里。
 *
 * 不往正文里塞说明性注释：这份 md 是给人看的文档（应用里直接渲染），
 * 格式约定写在 easy-flow skill 的「待办」里，正文只留内容。
 */
export function renderTodoDoc(title: string, summary = ''): string {
  return tr("# {0}\n\n## Summary\n\n{1}\n\n## Progress\n\n", [oneLine(title), summary.trim()])
}

// 待办目录（<dataDir>/_todos）。不存在时按需建出来
export function todosDir(dataDir: string): string {
  return join(dataDir, TODOS_DIR)
}

// 建一份待办 md。id 由调用方按首次入库日编号，文件已存在则报错
export function createTodoDoc(
  dataDir: string,
  id: string,
  title: string,
  summary = '',
): { file: string } {
  const dir = todosDir(dataDir)
  const file = join(dir, `${id}.md`)
  if (existsSync(file)) throw new Error(tr("Todo file already exists: {0}", [file]))
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, renderTodoDoc(title, summary), 'utf8')
  return { file }
}

// 改写 md 的 H1（待办标题）。没有 H1 就补在最前面
export function setTodoTitle(text: string, title: string): string {
  const line = `# ${oneLine(title)}`
  return /^#\s+.+$/m.test(text) ? text.replace(/^#\s+.+$/m, line) : `${line}\n\n${text}`
}

// 改写「摘要」段，其余（H1、进度段等）原样保留；段不存在就追加到末尾
export function setTodoSummary(text: string, summary: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^##\s*(摘要|Summary)\s*$/i.test(l))
  const block = [start === -1 ? (getLanguage() === Language.Chinese ? '## 摘要' : '## Summary') : lines[start], '', ...summary.trim().split('\n'), '']
  if (start === -1) {
    return `${text.replace(/\s*$/, '')}\n\n${block.join('\n').replace(/\n+$/, '')}\n`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return `${[...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n').replace(/\s*$/, '')}\n`
}
