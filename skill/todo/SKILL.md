---
name: todo
description: >-
  本机全局待办（todo / task manager）：记一条、看待办、改状态、恢复现场。所有经 agent
  记录的待办（feishu / chat / agent / manual）都走这里，入口是 easy-flow CLI 的 todo 命令，
  待办不挂在任何项目下。当用户提到 全局待办、todo、记一条任务、加个 todo、看待办、还有哪些没做、
  关掉这条、开始做某条、改任务状态、这条该归到哪条需求、立项、收尾时清待办，
  或别的 skill（如 feishu-task）交来候选要落库时使用。
  条目必须带上"下一个 agent 只看这一条就能接手"的上下文。
---

# Todo

本机全局待办板。一条待办一份 md（内容）+ 一行 sqlite（状态与来源），两边由 CLI 一起维护。
easy-flow 应用里没有待办看板入口，单条待办从需求详情页的「关联待办」块点开。

飞书拉消息 / 识别候选由 `feishu-task` 负责；**入库与状态追踪只走本 skill**。

**Announce at start:** "正在用 todo 管理全局待办。"

## 命令

入口 `easy-flow`（装好的 shim）或 `pnpm cli`（在 easy-flow 仓库里）。参数细节以 `--help` 为准，别猜。

| 意图 | 命令 |
| --- | --- |
| 看待办 | `easy-flow todo list [--status …] [--source …] [--all] [--limit <n>]` |
| 记一条 | `easy-flow todo new <标题> --source <…> [--summary <上下文>] …` |
| 读一条（含 md 全文与文件路径） | `easy-flow todo show <id>` |
| 改状态 | `easy-flow todo set <id>… --status <todo\|in_progress\|done\|cancelled>`（多个 id 一次改） |
| 改标题 / 补上下文 | `easy-flow todo set <id> [--title <标题>] [--summary <上下文>]` |
| 补来源类字段 | `easy-flow todo set <id> [--link <url>] [--session …] [--ref …] [--req <req-…>] …` |
| 立项成需求（一次做完） | `easy-flow todo promote <id> --project <项目> [--slug <目录名>] [--title <标题>]` |
| 反查某需求下的待办 | `easy-flow todo list --req <req-…>` |
| 反查某个会话下的待办 | `easy-flow todo list --session <会话 id\|链接>` |
| 只看无归属的 | `easy-flow todo list --orphan` |

`todo list` 默认只列未完成的；`--all` 连已完成一起列。加 `--json` 给脚本解析。
行尾带停留天数；未完成且超过 7 天的标「超期」——超期不是错误，是「该处置了」。

## 字段

| 字段 | 说明 |
| --- | --- |
| `id` | `T-YYYYMMDD-NNN`，按首次入库日编号，命令自动分配 |
| `status` | `todo` / `in_progress` / `done` / `cancelled`，只有这四个 |
| `source` | `feishu`（@我 / 私聊，由 `feishu-task` 交来）、`chat`（当前对话）、`agent`（执行中识别）、`manual`（用户要求记一条） |
| `session` | 来源 agent 会话。`source` 为 `agent` / `chat` 时**必填**——后人靠它回到原会话取证 |
| `channel` | 仅 feishu：`at_me` / `p2p` |
| `from` / `chat` | 来源人、会话或群名 |
| `ref` | 去重键：feishu 用 message_id，其余用来源稳定 id。重复时 `todo new` 会报出已有条目 |
| `req` | 归属的需求 id（`req-…`）。没立项也能挂到一条已存在的需求上；空表示还没归属 |
| `link` | 可跳转链接（飞书 thread、MR、页面） |
| `at` | 源事件时间 `yyyy-mm-dd HH:mm` |
| `summary` | 可恢复现场的上下文，见下节 |

## 归属：三档（硬规则）

待办回答「要不要做、归谁」；需求回答「这条交付走到哪了」。两者靠 `req` 这根指针相连，
但**没写指针不等于没人管**。开工时先分清自己在哪一档：

| 档 | 怎么认 | 你要做什么 |
| --- | --- | --- |
| 显式归属 | 待办写了 `--req` | 直接做；做完置 `done` |
| 候选归属 | 没写 `--req`，但 `session` 指向的会话登记在某条需求上 | **确认**：是这条需求的活就 `todo set <id> --req <req-…>`；不是就归到该去的那条 |
| 无归属 | 没写 `--req`，会话也推不出需求 | **处置**：做（`--status in_progress`）、不做（`--status cancelled`）、或立成需求 |

另有两种指针坏了的情况，`context` 会全局点名一次，不挂在任何需求下：

- **指针悬空**：`req` 指向的需求已被删/合并。重新挂到一条存在的需求，或 `cancelled`
- **归属需求已完成**：收尾时没一并了结。`todo set <id>… --status done` 收掉，确认还要继续就重新归属

- 候选归属是**推出来的，不是登记过的**：`context` 与需求详情页都把它单列一段并标「未确认」。
  不要把它当事实，也不要因为看到了就不回填指针
