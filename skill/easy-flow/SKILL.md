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
- 元数据（状态、链接、会话、涉及仓库）变更即同步，默认做、不问人，见《元数据：变更即同步》
- 开工时顺手把自己的会话登记到需求上（`req session add`）：看板一点就能回到这个会话，
  换个 agent 接手也知道前面有谁在做。会话 id 不用自己查，`--agent` 传对就行

## 流程：澄清 → 实现 → Review

| 阶段 | 看板状态 | 做完什么才算过 | 内容落到哪 |
| --- | --- | --- | --- |
| 需求澄清 | 澄清 | 讲清做什么、为什么做、边界、验收边界，定下涉及仓库。摸清代码现状后**自己能写出来就算过**，写不出才找人（判据见下节） | requirement.md、context.md、docs/<短名>/（调研与方案） |
| 实现 | 执行中 | 开工作区；登记会话；按方案实现；设计有变随手更新 | 代码在工作区；设计变更 → docs/<短名>/ |
| Review | Review | 开 MR、回写链接、按评审意见改 | `req link <req-…> --mr <url>`；状态置 Review |
| 合入 | 已完成 | **代码进了主分支就算完成**——谁合的都一样，状态随手置，不必等人开口（要不要合仍按判据三问人） | — |

- 澄清阶段只谈产品：做什么、为什么、边界与验收，不碰实现细节与技术名词
- 收尾时点：改动提交或开出 MR 之后——先 `easy-flow req set <req-…> --status Review`，有 MR 就 `easy-flow req link <req-…> --mr <url>`（多条 MR 用 `--mr "<别名>=<url>"` 区分，看板只显示别名）
- **父需求不跟着子需求自动收尾**：子需求全完成时 `req set` 与 `context` 会提一句，但收不收自己判——
  父需求自己可能还有整体验收，替它改状态等于把它谎报成完成

## 什么时候才找人

流程不是门禁：三个阶段照走，但**要不要跟人对话由 agent 在开工时自己判**。判据三条，命中任一才找人；都没命中就自己走完。

| 判据 | 怎么验 |
| --- | --- |
| 需求说不清 | 写不出验收清单——列不出「做完什么样算过」。检验的是能不能落笔，不是「你觉得清楚吗」 |
| 方案有真歧义 | 两种做法都站得住，我列不出谁明显更好，且选错要返工 |
| 动作不可逆或外发 | 改契约 / 动数据 / 发布 / `push` / 开 MR / 合入 |

- 判据只在**开工时**判一次，不是全程免打扰：实现中途踩中任何一条，停下问，别顺着改下去
- 判据三不交给 agent 自判——外发与不可逆的代价收不回来，仍然硬卡人
- 同步元数据不在判据里：写的是自己的看板与需求文档，不是把内容发给别人——默认做完，不问
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

## 标题：写成「在做什么」

卡片上能快速扫的只有标题（slug 是灰字、摘要是小字长文），所以标题要是一个短句，不是名字——
读一遍就知道这条需求在干什么。

公式：`<范围/对象> + <动作>`，能带上触发条件或收益更好。

| 别写 | 改成 |
| --- | --- |
| `tf-meal-migration`（等于目录名） | TF 餐食迁移到新链路 |
| `需求工位：CSD选座接入使用TF标准价`（套壳、没有动作） | CSD 选座接入 TF 标准价 |
| `Project: Flight OneX Exchange Requirements`（模板残留） | 写实际要做的那件事 |

`req new` 只拦「标题逐字等于目录名」这一种，长度与措辞没有硬限制——其余靠这一条自己把握。

**子需求**的标题要带父锚点。看板按文件修改时间平铺，父子散在各列，标题是唯一还能看出归属的
地方：父需求是「需求看板启动 Agent 会话并带入上下文」时，子需求写「会话启动：Claude Code
深链接适配」，几块能认成同一串；只写「Claude Code 新会话深链接适配」就跟别的需求分不出关系。

## 元数据：变更即同步

状态、优先级、链接、会话、涉及仓库是看板的事实面——人只看看板，它们落后于实际进度，看板就在撒谎。
同步这些是默认动作：不问「要不要登记」，也不攒到收尾。

| 变更一发生 | 落库 | 落文档 |
| --- | --- | --- |
| 拿到飞书 Story 链接 | `req link <req-…> --feishu <url>` | requirement.md「链接」段补一行 |
| 开出 / 换了 MR | `req link <req-…> --mr [<别名>=]<url>` | 同上 |
| 涉及仓库增减 | — | requirement.md「涉及仓库」段 |
| 开工 / 交付 / 合入 | `req set <req-…> --status …` | — |
| 优先级变了 | `req set <req-…> --priority …` | — |
| 换会话接手 | `req session add <req-…> --agent … --title "…"` | — |
| 判据结论、方案取舍 | — | context.md「决策」段 |

