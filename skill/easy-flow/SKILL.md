---
name: easy-flow
description: >-
  easy-flow：开发任务的强制入口（需求看板 + 工作区）。诉求只要会落到改代码——实现功能、加字段/接口、
  改行为、修 bug、重构、迁移、联调、发版准备、提 MR——第一步就必须先过这里：确认归属需求，没有就先建，
  再开工作区；任务再小、你再确定也一样。
  禁止在仓库主 checkout / 默认分支上直接改，禁止自己 git checkout -b 或手工建 worktree 绕过。
  也用于：取上下文（项目规范 / 需求描述 / context.md / 同名工作区）、新建项目 / 需求 / 子需求、
  改需求状态与优先级、追加飞书任务 / MR / 扩展链接、登记 agent 会话（claude code / codex / cursor）、
  开或删工作区、收尾（置 Review、回写 MR）。
  纯只读查询（看日志、查报文、问代码在哪）不走这里。命令入口 easy-flow，身份只认显式传的 id。
---

# easy-flow

需求看板命令行。一条命令做一件事，输出默认给人读，`--json` 给脚本。

参数细节以命令自带的帮助为准：`easy-flow --help`、`easy-flow req new --help`……

## 硬规则

- 会落到改代码的任务，第一步先确认归属需求：没有就先建，再开工作区；任务再小、再确定也一样
- 改代码只在工作区里：不在仓库主 checkout、不在默认分支上直接改，也不自己 `git checkout -b`
  或手工建 worktree 绕开 `wt new`
- 已经在动手才发现没确认归属：停下补，别顺着改下去
- 建需求、开工作区、登记会话是留痕，一条都不能省；但**澄清不必跟人对话**——问不问人由下面的
  《什么时候才找人》判，别拿「确认一下」换安心
- 开工时顺手把自己的会话登记到需求上（`req session add`）：看板一点就能回到这个会话，
  换个 agent 接手也知道前面有谁在做。会话 id 不用自己查，`--agent` 传对就行

## 流程：澄清 → 实现 → Review

| 阶段 | 看板状态 | 做完什么才算过 | 内容落到哪 |
| --- | --- | --- | --- |
| 需求澄清 | 澄清 | 讲清做什么、为什么做、边界、验收边界，定下涉及仓库。摸清代码现状后**自己能写出来就算过**，写不出才找人（判据见下节） | requirement.md、context.md、docs/<短名>/（调研与方案） |
| 实现 | 执行中 | 开工作区；登记会话；按方案实现；设计有变随手更新 | 代码在工作区；设计变更 → docs/<短名>/ |
| Review | Review | 开 MR、回写链接、按评审意见改 | `req link <req-…> --mr <url>`；状态置 Review |
| 合入 | 已完成 | 人为主；agent 被明确告知「已合入」时顺手置 | — |

- 澄清阶段只谈产品：做什么、为什么、边界与验收，不碰实现细节与技术名词
- 收尾时点：改动提交或开出 MR 之后——先 `easy-flow req set <req-…> --status Review`，有 MR 就 `easy-flow req link <req-…> --mr <url>`（多条 MR 用 `--mr "<别名>=<url>"` 区分，看板只显示别名）
- 涉及多个仓库时，收尾顺手建一个 Codex review 会话：`easy-flow req session review <req-…>`。
  它把这条需求名下全部工作区收进一个 Codex project，发一轮评审提示词，并挂到需求上——
  人在看板「会话」块点一下就能在 Codex 里按仓库逐个看 diff。这一轮是跑完才返回的，别让工具超时掐掉它

## 什么时候才找人

流程不是门禁：三个阶段照走，但**要不要跟人对话由 agent 在开工时自己判**。判据三条，命中任一才找人；都没命中就自己走完。

| 判据 | 怎么验 |
| --- | --- |
| 需求说不清 | 写不出验收清单——列不出「做完什么样算过」。检验的是能不能落笔，不是「你觉得清楚吗」 |
| 方案有真歧义 | 两种做法都站得住，我列不出谁明显更好，且选错要返工 |
| 动作不可逆或外发 | 改契约 / 动数据 / 发布 / `push` / 开 MR / 合入 |