- `context` 的「待办」段就是这两档 + 三种全局点名的入口：开工第一步看到的就该是它们，
  而不是先 `todo list` 再筛
- 无归属的待办会按停留天数标超期（7 天）。超期不等于逾期，它只说明「该做一次决定了」——
  决定可以是「不做」，`cancelled` 是正常动作，不是失败

## 收尾：需求那头也要了结

- 需求置 `已完成` / `Review` 时，`req set` 会点出名下未完成的待办与超期还没归属的存量；
  名下那批可以一条命令收掉：`easy-flow todo set <id> <id> … --status done`
- 一条需求由多条待办汇入时，收尾前都过一遍——留着指向已完成需求的待办，等于留个假线索；
  `context` 会把它们列在「归属需求已完成」段
- 指针指向的需求被删了（悬空）：`context` 会点名，重新挂到一条存在的需求上，或置 `cancelled`

## 立项：一次动作

`easy-flow todo promote <id> --project <项目>` 一次做完「建需求 + 回填指针」。
分两步（`req new` 再 `todo set --req`）就一定有人忘第二步——这是实测出来的：26 条待办只有 6 条挂上。
标题与摘要沿用待办的（摘要即交接文），需要时用 `--title` / `--slug` 覆盖。

## 内容写在哪

一条待办一份 md，文件路径由 `todo show` 给出（在数据目录的 `_todos/<id>.md`）。

| 段 | 放什么 |
| --- | --- |
| H1 | 标题。改它用 `todo set --title`，别手改文件 |
| `## 摘要` | 可恢复现场的交接说明。改它用 `todo set --summary` |
| `## 进度` | 按时间往下续的流水：做了什么、结论、证据链接 |

**状态不写进 md**——它只存在 easy-flow.db 里；手改 md 里的状态不会生效。
需要更长的内容时可以直接编辑那份 md（路径从 `todo show` 取），改完 `todo list` 会自动同步。

## 粒度：主任务 + 关注点（硬规则）

**默认只建「主任务」，不按消息/子问题拆条。**

- 同一来源（同一人的同一 p2p / 同一群 / 同一飞书 thread）在同一工作流里提出的多个诉求，合成 **1 个主任务**；各关注点写进 `summary`（`①… ②… ③…`，每点带动作、完成标准、来源 msg id）。
- `title` 写整条工作流（动词开头），不写「第 N 个小问题」。
- 只有满足下列**任一**条件才另建独立条目：
  1. 有独立完成标准、可独立关单，不受主任务进度影响；
  2. 不同负责人或不同排期节奏；
  3. 体量足以单独排期（≥1 人天，或独立 MR/发布）。
- 后续同来源、同工作流的新消息 → **先找主任务补关注点**（`todo set <id> --summary …`），不要新建条目；找不到主任务才新建。
- 已拆细的条目被合并时：状态改 `cancelled`，在 md 的进度段写一行「合并入 <主任务 id>（原因）」，`summary` 只留一行指针。

## Summary = 可恢复现场（硬规则）

入库时默认假设：**下一个 agent 只有这条 todo，没有本对话历史**。`summary`（必要时加 `link`）必须让他能马上开干，而不是再问「这是啥 / 结论在哪」。

`summary` 尽量覆盖（有则写，无则显式写「未知」；已知结论勿让后续重跑）：

1. **进度**：已完成哪些、当前在做什么、剩余步骤、阻塞点（含待谁确认 / 待授权）
2. **动作**：下一步具体做什么（含入口 / 页面 / skill 名；若某 skill **不要**再跑，写明「勿再跑 X」）
3. **完成标准**：怎样算 done（文案交付 / 已提交 / 已回复某人…）
4. **关键 ID**：订单号、航班、机型、渠道、taskToken、auditId 等
5. **已定结论**：调查已完成就写入结论与对比要点，避免重复排障
6. **证据入口**：飞书 thread + `link`；其它稳定链接（MR、配置页、bugtracker）；agent / chat 来源用 `session` 回到原会话

`title` 只负责一句话；**细节放 `summary`，链接放 `link`**。宁可 summary 稍长（4–8 句 / 若干分号要点），也不要「看一下 seatmap」这种空壳。

自检（入库前过一遍）：

- [ ] 换一个没读过本对话的 agent，只看这条，能否知道**做到哪了、做什么、依据是什么、去哪找证据、怎样算完**？
- [ ] `source` 为 `agent` / `chat` 时，`session` 填了能回到原会话的标识吗？
- [ ] 有飞书来源时，`ref`（message_id）与 `link`（优先 thread 深链）齐了吗？
- [ ] 若结论已定，写了「勿再跑某某排查」吗？

## Workflows

### A. Append（入库）

任意来源（含 `feishu-task` 交来的候选）走此流程。

