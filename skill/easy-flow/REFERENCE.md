# easy-flow 命令参考

SKILL.md 只放主流程，每个命令的参数、场景与坑在这里。本文跟不上实现时以
`easy-flow <命令> --help` 为准。

## 全局

- `--json`：成功打数据，失败打 `{"error": …}`；退出码非 0（用法错误 2，其余 1）
- `--help`：每个命令都能跟，如 `easy-flow req new --help`
- 数据目录：`<dataDir>/<项目>/<需求>/`。换数据目录等于换一套看板

## dir

- 干什么：打印数据目录与配置文件位置
- 用法：`easy-flow dir [--json]`
- 示例：`easy-flow dir`
- 场景：不知道需求都在哪、要给脚本定位库文件时
- 坑：路径由应用配置决定，别写死 `~/requirements`

## context

- 干什么：一次取齐某个 id 的上下文——项目规范、需求描述、context.md、上层 / 子需求、工作区、会话、待办
- 用法：`easy-flow context <req-… | wt-… | 项目标识> [--json]`
- 示例：`easy-flow context req-236d2ccb70`
- 场景：进需求目录或工作区接活，动手前的第一件事
- 坑：
  - id 只能显式传；工作区的 id 在它自己 AGENTS.md 的 frontmatter 里
  - 待办段里标「未确认」的，是由来源会话推出来的归属；确认后用 `todo set <id> --req <req-…>` 补上
  - 状态到 Review / 已完成时，末尾会点名名下未完成的待办

## project new

- 干什么：建项目（需求的容器），同时建目录与项目 AGENTS.md
- 用法：`easy-flow project new <slug> [--name <显示名>] [--json]`
- 示例：`easy-flow project new onex --name "机票辅营"`
- 场景：新业务线 / 新仓库第一次挂需求
- 坑：目录名规则见 SKILL.md「约定」。显示名写在项目 AGENTS.md 的 frontmatter，改完下次刷新生效

## req new

- 干什么：建需求目录（requirement.md / context.md）并上板
- 用法：`easy-flow req new <标题> (--project <项目> | --parent <req-…>) [--slug <目录名>] [--summary <一句话>] [--json]`
- 示例：`easy-flow req new "TF 餐食迁移到新链路" --project onex --slug tf-meal-migration`
- 场景：确认了归属但还没有需求；拆子需求用 `--parent`
- 坑：
  - 标题规范见 SKILL.md「约定」。逐字等于目录名会被拒绝
  - 中文标题推不出目录名，必须显式 `--slug`。字符集见 SKILL.md「约定」
  - 子需求的 slug 是相对项目根的 `parent/child`，层级不限
  - `--summary` 只影响卡片摘要，写清楚「做什么」的一句话

## req set

- 干什么：改看板状态与优先级
- 用法：`easy-flow req set <req-…> [--status 澄清|执行中|Review|已完成] [--priority p0|p1|p2|p3|""] [--json]`
- 示例：`easy-flow req set req-236d2ccb70 --status Review`
- 场景：开工置执行中、交付置 Review、合入置已完成；优先级随事态调整
- 坑：
  - 传了哪个改哪个，都没传会报错；`--priority ""` 清空优先级
  - 状态只在看板上改，不要写进任何 md
  - 父需求不跟着子需求自动收尾

## req link

- 干什么：把任何与需求相关的链接挂到需求上——一条链接就是一对「标题 + URL」，不分类
- 用法：`easy-flow req link <req-…> "<标题>=<url>" ["<标题>=<url>" …] [--json]`
- 示例：
  - `easy-flow req link req-236d2ccb70 "设计稿=https://example.com/design"`
  - `easy-flow req link req-236d2ccb70 "https://gitlab.example.com/group/repo/-/merge_requests/12?tab=notes"`
- 场景：拿到飞书 Story、开出 / 换了 MR、有设计文档 / Wiki / 监控 / 截图要挂
- 坑：
  - 可一次传多条，只增不删；同一 URL 再传只更新标题，这次没给标题就保留旧的
  - 标题尽量短，同时还能看出这条链接是什么。可省：直接写 URL 也行。看板按 URL 推短名：GitLab 合并请求是「仓库 !编号」，GitHub 拉取请求是「仓库 #编号」，飞书或 Lark 的地址用去掉域名、再去掉 `/detail` 的路径，其余取路径末段
  - 查询串里的 `=` 不会被拆成标题：等号左边已经带 `://` 时，整段都是地址
  - 只收 http(s)；挂完还要在 requirement.md 的「链接」段补一行（人翻目录时看得到）
  - 看板按 URL 反查 GitLab / GitHub 状态，所以链接要贴 MR / PR 的页面地址，不是仓库首页
  - 一条链接都没有、却已经有工作区或状态到了 Review 时，`context` 与 `req set` 会点名提示

