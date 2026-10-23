/**
 * 建表与老库升级。跟 BoardDatabase 分开放，是为了让"表长什么样"独立成一份
 * 可以直接读的 DDL，而不是埋在 800 行查询代码的开头。
 */
import type { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  root         TEXT NOT NULL,
  has_convention INTEGER NOT NULL DEFAULT 0,
  mtime        INTEGER NOT NULL DEFAULT 0,
  updated      TEXT
);

CREATE TABLE IF NOT EXISTS requirement (
  slug     TEXT NOT NULL,
  project  TEXT NOT NULL DEFAULT '',
  id       TEXT,
  parent_id TEXT,
  title    TEXT NOT NULL,
  path     TEXT NOT NULL,
  status   TEXT NOT NULL,
  priority TEXT,
  summary  TEXT,
  repos    TEXT,
  links    TEXT,
  feishu_task_links TEXT,
  code_links     TEXT,
  ext_links    TEXT,
  mtime    INTEGER NOT NULL DEFAULT 0,
  updated  TEXT,
  missing  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, project)
);

CREATE TABLE IF NOT EXISTS doc (
  slug    TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  name    TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (slug, project, name)
);

/*
 * todo：全局待办。和需求平级，但不受项目划分——一条待办不属于任何项目。
 * 一条待办一份 md（<dataDir>/_todos/<id>.md）放内容，这张表放元数据；
 * 与需求同一套分工：md 是"有没有"的事实源，状态只归这里。
 * req_id 是唯一一处与需求的关系：立项后指过去，需求侧的反查块靠它查，不另存反向列表。
 */
CREATE TABLE IF NOT EXISTS todo (
  id       TEXT PRIMARY KEY,
  title    TEXT NOT NULL,
  status   TEXT NOT NULL,
  source   TEXT NOT NULL DEFAULT '',
  session  TEXT,
  channel  TEXT,
  origin   TEXT,
  chat     TEXT,
  ref      TEXT,
  req_id   TEXT,
  link     TEXT,
  happened TEXT,
  summary  TEXT,
  path     TEXT NOT NULL,
  mtime    INTEGER NOT NULL DEFAULT 0,
  created  TEXT,
  updated  TEXT,
  missing  INTEGER NOT NULL DEFAULT 0
);

/*
 * worktree：需求的工作区。文件系统只能证明它存在，证明不了它属于谁——
 * 需求目录里没有反向指针，所以关系只存在这张表里，创建时必须落库。
 */
CREATE TABLE IF NOT EXISTS worktree (
  id       TEXT PRIMARY KEY,
  req_id   TEXT NOT NULL,
  short    TEXT NOT NULL DEFAULT '',
  repo     TEXT NOT NULL,
  branch   TEXT NOT NULL,
  path     TEXT NOT NULL,
  main     TEXT NOT NULL,
  created  TEXT,
  updated  TEXT,
  missing  INTEGER NOT NULL DEFAULT 0
);

/*
 * session：agent 会话的登记。agent 在需求下开工时把自己的会话写进来，看板据此一键回到现场。
 * 与 worktree 同一套道理：会话是 agent 应用里的东西，文件系统里没有任何凭据，
 * 所以「哪条需求上有哪些会话」只存在这张表里。主键是 agent + 会话 id——
 * 同一个会话重新登记只会刷新字段，不会长出第二条。
 */
CREATE TABLE IF NOT EXISTS session (
  req_id   TEXT NOT NULL,
  agent    TEXT NOT NULL,
  session  TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'dev',
  title    TEXT,
  cwd      TEXT,
  link     TEXT,
  created  TEXT,
  updated  TEXT,
  PRIMARY KEY (agent, session)
);

/*
 * session_state：会话状态。三类来源都写它——hook 事件、拉取文件、板侧点击（点一下 pet = 这条静止）。
 * 状态一变就落库，所以重启后原样还在；读口只查这张表。
 * action_text / action_called_at 是最近一次工具调用（气泡里那句「在干什么」），没有时是空串与 0。
 * hook_event 是 hook 事件名，通知层据此判断 Interrupt；拉取来源没有，记空串。
 */
CREATE TABLE IF NOT EXISTS session_state (
  agent        TEXT NOT NULL,
  session      TEXT NOT NULL,
  state        TEXT NOT NULL,
  needs_action TEXT NOT NULL DEFAULT '',
  observed_at  INTEGER NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  hook_event   TEXT NOT NULL DEFAULT '',
  action_text  TEXT NOT NULL DEFAULT '',
  action_called_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, session)
);