1. **先聚合**：判断候选是否属于已有主任务（同来源 + 同工作流）→ 是则 `todo set <id> --summary …` 补关注点，不新建。
2. **取 session**：`source` 为 `agent` / `chat` 时先拿到能回到原会话的标识（Codex 用 `$CODEX_THREAD_ID`，写成 `codex://threads/<id>`；拿不到写「未知」，不得编造）。
3. **Normalize**：把上面那节要求的字段凑齐，`summary` 必须是 handoff-ready。
4. **入库**：

```bash
easy-flow todo new "<动词开头的标题>" --source agent --session "codex://threads/<id>" \
  --summary "<进度 / 动作 / 完成标准 / 关键 ID / 证据入口>"
```

feishu 来源补 `--ref <message_id> --channel <at_me|p2p> --link <thread 深链> --from <来源人> --chat <群名>`。
`--ref` 命中已有条目时会报出那个 id，改用 `todo set` 补内容，不要重复建。

5. **回报**：把新 id 与一行标题回给用户（或调用方 skill）。

### B. List（看待办）

```bash
easy-flow todo list              # 未完成的
easy-flow todo list --all        # 连已完成一起
```

回复要短：id、status、source、title、来源人、链接。

### C. Update（改状态 / 补内容）

用户说开始做 / 做完 / 关掉 / 改标题 / 补上下文时：

```bash
easy-flow todo set <id> --status in_progress
easy-flow todo set <id> --summary "<补上的现场>"
```

不要删条目：`done` / `cancelled` 仍然留在看板上。

### D. Capture（对话中记待办）

- 用户明确说「记一下 / 加 todo」→ `source: manual` 或 `chat`，直接入库（summary 仍须 handoff-ready）
- agent 执行中冒出明确行动项 → `source: agent`；不确定是否入库先短问一句
- 对话里已有结论 / 链接 / ID 时**当场写入**，不要只记 title
- 不要把纯粹的思考步骤写成 todo

### D.1 待授权 / 待确认事项

已形成明确方案且后续动作明确，但因用户授权、审批或外部确认尚未执行的事项，仍是未完成任务，必须入库为 `todo`；不要因当前不能直接执行而遗漏。

- `summary` 写明：待谁确认 / 授权、确认后立即执行的动作、受限资源或路径、完成标准、已有方案与证据入口。
- `title` 以「取得授权并…」「确认后…」表述，不得假称实现已开始。
- 得到授权后更新同一条为 `in_progress`，不新建重复条目。
- 只有模糊想法、没有具体后续动作或完成标准的内容仍不入库。

### E. Resume（接下一条 todo）

1. `easy-flow todo show <id>` 读元数据、md 全文与文件路径
2. 有 `session` → 先回到该 agent 会话读上下文；有飞书 `link` → 拉 thread 恢复证据；再执行 summary 里的动作
3. summary 写了「勿再跑 X」→ 遵守，除非用户推翻结论
4. 开工时置 `in_progress`；做完置 `done`，并在 md 的进度段补一行结果要点

### F. 立项（与需求对接）

同一件工作在立项前后会换板：待办记入口与跟进，需求记交付。两边靠 todo 侧的一个指针相连。

- 立项是一次动作：`easy-flow todo promote <id> --project <项目>`——建需求 + 回填指针一起做完。
  分两步（`req new` 再 `todo set --req`）就一定有人忘第二步
- 轻归属：不必先立项，挂到一条已存在的需求上也叫归属：`easy-flow todo set <id> --req <req-…>`
- 需求收尾时反过来：`req set --status 已完成|Review` 会点名未完成待办，
  `todo list --req <req-…>` 逐条置 `done` 或 `cancelled`
- 指针只存 todo 一侧，需求侧不存列表——登记动作永远发生在待办这边，别去需求文档里
  维护待办清单（写进 md 也查不出来，下次重写就没了）。
- 一条需求常由多条待办汇入（多条 todo 挂同一个 `req-…`）；反过来一条待办只挂一条需求。

## Compose with

| Concern | Delegate |
| --- | --- |
| 飞书拉 @我 / p2p、过滤候选 | `feishu-task`（只识别，不落盘） |
| 认证 / 搜消息 | `lark-shared` / `lark-im`（经 feishu-task） |
| 需求（不是待办） | `easy-flow` skill 的 req / wt 命令 |

## Anti-patterns

- 不把 CK 查询结果、大段日志、agent scratch 写进待办的 md；只写结论与证据链接
- 不在 `feishu-task` 或其它 skill 里另建第二套任务板
- 不把无行动项的闲聊默认入库
- **不写缺 `session` 的 agent / chat 来源条目**（后人无法回到原会话取证）
- **不为同一来源、同一工作流的每个小问题各建一条**（应并入主任务关注点）
- **不入库空壳 todo**（只有 title、summary 无可执行动作 / 无关键 ID / 无证据入口）
- **不在结论已定时仍引导后人重跑完整排障**（应写清结论 +「勿再跑 …」）
- **不手改 md 里的状态**（状态只在库里，手改不生效）
