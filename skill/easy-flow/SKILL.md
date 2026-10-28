---
name: easy-flow
description: >-
  管理开发需求和待办。识别到是长期任务或需求、上下文还要留下来时使用：先确认归哪条需求，没有就新建。要改代码再开工作区。
  也用于查看需求上下文、改状态和优先级、登记飞书任务 / 合并请求 / 文档链接、登记当前会话、记待办、看待办、把待办立项、收尾。
---

# easy-flow

## 定位

一个需求 = 一份可验收的交付。做什么写在 requirement.md，为什么写在 context.md。
状态和优先级只在看板上改。桌面看板是这些的视图。

下一个接手的人只看 `easy-flow context` 带回来的东西。没挂到这条需求上的，他看不到。所以只做一件事：
**每件事都有归属需求，每份上下文都挂回这条需求上。**

待办是同一套看板里的全局条目，不另开一块板。应用里没有待办看板入口，单条从需求详情的「关联待办」点开。

定位是管理这条需求的上下文，方便下一个 agent 接着干。需求目录里执行 `easy-flow context <req-…>`，工作区里执行 `easy-flow context <wt-…>`，就能把这条需求上的上下文全部取回来。

## 需求与工作区

- 需求 = 项目目录下有 `requirement.md` 的目录；子需求是需求目录里的需求目录
- 工作区 = 主目录旁的 `<仓库>.<分支>`。执行 `easy-flow wt new <req-…> --repo <仓库> --branch <分支> --short <短名>` 建出，并带上身份（`wt-…`）、requirement.md 与 `design/`（就是需求目录的 `docs/<短名>/`）
- 改代码只在工作区里：不在主 checkout、不在默认分支上直接改

## 铁律

- 识别到是长期任务或需求，上下文还要留给以后的，都走这里：确认归属，没有就建。要改代码再开工作区
- 为某条需求干活，就把当前会话编号登记到这条需求上：`easy-flow req session add <req-…> --agent cursor --title "在做什么"`。`--agent` 换成当前代理，只能是 `claude`、`codex`、`cursor`、`chengxiaobang` 其中之一。编号由这条命令读到
- 看一眼、问一句、做完不用再翻出来的，不走这里
- 已经动手才发现没归属，停下补，别顺着改下去
- 澄清只谈做什么、为什么、边界与验收，不写实现
- 判据一：写得出验收清单才算清楚。检验的是能不能落笔，不是觉得清不清楚
- 判据二：两种做法都站得住，并且列不出谁明显更好，选错要返工，才算真歧义

## 主流程

澄清 → 实现 → Review，三步都由 agent 自己推进，不设门禁。

| 阶段 | 看板状态 | 这一阶段做完什么 | 命令 | 产出落在哪 |
| --- | --- | --- | --- | --- |
| 澄清 | 澄清 | 讲清做什么、为什么、边界与验收，定下涉及仓库。**写得出验收清单就算过** | `easy-flow req new "<标题>" --project <项目> --slug <目录名> --summary "<一句话>"` | requirement.md、context.md、`docs/<短名>/` |
| 实现 | 执行中 | 开工作区、登记会话、按方案实现，设计有变随手更新 | `easy-flow wt new <req-…> --repo <仓库> --branch <分支> --short <短名>`；`easy-flow req session add <req-…> --agent cursor --title "在做什么"`；`easy-flow req set <req-…> --status 执行中` | 代码在工作区；设计变更 → `docs/<短名>/` |
| Review | Review | 改动提交或开出 MR，回写链接，按评审意见改 | `easy-flow req set <req-…> --status Review`；`easy-flow req link <req-…> "<标题>=https://…"` | 看板上登记链接 + requirement.md「链接」段 |
| 合入 | 已完成 | **代码进了主分支就算完成**——谁合的都一样，状态随手置。要不要合、要不要推送，仍按判据三问人 | `easy-flow req set <req-…> --status 已完成` | — |

父需求不跟着子需求自动收尾。最后一个子需求执行 `easy-flow req set <子需求 req-…> --status 已完成` 时，命令会提示父需求。要收父需求再执行 `easy-flow req set <父需求 req-…> --status 已完成`。父需求可能还有整体验收，收不收自己判。

## 最重要的一条：一切挂需求

与需求上下文有关的东西，**一律挂回这条需求**。这是默认动作：变更一发生就写，不问人、不攒到收尾。