- 判据只在**开工时**判一次，不是全程免打扰：实现中途踩中任何一条，停下问，别顺着改下去
- 判据三不交给 agent 自判——外发与不可逆的代价收不回来，仍然硬卡人
- 判断结论写一行进 `context.md` 的「决策」段：看板上看得见，人能事后纠偏
- 能省的只有澄清那轮对话，留痕一条都不能省

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
| 数据目录在哪（需求都在哪） | `easy-flow dir` |
| 取上下文（项目 / 需求 / 工作区） | `easy-flow context <id>` |
| 新建项目 | `easy-flow project new <slug> [--name <显示名>]` |
| 新建需求 | `easy-flow req new <标题> --project <项目> [--slug <目录名>] [--summary <一句话>]` |
| 新建子需求 | `easy-flow req new <标题> --parent <req-…> [--slug <目录名>]`（同样入库上板，slug 形如 `parent/child`） |
| 改状态 / 优先级 | `easy-flow req set <req-…> [--status 澄清\|执行中\|Review\|已完成] [--priority p0..p3]` |
| 追加链接 | `easy-flow req link <req-…> [--feishu <url>] [--mr <url>\|<别名>=<url>>] [--ext "<描述>=<url>"]` |
| 登记自己的会话 | `easy-flow req session add <req-…> --agent <claude\|codex\|cursor> [--title "<在做什么>"]` |
| 建 Codex review 会话 | `easy-flow req session review <req-…> [--handoff] [--prompt <文本>]` |
| 看待办 / 删会话 | `easy-flow req session ls [<req-…>]` / `easy-flow req session rm <req-…> --agent <…> --id <会话 id>` |
| 开工作区 | `easy-flow wt new <req-…> --repo <仓库> --branch <分支> [--short <短名>]` |
| 删工作区 | `easy-flow wt rm <wt-…> [--force]` |

待办（全局 todo）不在这里：它是与需求平级的另一块板，命令是 `easy-flow todo new|set|list|show`，
规则见 `todo` skill。

## 常用流程

- **在任意目录接到改动任务**（含仓库主 checkout）：
  1. 先找归属：`easy-flow dir` 取数据目录，在其中递归找 `**/requirement.md`——子需求嵌在需求目录
     里、层级不限，只扫两层会漏；读「涉及仓库」段匹配当前仓库，挑未完成的。命中唯一就用它，
     命中多个或找不到就问用户
  2. 还没有需求 → `easy-flow req new <标题> --project <项目> --slug <目录名>`
  3. 开工作区 → `easy-flow wt new <req-…> --repo <仓库> --branch feature-<需求 slug>`
  4. 进工作区后 `easy-flow context <wt-…>` 取上下文，然后动手
- **进需求目录 / 工作区接活**：先 `easy-flow context <id>`——返回项目规范、需求描述、context.md，
  加上上层需求 / 子需求、同名工作区清单与会话；再动手。

## 会话：开工先登记

会话是真正的工作现场（上下文、进度、下一步都在里面），但它只活在 agent 应用里，需求目录里看不到。
登记到需求上，看板与 `context` 才找得到——过几天回来，点一下就能回到那个会话接着干。

- 一条命令：`easy-flow req session add <req-…> --agent <claude|codex|cursor> --title "<在做什么>"`
- 会话 id 不用自己查：`--agent` 传对就行，CLI 按 agent 读它注入的环境变量
  （claude：`CLAUDE_CODE_HOST_SESSION_ID` → `CLAUDE_CODE_SESSION_ID`；codex：`CODEX_THREAD_ID`；
  cursor：`CURSOR_CONVERSATION_ID`），一个都没设会报错——说明 `--agent` 传错了，或不在会话里
- `--title` 写一句"在做什么"：应用里的会话标题读不到，看板上就靠这句认人
- 看板详情页的「会话」块点一下即在 desktop 应用里打开（codex → `codex://threads/<id>`，
  claude 的 Code 标签页会话 → `claude://claude.ai/epitaxy/<id>`）；cursor 与终端里的 claude
  没有会话级链接，看板上只能复制 id，回到那个会话要靠应用自己的历史（codex 没装 desktop 时用
  `codex resume <id>`）
- 同一会话重复登记只刷新字段；换到别的需求做时重新登记一次，记录跟着走
- 登记是留个指路牌，不是保活：会话换了、废了，用 `req session rm` 摘掉旧的

## 约定

- 目录名（slug）只允许英文小写、数字、连字符；中文标题推不出目录名，要显式 `--slug`。
- `wt rm` 遇到未提交改动会拒绝，确认丢弃才 `--force`；分支永远保留。
- 脚本解析用 `--json`：成功打数据，失败打 `{"error": …}`，退出码非 0（用法错误 2，其余 1）。
- 上表没覆盖的用法，跑 `easy-flow <命令> --help` 现查——别猜参数。
