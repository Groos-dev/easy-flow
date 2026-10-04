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
import { listStrayDirs, parseFrontmatter, readProjectConvention } from './markdown.ts'

/** 收纳目录。下划线开头，listProjectDirs 不会把它当成项目 */
export const TEMPLATES_DIR = '_templates'

function templatesDir(dataDir: string): string {
  return join(dataDir, TEMPLATES_DIR)
}

/** 原来的创建入口在这里做过校验，入口移除后只用于提示 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** 写进单行结构的值先把换行压平，否则会把 frontmatter 和 H1 写坏 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 项目规范正文。seed 版多一句"怎么用模板"的说明——
 * 那是给要复制它的人看的，真实项目里只会显得莫名其妙。
 */
export function renderProjectTemplate(name: string, seed = false): string {
  const howto = seed
    ? '\n     模板用法：把本目录整个复制到数据目录下，目录名改成项目标识（英文小写 + 连字符）。'
    : ''
  return `---
name: ${oneLine(name)}
---

# 项目规范

<!-- easy-flow 项目规范：显示名取上面 frontmatter 的 name，留空则用目录名，改完下次刷新生效。${howto}
     状态（看板列、优先级）存在 easy-flow.db 里，不要写进任何 md。
     完整流程（三阶段、每阶段做什么、内容放哪）见 easy-flow skill。 -->

## 背景

## 约定
`
}

/**
 * 需求目录的 AGENTS.md：agent 的说明书，身份（id）也写在这里。
 *
 * 为什么身份不放 requirement.md：那份文件是"要做什么"（人写的需求描述），
 * 而 id 是"你是谁"，跟文件约定、约束是一类东西，都属于给 agent 看的说明书。
 */
function requirementAgents(id: string): string {
  const frontmatter = id ? `---\nid: ${id}\n---\n\n` : ''
  return `${frontmatter}<!-- easy-flow 需求 · agent 指令：写怎么干活、有哪些约束、要避开什么。
     跑 easy-flow 命令时（如 easy-flow context），用上面 frontmatter 里的 id 显式传参。
     完整流程（三阶段、每阶段做什么、内容放哪）见 easy-flow skill。 -->

## 这个目录里有什么

| 文件 | 作用 |
| --- | --- |
| \`AGENTS.md\` | 本文件：身份（frontmatter 的 id）与 agent 指令 |
| \`requirement.md\` | 需求描述。看板卡片的标题取它的 H1、摘要取「需求」段；验收段写做到什么算完成 |
| \`context.md\` | 需求的上下文：背景、约束、相关的人与系统、决策依据 |
| \`docs/\` | 设计、调研、踩坑。会出现在详情页标签栏；工作区里的 \`design/\` 软链指向它下面的仓库目录 |

## 约束
`
}

/** requirement.md：需求描述，卡片标题与摘要的来源。身份不在这里 */
function requirementDesc(title: string, summary: string): string {
  return `<!-- easy-flow 需求 · 需求描述：看板标题取下面的 H1，摘要取「需求」段，验收段写做到什么算完成。
     上下文（背景、约束、决策）写同目录的 context.md，更长的方案放 docs/。 -->

# ${oneLine(title)}

## 需求

${summary}

## 验收

## 涉及仓库

| 短名 | 仓库 |
| --- | --- |

## 链接

-
`
}

/** context.md：需求的上下文。一开始只是骨架，边做边补 */
const REQUIREMENT_CONTEXT_TEMPLATE = `<!-- easy-flow 需求 · 上下文：需求描述之外的补充——背景、约束、相关的人与系统、决策依据。
     不记进度：进度从看板状态与工作区里的代码就能推出来，写在这里只会过期。
     身份与目录约定见同目录 AGENTS.md，需求描述见 requirement.md。 -->

## 背景

## 约束

## 决策
`

const PLACEHOLDER_SUMMARY = '一句话说清要做什么、为什么。'

const REQUIREMENT_DESC_TEMPLATE = requirementDesc('需求标题', PLACEHOLDER_SUMMARY)