| 拿到 / 发生 | 挂到哪 |
| --- | --- |
| 链接：飞书 Story、MR/PR、设计文档、Wiki、监控、截图，以及所有和这条需求相关、工作中出现过的链接 | `easy-flow req link <req-…> "<标题>=https://…"` |
| 会话：为这条需求干活、换 agent 接手 | `easy-flow req session add <req-…> --agent cursor --title "在做什么"` |
| 待办：还没立项的活 | `easy-flow todo new "<标题>" --req <req-…> --source agent --summary "<交接>"` |
| 工作区：开始实现 | `easy-flow wt new <req-…> --repo <仓库> --branch <分支> --short <短名>` |
| 状态 | `easy-flow req set <req-…> --status 执行中` |
| 优先级 | `easy-flow req set <req-…> --priority p1` |
| 涉及仓库增减 | requirement.md「涉及仓库」段 |
| 设计、调研、决策 | 需求目录 `docs/<短名>/`、context.md「决策」段 |

- 为什么这么硬：看板与 `context` 是别人和下一个 agent 唯一的事实面；不挂上去，接手的人得从头问一遍
- 链接「两边都落」：看板上登记一条，requirement.md 的「链接」段同步补一行
- 链接标题尽量短，同时还能看出这条链接是什么

## 待办

待办回答「要不要做、归谁」，需求回答「这条交付走到哪了」。两者靠待办上的需求指针相连。待办不挂在任何项目下。

| 档 | 怎么认 | 要做什么 |
| --- | --- | --- |
| 显式归属 | 写了 `--req` | 直接做。做完执行 `easy-flow todo set <T-…> --status done` |
| 候选归属 | 没写 `--req`，但来源会话登记在某条需求上 | 确认后执行 `easy-flow todo set <T-…> --req <req-…>`。归到别的需求就换成那条的编号 |
| 无归属 | 没有指针，会话也推不出需求 | 做：`easy-flow todo set <T-…> --status in_progress`。不做：`easy-flow todo set <T-…> --status cancelled`。立项：`easy-flow todo promote <T-…> --project <项目> --slug <目录名>` |

- 候选是推出来的。`context` 和详情页标「未确认」。看到了就要回填指针，不能当成已经挂上
- 指针指向的需求没了，或归属需求已经完成而待办还开着：`context` 会点名。重新挂到一条存在的需求上，或置 `cancelled` / `done`
- 无归属超过 7 天标超期。超期是该做决定，`cancelled` 是正常收法
- 默认一条主任务。同一来源、同一件事里的多个诉求合成一条，关注点写进摘要。另建一条只在能独立关单、负责人或排期不同、或体量够单独排期时
- 摘要按「下一个 agent 只有这一条、没有这段对话」来写：进度、下一步、完成标准、关键编号、证据入口。只有标题的空壳不要记
- 来源是 `agent` 或 `chat` 时，会话标识必填，用来回到原会话
- 立项用 `easy-flow todo promote <T-…> --project <项目> --slug <目录名>`，一次建需求并回填指针
- 需求收到 Review 或已完成时，`easy-flow req set <req-…> --status 已完成` 会点出名下未完成的待办。收掉用 `easy-flow todo set <T-…> <T-…> --status done`
- 状态只在看板上改。待办文件在数据目录 `_todos/<id>.md`：一级标题是标题，摘要段是交接，进度段往下续。改标题和摘要用 `easy-flow todo set <T-…> --title "<标题>" --summary "<交接>"`，不手改文件里的状态

字段、入库步骤和不要这样做的清单见 [REFERENCE.md](REFERENCE.md)「待办」。

## 什么时候才找人

流程不是门禁，但**跟人对话由 agent 在开工时自己判**。三条判据，命中任一才找人：

| 判据 | 怎么验 |
| --- | --- |
| 需求说不清 | 写不出验收清单——列不出「做完什么样算过」。检验的是能不能落笔，不是觉得清不清楚 |
| 方案有真歧义 | 两种做法都站得住，列不出谁明显更好，且选错要返工 |
| 动作不可逆或外发 | 改契约 / 动数据 / 发布 / `push` / 开 MR / 合入 |

- 判据只在**开工时**判一次；实现中途踩中任何一条，停下问，别顺着改下去
- 判据三不交给 agent 自判——外发与不可逆的代价收不回来
- 同步元数据不在判据里：写的是自己的看板与需求文档，不是发给别人，默认做完、不问
- 判断结论写一行进 context.md「决策」段

## 身份：id 从哪来

命令只认显式传的 id：

