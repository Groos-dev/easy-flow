# easy-flow

以 markdown 为内容源、SQLite 为状态源的需求看板。

需求目录由 agent 直接在文件系统里建，应用不提供创建入口；应用负责把目录扫进库里、
让人看见状态、读写需求文档。agent 那侧由 CLI 与 skill 承载（见 `skill/SKILL.md`），
在任意目录都能接活，不依赖这个应用开着。

## 跑起来

| 命令 | 做什么 |
| --- | --- |
| `pnpm dev` | 完整应用：Electron 主进程内嵌服务 + 窗口 |
| `pnpm app start\|stop\|restart\|status` | 同上，但脱离终端跑：日志与 PID 在 `.tmp/`，关掉终端窗口不会带走应用 |
| `pnpm dev:server` + `pnpm dev:web` | 浏览器开发；Vite 把 `/api` 代理到 `127.0.0.1:3210` |
| `pnpm test` | 回归测试（`node --test`），重构时的行为基线 |
| `pnpm typecheck` | 两套 tsconfig：node 侧（server / main / preload / test）、web 侧（renderer） |
| `pnpm dead-code` | 找仓库内无引用的导出符号；预留接口需人工判断 |
| `pnpm build` | 三端产物打到 `out/` |
| `pnpm cli <命令>` | 直接跑 CLI（`pnpm cli --help`）；装好的 shim 是 `easy-flow <命令>` |

数据目录等偏好存在应用配置里，**换目录等于换一整套看板数据**（状态在库里，
不在 md 里）；设置页可以切、可以重新扫描。

## 三层

| 目录 | 职责 |
| --- | --- |
| `server/` | 数据层与 HTTP 层。`db.ts` 是 SQLite 门面（状态的唯一权威），`markdown.ts` 只读文件不持状态，`http.ts` 是 CORS / JSON / 文档读写的零件，`index.ts` 是路由 |
| `src/main/` | Electron 主进程：起内嵌服务、开窗口、菜单与原生目录选择 |
| `src/renderer/` | 渲染层（React）。数据只经 HTTP 拿（开发与打包共用同一套代码）；原生目录选择走 preload 桥的 IPC |
| `server/cli.ts` | 给 agent 与脚本用的命令行（context / project new / req new\|set\|link / wt new\|rm），与 HTTP 层共用同一个数据层 |
| `skill/SKILL.md` | agent 的接入说明（触发条件、意图→命令对照），由设置页链进各 agent 的 skills 目录 |

`tsx server/dev.ts` 提供第三种跑法：只起 HTTP 服务，不拉 Electron。

## 目录约定

```
<dataDir>/<项目>/<需求>/
```

- **需求目录**必须齐备 `requirement.md`（需求描述：看板卡片的标题取 H1、摘要取「需求」段）
  与 `AGENTS.md`（身份 id 写在 frontmatter，外加给 agent 的指令）——缺一份就不算需求
- **子需求**就是需求目录里的需求目录，判据与一层时完全一样，层级不限。它和普通需求
  一样入库、一样出现在看板上，也能按 id 反查；`slug` 是相对项目根的路径
  （顶层 `alpha`，子需求 `alpha/gateway`），卡片上直接显示这个路径。父子关系另存在
  库里（`parent_id`），需求没 id 时它为空，层级仍能从 slug 看出来
- **状态**（看板列、优先级、链接）只存在 `easy-flow.db` 里，永远不写进 md：
  agent 重写需求文档不会把状态弄丢，代价是换数据目录等于换状态
- `_templates/`（下划线开头的目录）是模板收纳处，不会被当成项目；模板缺哪个补哪个，
  已存在的不覆盖，所以改模板只对新数据目录生效

## 工作区

`create_worktree` 在主 checkout 旁边建 `<仓库>.<分支>`，并补齐三样产物：

- `AGENTS.md`：worktree 的身份（id）与指令。**归属只存在 sqlite 里**——需求目录没有
  指向 worktree 的反向指针，文件系统证明不了某个工作区属于谁
- `requirement.md` 软链：指向需求目录，agent 在代码仓里也能读到需求
- `design/` 软链：指向需求目录的 `docs/<短名>/`。设计的物理文件留在需求目录
  （单一副本、随需求长存），工作区里就近写；仓库的 `info/exclude` 会把这些产物挡在
  `git status` 之外

创建不回滚：中途失败就留现场报错。重试是幂等的（认领已存在的目录，id 从它自己的
`AGENTS.md` 读回来），而回滚要先判断「哪些是本次造的」，判错一次就是删掉别人未提交的改动。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `EASY_FLOW_CONFIG` | 配置文件路径。主进程与 MCP 注册都会带上它，好让各方开同一个库 |
| `EASY_FLOW_USER_DATA` | 配置与默认数据目录的基目录（默认 macOS 的 Application Support） |
| `EASY_FLOW_REPO_ROOTS` | 按仓库名找 checkout 的根目录，冒号分隔（默认 `~/repo`） |
| `PORT` | 只给 `server/dev.ts` 用 |

没设配置时，数据目录优先沿用已存在的 `~/requirements`（开发便利），否则落到
`<userData>/data`。