## req session add

- 干什么：把 agent 会话登记到需求上（不写进需求目录），看板据此一键回到那个会话
- 用法：
  `easy-flow req session add <req-…> --agent <claude|codex|cursor|chengxiaobang> [--id <会话 id>] [--title <标题>] [--cwd <目录>] [--link <url>] [--json]`
- 示例：`easy-flow req session add req-236d2ccb70 --agent cursor --title "评审链接收口"`
- 场景：开工时、换 agent 接手时
- 坑：
  - `--cwd` 缺省是当前目录
  - `--id` 省略时按 `--agent` 读环境变量：claude → `CLAUDE_CODE_HOST_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`，
    codex → `CODEX_THREAD_ID`，cursor → `CURSOR_CONVERSATION_ID`，chengxiaobang → `CHENGXIAOBANG_SESSION_ID`；
    一个都没设会报错——说明 `--agent` 传错或不在会话里
  - `--title` 写一句「在做什么」：应用里的会话标题读不到，看板只认这句
  - `--link` 缺省按 agent 推导：codex → `codex://threads/<id>`、claude 的 `local_` 会话 →
    `claude://claude.ai/epitaxy/<id>`、chengxiaobang → `chengxiaobang://session/<id>`；cursor 与终端里的
    claude 没有会话级链接，只存 id
  - 同一会话重复 add 是幂等的，只刷新字段；换需求做时在新需求上再登记一次

## req session ls / rm

- 干什么：列出 / 摘除需求上登记的会话
- 用法：`easy-flow req session ls [<req-…>] [--json]`、`easy-flow req session rm <req-…> --agent <…> --id <会话 id> [--json]`
- 示例：`easy-flow req session ls req-236d2ccb70`
- 场景：会话换了、废了，摘掉旧指路牌；接手前看有谁做过
- 坑：登记只是回到现场的指路牌，不代表会话还在运行；运行状态看板自己显示

## wt new

- 干什么：在主 checkout 旁建 `<仓库>.<分支>` 工作区，并登记到需求上
- 用法：`easy-flow wt new <req-…> --repo <仓库名或主 checkout 路径> --branch <分支> [--base <起点>] [--short <短名>] [--json]`
- 示例：`easy-flow wt new req-236d2ccb70 --repo easy-flow --branch feature-unified-links --short easy-flow`
- 场景：需求进入实现，准备改代码
- 坑：
  - `--base` 缺省用主 checkout 的 HEAD；分支名按仓库习惯（easy-flow 自己是 `feature-<需求 slug>`）
  - `--short` 是需求「涉及仓库」表里的短名，决定 `docs/<短名>/` 目录名
  - 同路径重复调用幂等；工作区里带身份 AGENTS.md、requirement.md、`design/`
  - 产物写进仓库的 `info/exclude`，不污染 `git status`

## wt rm

- 干什么：删工作区目录、git 登记与 easy-flow 记录
- 用法：`easy-flow wt rm <wt-…> [--force] [--json]`
- 示例：`easy-flow wt rm wt-d5b560d217`
- 场景：需求收尾、工作区废了
- 坑：有未提交改动会拒绝，确认丢弃才 `--force`；分支永远保留

## todo new / set / list / show

- 干什么：全局待办的记账与流转（不属于任何项目，只通过 `req_id` 挂需求）
- 用法：
  - `easy-flow todo new <标题> [--source feishu|chat|agent|manual] [--req <req-…>] [--link <url>] [--summary <上下文>] [--session …] [--ref …] [--json]`
  - `easy-flow todo set <id>… [--status todo|in_progress|done|cancelled] [--req <req-…>] [--title …] [--summary …] [--json]`
  - `easy-flow todo list [--status …] [--req <req-…>] [--session …] [--orphan] [--all] [--limit <n>] [--json]`
  - `easy-flow todo show <id> [--json]`