- 实时 = 拿到的那一刻就写：链接是别人给的、MR 是自己开的，都不必等收尾
- 两边都落才叫同步：结构化字段进库（看板读的是它），requirement.md 的「链接」「涉及仓库」段
  同步补上（人翻目录时看得到）

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
| 看待办 / 删会话 | `easy-flow req session ls [<req-…>]` / `easy-flow req session rm <req-…> --agent <…> --id <会话 id>` |
| 开工作区 | `easy-flow wt new <req-…> --repo <仓库> --branch <分支> [--short <短名>]` |
| 删工作区 | `easy-flow wt rm <wt-…> [--force]` |
| 待办立项成需求 | `easy-flow todo promote <todo-id> --project <项目>`（建需求 + 回填指针一次做完） |
| 收尾时清待办 | `easy-flow todo set <id> <id> … --status done`（名下那批一次收掉） |

待办（全局 todo）不挂在项目下，命令是 `easy-flow todo new|set|list|show|promote`，规则见 `todo` skill。

`context` 的末尾带「待办」段：显式挂在本需求下的、由来源会话推出归属的（标「未确认」），
以及三种全局点名——无归属的存量（N / 超期 M / 最老 K 天）、指针悬空、归属需求已完成。
**开工时先看这一段**——它和需求描述一样是上下文的一部分。
`req set --status 已完成|Review` 会点出名下未完成的待办与超期无归属的存量，收尾时一并了结。

## 常用流程

- **在任意目录接到改动任务**（含仓库主 checkout）：
  1. 先找归属：`easy-flow dir` 取数据目录，在其中递归找 `**/requirement.md`——子需求嵌在需求目录
     里、层级不限，只扫两层会漏；读「涉及仓库」段匹配当前仓库，挑未完成的。命中唯一就用它，
     命中多个或找不到就问用户
  2. 还没有需求 → `easy-flow req new <标题> --project <项目> --slug <目录名>`
  3. 开工作区 → `easy-flow wt new <req-…> --repo <仓库> --branch feature-<需求 slug>`
  4. 进工作区后 `easy-flow context <wt-…>` 取上下文，然后动手
- **进需求目录 / 工作区接活**：先 `easy-flow context <id>`——返回项目规范、需求描述、context.md，
  加上上层需求 / 子需求、同名工作区清单、会话与待办；再动手。待办段里标「未确认」的是推出来的
  归属，确认了就 `todo set <id> --req <req-…>` 补上指针。

## 会话：开工先登记

会话是真正的工作现场（上下文、进度、下一步都在里面），但它只活在 agent 应用里，需求目录里看不到。
登记到需求上，看板与 `context` 才找得到——过几天回来，点一下就能回到那个会话接着干。

- 一条命令：`easy-flow req session add <req-…> --agent <claude|codex|cursor|chengxiaobang> --title "<在做什么>"`
- 会话 id 不用自己查：`--agent` 传对就行，CLI 按 agent 读它注入的环境变量
  （claude：`CLAUDE_CODE_HOST_SESSION_ID` → `CLAUDE_CODE_SESSION_ID`；codex：`CODEX_THREAD_ID`；
  cursor：`CURSOR_CONVERSATION_ID`；chengxiaobang：`CHENGXIAOBANG_SESSION_ID`），
  一个都没设会报错——说明 `--agent` 传错了，或不在会话里
- `--title` 写一句"在做什么"：应用里的会话标题读不到，看板上就靠这句认人
- 看板详情页的「会话」块点一下即在 desktop 应用里打开（codex → `codex://threads/<id>`，
  claude 的 Code 标签页会话 → `claude://claude.ai/epitaxy/<id>`，chengxiaobang →
  `chengxiaobang://session/<id>`）；cursor 与终端里的 claude 没有会话级链接，看板上只能复制 id，
  回到那个会话要靠应用自己的历史（codex 没装 desktop 时用 `codex resume <id>`）。
  程小帮当前版本收到 `session/<id>` 只会聚焦窗口，会话要自己点；客户端补上分支后同一链接即直达
- 同一会话重复登记只刷新字段；换到别的需求做时重新登记一次，记录跟着走
- 登记是留个指路牌，不是保活：会话换了、废了，用 `req session rm` 摘掉旧的

## 约定

- 目录名（slug）只允许英文小写、数字、连字符；中文标题推不出目录名，要显式 `--slug`。
- `wt rm` 遇到未提交改动会拒绝，确认丢弃才 `--force`；分支永远保留。
- 脚本解析用 `--json`：成功打数据，失败打 `{"error": …}`，退出码非 0（用法错误 2，其余 1）。
- 上表没覆盖的用法，跑 `easy-flow <命令> --help` 现查——别猜参数。
