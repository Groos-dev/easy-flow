---
name: easy-flow
description: >-
  easy-flow 需求看板命令行：认出流程、建项目与需求、开工作区。在代码仓库（含主 checkout）
  或任意目录接到改动任务、不确定挂在哪个需求下时，先用它确认归属——没有需求就先建、再开
  工作区，不要在默认分支上直接改；当你在需求目录或代码工作区里需要取上下文（项目规范 /
  需求描述 / context.md / 同名工作区），或要新建项目 / 需求 / 子需求、改需求状态与优先级、
  追加飞书任务 / MR / 扩展链接、开或删 git worktree 时使用。
  命令入口 easy-flow，身份只认显式传的 id。
---

# easy-flow

需求看板命令行。一条命令做一件事，输出默认给人读，`--json` 给脚本。

参数细节以命令自带的帮助为准：`easy-flow --help`、`easy-flow req new --help`……

## 流程：澄清 → 实现 → Review

| 阶段 | 看板状态 | 做完什么才算过 | 内容落到哪 |
| --- | --- | --- | --- |
| 需求澄清 | 澄清 | 站在产品角度讲清：做什么、为什么做、边界、验收边界；定下涉及仓库。讨论前先摸清代码现状，据此检查需求有没有遗漏 | requirement.md、context.md、docs/<短名>/（调研与方案） |
| 实现 | 执行中 | 开工作区；按方案实现；设计有变随手更新 | 代码在工作区；设计变更 → docs/<短名>/ |
| Review | Review | 开 MR、回写链接、按评审意见改 | `req link <req-…> --mr <url>`；状态置 Review |
| 合入 | 已完成 | 人为主；agent 被明确告知「已合入」时顺手置 | — |

- 澄清阶段只谈产品：做什么、为什么、边界与验收，不碰实现细节与技术名词
- 收尾时点：改动提交或开出 MR 之后——先 `easy-flow req set <req-…> --status Review`，有 MR 就 `easy-flow req link <req-…> --mr <url>`

## 内容放哪

| 文件 | 放什么 | 不放什么 |
| --- | --- | --- |
| requirement.md | 需求描述：H1=看板标题、需求段=摘要、验收、涉及仓库、链接 | 进度、流水账 |
| context.md | 背景（为什么做）、约束（边界）、决策 | 进度（会过期） |
| docs/<短名>/ | 设计、调研、踩坑；工作区里的 `design/` 软链指到这里 | — |
| AGENTS.md | 身份（frontmatter 的 id）+ 该目录的指令：怎么干、约束、避开什么 | 需求内容 |
| 状态 / 优先级 | 只存在 easy-flow.db 里 | 任何 md 文件 |

目录内的 AGENTS.md 与这份说明有意冗余（在目录里工作时也能读到）；两处不一致时以本说明为准。

## 身份：id 从哪来

命令只认显式传的 id，不做任何猜测（不认 cwd、不认 env）。id 写在目录的 AGENTS.md frontmatter 里：

| 你在哪 | 读什么 | 用哪个 id |
| --- | --- | --- |
| 代码工作区 | 本目录 AGENTS.md 的 `id` | `wt-…`（取上下文）；它还有 `requirement:` 是所属需求的 `req-…` |
| 需求目录 | 本目录 AGENTS.md 的 `id` | `req-…` |
| 项目目录 | 项目 AGENTS.md（只有显示名，没有 id） | 项目标识（目录名） |
| 仓库主 checkout | 没有 id——先确认归属（见常用流程） | 项目标识 / 新需求的 `req-…` |

## 目录与工作区

- 需求 = 项目目录下的一个目录，齐备 requirement.md 与 AGENTS.md 才算；子需求是需求目录里的
  需求目录，层级不限，slug 是相对项目根的路径（`parent/child`）
- 工作区 = 主 checkout 旁的 `<仓库>.<分支>` 目录，`wt new` 建出并附三样：身份文件（AGENTS.md，
  含 `wt-…` 与所属需求）、requirement.md 软链、design/ 软链（指向需求目录的 `docs/<短名>/`）；
  产物写进仓库的 info/exclude，不污染 git status

## 意图 → 命令

| 意图 | 命令 |
| --- | --- |
| 取上下文（项目 / 需求 / 工作区） | `easy-flow context <id>` |
| 新建项目 | `easy-flow project new <slug> [--name <显示名>]` |
| 新建需求 | `easy-flow req new <标题> --project <项目> [--slug <目录名>] [--summary <一句话>]` |
| 新建子需求 | `easy-flow req new <标题> --parent <req-…> [--slug <目录名>]`（同样入库上板，slug 形如 `parent/child`） |
| 改状态 / 优先级 | `easy-flow req set <req-…> [--status 澄清\|执行中\|Review\|已完成] [--priority p0..p3]` |
| 追加链接 | `easy-flow req link <req-…> [--feishu <url>] [--mr <url>] [--ext "<描述>=<url>"]` |
| 开工作区 | `easy-flow wt new <req-…> --repo <仓库> --branch <分支> [--short <短名>]` |
| 删工作区 | `easy-flow wt rm <wt-…> [--force]` |

## 常用流程

- **在任意目录接到改动任务**（含仓库主 checkout）：
  1. 先找归属：按当前仓库路径，在 `~/requirements/*/*/requirement.md` 的「涉及仓库」段里找
     命中的、未完成的需求；命中唯一就用它，命中多个或找不到就问用户
  2. 还没有需求 → `easy-flow req new <标题> --project <项目> --slug <目录名>`
  3. 开工作区 → `easy-flow wt new <req-…> --repo <仓库> --branch feature-<需求 slug>`
  4. 进工作区后 `easy-flow context <wt-…>` 取上下文，然后动手
- **进需求目录 / 工作区接活**：先 `easy-flow context <id>`——返回项目规范、需求描述、context.md，
  加上上层需求 / 子需求与同名工作区清单；再动手。

## 约定

- 目录名（slug）只允许英文小写、数字、连字符；中文标题推不出目录名，要显式 `--slug`。
- `wt rm` 遇到未提交改动会拒绝，确认丢弃才 `--force`；分支永远保留。
- 脚本解析用 `--json`：成功打数据，失败打 `{"error": …}`，退出码非 0（用法错误 2，其余 1）。
- 上表没覆盖的用法，跑 `easy-flow <命令> --help` 现查——别猜参数。