- 示例：
  - `easy-flow todo new "补链接短名" --req req-236d2ccb70 --source agent`
  - `easy-flow todo set T-20261028-001 --status done`
  - `easy-flow todo list --req req-236d2ccb70`
  - `easy-flow todo show T-20261028-001`
- 场景：接到还没立项的活先记一条；收尾时成批了结；接手时看名下还有什么没做
- 坑：
  - id 按首次入库日编号（`T-YYYYMMDD-NNN`），不用自己起
  - `--summary` 要写成「下一个 agent 只看这一条就能接手」：进度、下一步、完成标准、关键 ID、证据入口
  - `--ref` 是去重键，重复时只报出已有条目，不新建
  - 其余捕获字段（`--channel` / `--from` / `--chat` / `--at` / `--session`）见 `--help`
  - `--title` / `--summary` 改的是待办正文，其余只改看板；`--req` 是归属需求
  - 传空串表示清空该字段。一次给多个 id 时，不能同时改标题或摘要
  - 归属三档、粒度和摘要要求见 SKILL.md「待办」

## todo promote / import

- 干什么：`promote` 把待办立项成需求并回填指针；`import` 把旧按天 todo 文件搬进看板
- 用法：
  - `easy-flow todo promote <id> --project <项目> [--slug <目录名>] [--title <标题>] [--json]`
  - `easy-flow todo import <目录> [--dry-run] [--json]`
- 示例：
  - `easy-flow todo promote T-20261028-001 --project onex --slug link-label`
  - `easy-flow todo import ~/old-todos --dry-run`
- 场景：`promote` 是「这条要动手了，正式立项」；`import` 只用于一次性迁移旧数据
- 坑：
  - `promote` 沿用待办的标题与摘要（摘要即交接文），已挂需求的会报错并指出那条需求
  - `import` 只搬未完成的，已完成的留在原处；重复跑安全

## 待办

归属、粒度和摘要的硬规则在 SKILL.md「待办」。这里是字段和入库时怎么做。

| 字段 | 说明 |
| --- | --- |
| `id` | `T-YYYYMMDD-NNN`，按首次入库日编号，命令自动分配 |
| `status` | `todo` / `in_progress` / `done` / `cancelled` |
| `source` | `feishu`（飞书消息）、`chat`（当前对话）、`agent`（执行中识别）、`manual`（用户要求记一条） |
| `session` | 来源会话。`agent` / `chat` 必填，后人靠它回到原会话 |
| `channel` | 仅飞书：`at_me` / `p2p` |
| `from` / `chat` | 来源人、会话或群名 |
| `ref` | 去重键。飞书用 message id。重复时 `todo new` 报出已有条目，改用 `todo set` |
| `req` | 归属需求 `req-…`。没立项也能挂到一条已有需求上 |
| `link` | 可跳转的地址（飞书话题、合并请求、页面） |
| `at` | 源事件时间 `yyyy-mm-dd HH:mm` |
| `summary` | 交接说明。进度、下一步、完成标准、关键编号、证据入口。已知结论写上，并写明不要再跑哪一步 |

入库：

1. 先看是不是已有主任务。同一来源、同一件事就 `todo set <id> --summary` 补关注点，不新建
2. 来源是 `agent` 或 `chat` 时先拿到会话标识。拿不到写「未知」，不编造
3. `easy-flow todo new "<动词开头的标题>" --source agent --session "<会话>" --summary "<交接>"`
4. 飞书来源再补 `--ref`、`--channel`、`--link`、`--from`、`--chat`
5. 把新编号和一行标题回报给用户或调用方

看待办时回复要短：编号、状态、来源、标题、来源人、链接。开始做就置 `in_progress`，做完置 `done`，并在进度段补一行结果。不删除条目。

已经有明确下一步、只是还在等授权或确认的，也要入库。标题写成「取得授权并…」或「确认后…」。授权之后改同一条，不另建。没有具体动作和完成标准的想法不入库。

不这样做：

- 不把大段日志写进待办文件，只写结论和证据链接
- 不把没有行动的闲聊入库
- 不写缺少会话标识的 `agent` / `chat` 条目
- 不为同一件事的每个小问题各建一条
- 不入库只有标题、摘要里没有动作的空壳
- 结论已经定了，就写上结论，不要让后来的人把排查再跑一遍
- 不手改待办文件里的状态
