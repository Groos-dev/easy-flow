---
name: easy-flow
description: >-
  easy-flow 需求看板命令行：终端里认路、建项目与需求、开工作区。
  当你在需求目录或代码工作区（worktree）里需要取上下文（项目规范 / 需求描述 / context.md / 同名工作区），
  或要新建项目 / 需求 / 子需求、改需求状态与优先级、追加飞书任务 / MR / 扩展链接、
  开或删 git worktree 时使用。命令入口 easy-flow，身份只认显式传的 id。
---

# easy-flow

需求看板命令行。一条命令做一件事，输出默认给人读，`--json` 给脚本。

参数细节以命令自带的帮助为准：`easy-flow --help`、`easy-flow req new --help`……

## 身份：id 从哪来

命令只认显式传的 id，不做任何猜测（不认 cwd、不认 env）。id 写在目录的 AGENTS.md frontmatter 里：

| 你在哪 | 读什么 | 用哪个 id |
| --- | --- | --- |
| 代码工作区 | 本目录 AGENTS.md 的 `id` | `wt-…`（取上下文）；它还有 `requirement:` 是所属需求的 `req-…` |
| 需求目录 | 本目录 AGENTS.md 的 `id` | `req-…` |
| 项目目录 | 项目 AGENTS.md（只有显示名，没有 id） | 项目标识（目录名） |

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

- **进需求目录 / 工作区接活**：先 `easy-flow context <id>`——返回项目规范、需求描述、context.md，加上上层需求 / 子需求与同名工作区清单；再动手。
- **开一个工作区**：`easy-flow wt new <req-…> --repo <仓库> --branch <分支> --short <短名>`；输出里有新的 worktree id 与路径。`--repo` 传仓库名（在仓库根下找）或主 checkout 的绝对路径；同路径重复调用是幂等的。
- **收尾**：`easy-flow req set <req-…> --status Review`；有 MR / 飞书链接就 `easy-flow req link <req-…> --mr <url>`（只增不删，重复传会合并去重）。

## 约定

- 目录名（slug）只允许英文小写、数字、连字符；中文标题推不出目录名，要显式 `--slug`。
- `wt rm` 遇到未提交改动会拒绝，确认丢弃才 `--force`；分支永远保留。
- 脚本解析用 `--json`：成功打数据，失败打 `{"error": …}`，退出码非 0（用法错误 2，其余 1）。
- 上表没覆盖的用法，跑 `easy-flow <命令> --help` 现查——别猜参数。