/*
 * session_source：登记 id → 状态层 key 的翻译。claude 桌面会话登记的是 local_<uuid>，
 * 而 hook 报的是内层 uuid，不翻就落在两个格子里。只有拉取侧读得到记录文件，翻译落在库上，
 * 读口与点击只查它。
 */
CREATE TABLE IF NOT EXISTS session_source (
  agent     TEXT NOT NULL,
  session   TEXT NOT NULL,
  state_key TEXT NOT NULL,
  PRIMARY KEY (agent, session)
);

/*
 * source_file：读外部文件读到哪儿了——mtime 用来判断「这份文件变没变」，offset 是增量读到第几字节，
 * state 是那份文件 fold 出来的状态。都是记账，丢了只是重读一遍，不会算错。
 */
CREATE TABLE IF NOT EXISTS source_file (
  path     TEXT NOT NULL,
  mtime_ms REAL NOT NULL DEFAULT 0,
  offset   INTEGER NOT NULL DEFAULT 0,
  state    TEXT,
  PRIMARY KEY (path)
);

CREATE INDEX IF NOT EXISTS idx_doc_scope ON doc(project, slug);
CREATE INDEX IF NOT EXISTS idx_req_project ON requirement(project);
CREATE INDEX IF NOT EXISTS idx_todo_status ON todo(status);
CREATE INDEX IF NOT EXISTS idx_todo_ref ON todo(ref);
CREATE INDEX IF NOT EXISTS idx_todo_req ON todo(req_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_path ON worktree(path);
CREATE INDEX IF NOT EXISTS idx_wt_req ON worktree(req_id);
CREATE INDEX IF NOT EXISTS idx_session_req ON session(req_id);
`

/** 老库升级：补齐后加的列 */
function migrate(db: DatabaseSync): void {
  const addIfMissing = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  // 状态与看板列合并：老库的 stage（7 档）改名 status 并映射到 4 档
  const cols = db.prepare('PRAGMA table_info(requirement)').all() as Array<{ name: string }>
  if (cols.some((c) => c.name === 'stage') && !cols.some((c) => c.name === 'status')) {
    db.exec('ALTER TABLE requirement RENAME COLUMN stage TO status')
    db.exec(`UPDATE requirement SET status = CASE
      WHEN status IN ('方案', '开发') THEN '执行中'
      WHEN status IN ('联调', '发布', '验证验收') THEN 'Review'
      WHEN status = '关闭' THEN '已完成'
      ELSE '澄清' END`)
  }

  // 与界面的「失联」对齐：记录在、文件/目录没了。老库的 orphan 列改名 missing
  for (const table of ['requirement', 'todo', 'worktree']) {
    const names = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (names.some((c) => c.name === 'orphan') && !names.some((c) => c.name === 'missing')) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN orphan TO missing`)
    }
  }

  addIfMissing('requirement', 'project', `project TEXT NOT NULL DEFAULT ''`)
  addIfMissing('doc', 'project', `project TEXT NOT NULL DEFAULT ''`)
  // 需求身份。索引必须建在补列之后——写在 SCHEMA 里，老库会先于补列执行而报找不到列
  addIfMissing('requirement', 'id', 'id TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_req_id ON requirement(id)')
  // 子需求：父需求的 id。层级同时体现在 slug（parent/child）里，这里存一份便于按父子查
  addIfMissing('requirement', 'parent_id', 'parent_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_req_parent ON requirement(parent_id)')
  // Links: written by the CLI; the UI only displays them
  addIfMissing('requirement', 'feishu_task_links', 'feishu_task_links TEXT')
  addIfMissing('requirement', 'code_links', 'code_links TEXT')
  addIfMissing('requirement', 'ext_links', 'ext_links TEXT')
  // 会话角色：开工登记的 dev，review 会话是 review。老库里的会话都是开工时登记的
  addIfMissing('session', 'role', `role TEXT NOT NULL DEFAULT 'dev'`)
  addIfMissing('session_state', 'action_text', `action_text TEXT NOT NULL DEFAULT ''`)
  addIfMissing('session_state', 'action_called_at', 'action_called_at INTEGER NOT NULL DEFAULT 0')
  // hook 事件名单独存一列：通知层判断 Interrupt 用结构化字段，
  // 不靠 detail 文案
  addIfMissing('session_state', 'hook_event', `hook_event TEXT NOT NULL DEFAULT ''`)
}

/** 建表 + 升级，开库时跑一次 */
export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA)
  migrate(db)
}