/** 补上 context.md 脚手架：缺才写，已有不动 */
export function ensureRequirementContext(dir: string): boolean {
  const file = join(dir, 'context.md')
  if (existsSync(file)) return false
  writeFileSync(file, REQUIREMENT_CONTEXT_TEMPLATE, 'utf8')
  return true
}

/** 不透明 id：人和 agent 都看不出它对应什么，换来的是改名搬家都不变 */
function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function newRequirementId(): string {
  return newId('req')
}

export function newWorktreeId(): string {
  return newId('wt')
}

/** 给已有需求补 id：只动 frontmatter，正文原样写回 */
export function setRequirementId(dir: string, id: string): void {
  // 身份归说明书：写入 AGENTS.md 的 frontmatter，正文原样写回
  const file = join(dir, 'AGENTS.md')
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
  /** design/ 软链指向的真实目录 */
  designDir: string
}): string {
  return `---
id: ${input.id}
requirement: ${input.requirementId}
---

<!-- easy-flow worktree 指令：这里是一份代码工作区，需求内容在软链 requirement.md 里。
     身份认上面 frontmatter 的 id：取上下文时显式传它（easy-flow context wt-…）。
     完整流程（三阶段、每阶段做什么、内容放哪）见 easy-flow skill。 -->

需求目录：${input.requirementDir}
仓库：${oneLine(input.repo)}
分支：${oneLine(input.branch)}

## 设计文档写在哪

\`design/\` 是软链，指向 ${input.designDir}。
这个仓库在这个需求下的设计、取舍、踩坑写在那里——文件存在需求目录里，
不进 git、也不要提交；详情页的标签栏会直接读到。
`
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
      ['requirement/AGENTS.md', requirementAgents('')],
      ['requirement/requirement.md', REQUIREMENT_DESC_TEMPLATE],
      ['requirement/context.md', REQUIREMENT_CONTEXT_TEMPLATE],
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
    throw new Error(`Project slug may only contain lowercase letters, digits and hyphens, and may not start with a hyphen: ${slug}`)
  }
  const dir = join(dataDir, slug)
  if (existsSync(dir)) throw new Error(`Directory already exists: ${dir}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), renderProjectTemplate(name), 'utf8')
  return dir
}

/**
 * 在项目目录下建一个需求（子需求就是往下再建一层，结构完全相同）。
 * 两份文件一次写齐——缺一份就不会被识别成需求。
 * 已存在则报错，不静默复用，与 createProject 的取舍一致。
 */
export function createRequirementDir(
  root: string,
  slug: string,
  title: string,
  summary = '',
): { dir: string; id: string } {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Requirement slug may only contain lowercase letters, digits and hyphens, and may not start with a hyphen: ${slug}`)
  }
  const dir = join(root, slug)
  if (existsSync(dir)) throw new Error(`Directory already exists: ${dir}`)
  const id = newRequirementId()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), requirementAgents(id), 'utf8')
  writeFileSync(join(dir, 'requirement.md'), requirementDesc(title, summary || PLACEHOLDER_SUMMARY), 'utf8')
  ensureRequirementContext(dir)
  return { dir, id }
}

/**
 * 只读地报告项目哪里不合规范，空数组表示合规。
 *
 * 需求侧没有可校验项：需求目录被识别的充要条件就是两份文件齐备，
 * 缺了就不算需求，所以这类问题归到「子目录」一条里报，天然只出现一次。
 */
export function projectIssues(slug: string, root: string): string[] {
  const issues: string[] = []
  if (!SLUG_RE.test(slug)) {
    issues.push('目录名不合规范（建议英文小写、数字、连字符）')
  }
  if (!readProjectConvention(root)) {
    issues.push(`缺少项目规范 AGENTS.md（可从 ${TEMPLATES_DIR}/project 复制）`)
  }

  const stray = listStrayDirs(root)
  if (stray.length) {
    const shown = stray.slice(0, 3).join('、')
    const more = stray.length > 3 ? ` 等 ${stray.length} 个` : ''
    issues.push(`子目录 ${shown}${more} 不是需求（需 AGENTS.md + requirement.md），不会出现在看板`)
  }
  return issues
}
