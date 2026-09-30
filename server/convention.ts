/**
 * 目录规范与模板。
 *
 * 项目与需求都由 agent 直接在文件系统里建目录，应用不提供创建入口。
 * 这里只做两件事：把模板补到 <dataDir>/_templates/ 下，以及只读地报告目录哪里不合规范。
 * 规范问题只用于 UI 提示：不拦截操作、不改状态、不过滤列表。
 *
 * 状态（阶段/优先级/链接）永远不写进 md；模板与规范只描述文件结构。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listStrayDirs, readProjectConvention } from './markdown.ts'

/** 收纳目录。下划线开头，listProjectDirs 不会把它当成项目 */
export const TEMPLATES_DIR = '_templates'

function templatesDir(dataDir: string): string {
  return join(dataDir, TEMPLATES_DIR)
}

/** 原来的创建入口在这里做过校验，入口移除后只用于提示 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

const PROJECT_TEMPLATE = `---
name:
---

# 项目规范

<!-- easy-flow 项目模板：把本目录整个复制到数据目录下，目录名改成项目标识（英文小写 + 连字符）。
     显示名取上面 frontmatter 的 name，留空则用目录名，改完下次刷新生效。
     状态（阶段/优先级）存在 easy-flow.db 里，不要写进任何 md。 -->

## 背景

## 约定
`

/** AGENTS.md：给 agent 读的指令，不承载需求描述 */
const REQUIREMENT_AGENTS_TEMPLATE = `<!-- easy-flow 需求模板 · agent 指令：写怎么干活、有哪些约束、要避开什么。
     需求描述放同目录的 requirement.md，卡片标题和摘要从那里读。
     状态（阶段/优先级/链接）存在 easy-flow.db 里，不要写进任何 md。 -->

## 约束
`

/** requirement.md：需求描述，卡片标题与摘要的来源 */
const REQUIREMENT_DESC_TEMPLATE = `<!-- easy-flow 需求模板 · 需求描述：卡片标题取下面的 H1，摘要取「需求」段。
     更长的方案、决策、踩坑放 docs/ 下，会自动出现在详情页标签栏。 -->

# 需求标题

## 需求

一句话说清要做什么、为什么。

## 涉及仓库

| 短名 | 仓库 |
| --- | --- |

## 链接

-
`

/**
 * 把模板补到 <dataDir>/_templates/ 下：缺哪个补哪个，已存在不覆盖。
 * 整体静默失败——模板是锦上添花，不能因为它让看板打不开。
 */
export function ensureTemplates(dataDir: string): void {
  try {
    const root = templatesDir(dataDir)
    const files: Array<[string, string]> = [
      ['project/AGENTS.md', PROJECT_TEMPLATE],
      ['requirement/AGENTS.md', REQUIREMENT_AGENTS_TEMPLATE],
      ['requirement/requirement.md', REQUIREMENT_DESC_TEMPLATE],
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