| 你在哪 | 读什么 | 用哪个 id |
| --- | --- | --- |
| 代码工作区 | 工作区说明开头的 `id` | `wt-…`；`requirement:` 是所属需求的 `req-…` |
| 需求目录 | requirement.md 开头的 `id` | `req-…` |
| 项目目录 | 目录名 | 项目标识 |
| 仓库主 checkout | 没有 id——先找归属需求 | 项目标识 / 新需求的 `req-…` |

## 内容放哪

| 文件 / 目录 | 放什么 | 不放什么 |
| --- | --- | --- |
| requirement.md | 开头是需求编号。H1=看板标题、需求段=摘要、验收、涉及仓库、链接 | 进度、流水账 |
| context.md | 背景（为什么做）、约束（边界）、决策 | 进度（会过期） |
| docs/<短名>/ | 设计、调研、踩坑；工作区里用 `design/` 打开同一处 | — |
| `_todos/<id>.md` | 一条待办：一级标题、摘要段是交接、进度段往下续 | 状态 |
| 状态 / 优先级 | 只在看板上改 | 任何 md 文件 |

## 命令

高频动作：

| 意图 | 命令 |
| --- | --- |
| 数据目录在哪 | `easy-flow dir` |
| 取某条需求的上下文 | `easy-flow context <req-…>` |
| 取某个工作区的上下文 | `easy-flow context <wt-…>` |
| 建项目 | `easy-flow project new <目录名> --name "<显示名>"` |
| 建需求 | `easy-flow req new "<标题>" --project <项目> --slug <目录名> --summary "<一句话>"` |
| 建子需求 | `easy-flow req new "<标题>" --parent <req-…> --slug <目录名> --summary "<一句话>"` |
| 改状态 | `easy-flow req set <req-…> --status 执行中` |
| 改优先级 | `easy-flow req set <req-…> --priority p1` |
| 挂链接 | `easy-flow req link <req-…> "<标题>=https://…"` |
| 登记当前会话 | `easy-flow req session add <req-…> --agent cursor --title "在做什么"` |
| 列出会话 | `easy-flow req session ls <req-…>` |
| 摘掉会话 | `easy-flow req session rm <req-…> --agent cursor --id <会话编号>` |
| 开工作区 | `easy-flow wt new <req-…> --repo <仓库> --branch <分支> --short <短名>` |
| 删工作区 | `easy-flow wt rm <wt-…>` |
| 记待办 | `easy-flow todo new "<标题>" --req <req-…> --source agent --summary "<交接>"` |
| 改待办状态 | `easy-flow todo set <T-…> --status done` |
| 看待办 | `easy-flow todo list --req <req-…>` |
| 读一条待办 | `easy-flow todo show <T-…>` |
| 待办立项 | `easy-flow todo promote <T-…> --project <项目> --slug <目录名>` |

尖括号里的字换成实际值。`--agent cursor` 换成当前代理，只能是 `claude`、`codex`、`cursor`、`chengxiaobang` 其中之一。`--status` 只能是 `澄清`、`执行中`、`Review`、`已完成` 其中之一。`--priority` 只能是 `p0`、`p1`、`p2`、`p3` 其中之一。

## 接活

- **在任意目录接到改动任务**（含仓库主目录）：先 `easy-flow dir`。在数据目录里递归找 `**/requirement.md`，按「涉及仓库」段匹配当前仓库、挑未完成的。命中唯一就用它。没有需求就 `easy-flow req new "<标题>" --project <项目> --slug <目录名> --summary "<一句话>"`，再 `easy-flow wt new <req-…> --repo <仓库> --branch <分支> --short <短名>`，然后 `easy-flow context <wt-…>`，再动手
- **进需求目录 / 工作区接活**：先 `easy-flow context <req-…>` 或 `easy-flow context <wt-…>`。动手前看「待办」段，标「未确认」的是推出来的归属

## 约定

- 目录名（slug）只允许英文小写、数字、连字符；中文标题推不出目录名，要显式 `--slug`
- 标题写成「在做什么」。公式是 `<范围/对象> + <动作>`，能带上触发条件或收益更好。看板上它是唯一能扫的东西
- 新建需求时，标题逐字等于目录名会被拒绝。子需求标题要带父锚点：父需求是「需求看板启动 Agent 会话并带入上下文」时，子需求写「会话启动：Claude Code 深链接适配」。看板不分组，标题是唯一还能看出归属的地方
- 脚本用 `--json` 的输出与退出码见 [REFERENCE.md](REFERENCE.md)「全局」
- 参数别猜：上表没覆盖的用法跑 `easy-flow <命令> --help` 现查
