# easy-flow command reference

Use [SKILL.md](SKILL.md) for ownership and workflow. Read this reference for command
parameters and operational details. If documentation and implementation differ,
`easy-flow <command> --help` is authoritative.

## Language selection

English is the default. Select English or Chinese in Settings; the preference is
saved and applies to the main window, mini panel, native menus, and CLI. For one CLI
invocation use `--lang en` or `--lang zh` anywhere in the arguments, or set
`EASY_FLOW_LANG`. Precedence is command flag, environment, saved preference, English.
JSON field names and machine values are language-independent. User-authored content
is preserved. New document templates follow the selected language.

## Global behavior

- `--json` returns structured output. Failures include `{"error": …}` and a nonzero
  exit code: 2 for usage errors, otherwise 1.
- Every command supports `--help`.
- Data lives under `<dataDir>/<project>/<requirement>/`. Changing the configured
  data directory selects a different board and database; do not hardcode a path.
- Angle-bracket arguments are placeholders. Use actual IDs and values when running
  commands. Ellipses indicate repeated arguments.

## English document headings

For new requirement documents, use `Summary` (or `Requirement summary`) for the
deliverable and `Repos` (or `Repos and symlinks`) for the repository table. Use
`Summary` for todo handoffs. These aliases are supported by the current parser.
Other prose sections can use headings such as `Acceptance criteria`, `Background`,
`Constraints`, `Decisions`, and `Progress`. Preserve existing IDs and any headings
whose parser compatibility has not been checked. Links remain board metadata.

## Location and context

```sh
easy-flow dir [--json]
easy-flow context <req-id|wt-id|project-slug> [--json]
```

`dir` prints the data-directory and configuration paths. `context` returns project
conventions, requirement content, `context.md`, parents and children, workspaces,
sessions, and todos. Use it when taking over a requirement or workspace.

Pass an explicit ID. Read workspace identity from `AGENTS.md` frontmatter. Inferred
todo ownership is unconfirmed until persisted with `todo set --req`. Context and
status changes may flag open todos at Review or Complete. There is no `req show`.

## Independent coding review

```sh
easy-flow review <wt-id> [--base <ref>] [--recheck <report-path>] [--model <model>] [--json]
```

- Accepts an explicit workspace ID; resolves the owning requirement and report
  directory through the board.
- Returns `ok`, `reportPath`, `logPath`, and `sessionId`. Read the report even when
  `ok=true`; success means execution completed, not that the code is defect-free.
  Failure returns `error` and a nonzero exit code while preserving its report.
- Defaults to the merge base of main-checkout HEAD and workspace HEAD, including
  committed, staged, unstaged, and untracked changes after that point.
- `--recheck` accepts a successful or failed report from the same workspace with a
  session ID. It reads dispositions and inherits the baseline. It is mutually
  exclusive with `--base`.
- The database binds one reviewer to each requirement/workspace pair. Every call
  resumes that session. An older workspace adopts the latest matching historical
  reviewer; unresolved history or resume failure stops execution.
- Only one invocation may run per workspace. Check the PID in its lock before
  addressing a stale lock.
- The independent Codex reviewer runs read-only apart from saving review artifacts.
  The caller waits, reads the report, makes fixes, and rechecks. Each round creates
  a new numbered report and diagnostic log in `docs/review/`.

Read [the complete review workflow](references/coding-review.md) before execution.

## Projects and requirements

```sh
easy-flow project new <slug> [--name <display-name>] [--json]
easy-flow req new <title> (--project <project> | --parent <req-id>) [--slug <slug>] [--summary <sentence>] [--json]
easy-flow req set <req-id> [--status <value>] [--priority <p0|p1|p2|p3|"">] [--session-analysis <pending|completed|skipped>] [--json]
```

`project new` creates the directory and project `AGENTS.md`. Its frontmatter `name`
controls the display name on the next refresh.

`req new` creates `requirement.md` and `context.md` and registers the requirement.
Choose a title describing an action and outcome; it cannot equal its slug. Slugs use
lowercase English letters, digits, and hyphens. Specify a slug when automatic
conversion is unsuitable. A child created with `--parent` has a project-relative
slug such as `parent/child`; nesting is not limited to one level. Include a
recognizable parent scope in child titles. `--summary` supplies the card's concise
deliverable description.

```sh
easy-flow project new travel --name "Travel"
easy-flow req new "Migrate meal bookings to the new service" --project travel --slug meal-migration --summary "Move meal bookings while preserving existing booking behavior."
easy-flow req set req-236d2ccb70 --status review
```

### Status values and completion

The values below are stable machine identifiers in both languages. Legacy Chinese
status labels and `Review` remain accepted as input aliases; output uses canonical values.

| Phase | `--status` value |
| --- | --- |
| Clarification | `clarification` |
| Implementation | `in_progress` |
| User review | `review` |
| Complete | `completed` |

`req set` changes only supplied fields and rejects an empty update. `--priority ""`
clears priority. Store status and priority only on the board.

Session analysis is also database state: `pending`, `completed`, or `skipped`.
CLI completion requires `completed`; a rejected closure preserves the previous
status and priority. Ask the user to arrange a separate retrospective session for
all linked sessions, save its conclusions in requirement documents, then register
`--session-analysis completed`. A conclusion of no reusable lessons is sufficient
when backed by actual analysis.

The UI can complete an unanalyzed requirement by recording `skipped`; existing
analysis results are retained. Legacy completed requirements migrate to `skipped`.
Parent requirements do not automatically close with their children.

## Links

```sh
easy-flow req link <req-id> "<label>=<url>" ["<label>=<url>" …] [--json]
```

Register related tasks, PRs/MRs, designs, documents, monitoring, and screenshots.
Labels are optional; a plain URL is accepted. Only HTTP(S) URLs are supported.

```sh
easy-flow req link req-236d2ccb70 "Design=https://example.com/design" --json
easy-flow req link req-236d2ccb70 "https://gitlab.example.com/group/repo/-/merge_requests/12?tab=notes" --json
```

Calls add links without deleting existing ones. Repeating a URL updates its label,
or preserves the existing label when none is supplied. An equals sign in a query
string is not treated as a label separator when its left side already contains
`://`.

Keep labels short. Without a label, the board derives a name: `repository !number`
for GitLab MRs, `repository #number` for GitHub PRs, a path without the domain and
`/detail` for Feishu/Lark, otherwise the last path segment. Register the actual
MR/PR page, rather than a repository homepage, for status lookup.

Verify the target in returned `links[].url`. The board is authoritative; do not
maintain a duplicate list in `requirement.md`. Context and status updates warn when
links are absent but a workspace exists or the requirement has reached Review.

## Tags

```sh
easy-flow taglist [--project <project>] [--json]
easy-flow req tag add <req-id> <tag>… [--json]
easy-flow req tag rm <req-id> <tag>… [--json]
easy-flow req tag set <req-id> [<tag>…] [--json]
easy-flow req tag ls <req-id> [--json]
```

Check the vocabulary with `taglist` before adding tags. Reuse existing terms.
Tags live only in the database and appear on cards.

- At most three tags per requirement. Remove one or replace the set before adding
  to a full set; `add` rejects overflow.
- At most 24 characters per tag; no whitespace or leading `#`. The board and
  Command-K search use `#tag` filters.
- Matching trims whitespace and ignores case while preserving established spelling.
  Repeated adds are idempotent; removing a missing tag is harmless.
- `set` replaces all tags; no tags clears the set.
- `taglist` includes completed requirements, sorts by descending usage then name,
  and omits unused terms. `--project` limits its scope.

Example: `easy-flow req tag add req-236d2ccb70 board cards`.

## Sessions

```sh
easy-flow req session add <req-id> --agent <claude|codex|cursor|chengxiaobang> [--id <session-id>] [--title <title>] [--cwd <directory>] [--link <url>] [--json]
easy-flow req session ls [<req-id>] [--json]
easy-flow req session rm <req-id> --agent <agent> --id <session-id> [--json]
```

Register when starting work or handing off to another agent. Registration is a
navigation record, not proof that the session is running; the board reads runtime
state separately. It is stored in the database, not the requirement directory.

`--cwd` defaults to the current directory. Use a title describing the current work;
the board cannot rely on retrieving the client's session title. Repeating `add`
for the same session refreshes its fields and timestamps. When changing ownership,
register it under the new requirement.

If `--id` is omitted, the command reads the current agent's environment:

| Agent | Session ID source | Default session link |
| --- | --- | --- |
| `claude` | `CLAUDE_CODE_HOST_SESSION_ID` / `CLAUDE_CODE_SESSION_ID` | `claude://claude.ai/epitaxy/<id>` for desktop `local_` IDs; no session link for terminal sessions |
| `codex` | `CODEX_THREAD_ID` | `codex://threads/<id>` |
| `cursor` | `CURSOR_CONVERSATION_ID` | No session-level deep link |
| `chengxiaobang` | `CHENGXIAOBANG_SESSION_ID` | `chengxiaobang://session/<id>` |

Missing environment IDs cause an error; check the agent or pass the actual ID.
Do not invent one. Example:
`easy-flow req session add req-236d2ccb70 --agent codex --title "Consolidate review links"`.

## Workspaces

```sh
easy-flow wt new <req-id> --repo <repository-name-or-main-checkout-path> --branch <branch> [--base <ref>] [--short <short-name>] [--json]
easy-flow wt rm <wt-id> [--force] [--json]
```

`wt new` creates `<repository>.<branch>` beside the main checkout and registers it
under the requirement. The default base is the main checkout's HEAD. Follow the
repository's branch conventions; easy-flow itself uses `feature-<requirement-slug>`.
`--short` matches the repository short name in `requirement.md` and selects
`docs/<short-name>/`.

The workspace contains identity `AGENTS.md`, a `requirement.md` link, and a `design/`
link. Generated entries go in Git's `info/exclude`. Repeating creation at the same
path is idempotent; interrupted creation leaves the site intact for diagnosis and
retry rather than deleting potentially unrelated work.

Example:
`easy-flow wt new req-236d2ccb70 --repo easy-flow --branch feature-unified-links --short easy-flow`.

`wt rm` removes the directory, Git worktree registration, and easy-flow record. It
retains the branch and rejects uncommitted changes unless `--force` is supplied.
Use force only with authorization to discard those changes.

## Todo commands

```sh
easy-flow todo new <title> [--source feishu|chat|agent|manual] [--req <req-id>] [--link <url>] [--summary <handoff>] [--session <session-id>] [--ref <dedup-key>] [--json]
easy-flow todo set <todo-id>… [--status todo|in_progress|done|cancelled] [--req <req-id>] [--title <title>] [--summary <handoff>] [--json]
easy-flow todo list [--status <value>] [--req <req-id>] [--session <session-id>] [--orphan] [--all] [--limit <n>] [--json]
easy-flow todo show <todo-id> [--json]
easy-flow todo promote <todo-id> --project <project> [--slug <slug>] [--title <title>] [--json]
easy-flow todo import <directory> [--dry-run] [--json]
```

Todos are global, linked to requirements through a pointer rather than owned by
projects. See [SKILL.md](SKILL.md) for explicit, inferred, and unassigned ownership.
IDs are assigned by first import/capture date as `T-YYYYMMDD-NNN`.

`todo set` updates titles and summaries in the document; workflow metadata stays
on the board. Empty strings clear supported fields. Batch updates cannot change
titles or summaries. See `--help` for additional capture fields such as `--channel`,
`--from`, `--chat`, and `--at`.

`promote` creates a requirement from the todo's title and handoff summary and fills
in its requirement pointer in one operation. It rejects an already-linked todo and
reports the owning requirement. `import` is a one-time migration of legacy daily
todo files; it imports only unfinished work, leaves completed items in place, and
is safe to repeat. Preview imports with `--dry-run`.

### Capture fields

| Field | Meaning |
| --- | --- |
| `id` | Automatically assigned `T-YYYYMMDD-NNN` |
| `status` | `todo`, `in_progress`, `done`, or `cancelled` |
| `source` | `feishu` for Feishu messages; `chat` for conversation capture; `agent` for discovered follow-up work; `manual` for a user-requested entry |
| `session` | Actual source session ID; required for `agent` and `chat` |
| `channel` | Feishu only: `at_me` or `p2p` |
| `from` / `chat` | Source person and conversation/group name |
| `ref` | Deduplication key; use a Feishu message ID for Feishu sources |
| `req` | Owning requirement ID; an existing requirement can own an unpromoted todo |
| `link` | Navigable source, merge-request, or page URL |
| `at` | Source event time, `yyyy-mm-dd HH:mm` |
| `summary` | Known results, next action, completion criteria, key IDs, and evidence; include steps already resolved so successors do not repeat them |

### Capture and maintain

1. Look for an existing main todo for the same source and work. Update its summary
   rather than opening a duplicate. `--ref` reports an existing entry on duplicates;
   use `todo set` to update it.
2. Obtain the actual session ID for `agent`/`chat` sources. If unavailable, report
   the limitation and obtain a valid ID before capture; never fabricate a session.
3. Create an actionable entry with enough handoff context:

   ```sh
   easy-flow todo new "Add descriptive review-link labels" --req req-236d2ccb70 --source agent --session "<actual-session-id>" --summary "Review URLs are registered. Next: add short labels and verify them with context. Complete when every registered review link has a descriptive label."
   ```

4. For Feishu capture, also include `--ref`, `--channel`, `--link`, `--from`, and
   `--chat` as appropriate. Report the resulting ID and a one-line title.
5. On starting work, set `in_progress`; on satisfying completion criteria, set
   `done` and append a result to the todo document's progress section. Retain the
   entry rather than deleting it.

Keep todo listings brief: ID, status, source, title, source person, and link. Capture
concrete next steps that await authorization or a decision too; title them as
obtaining authorization or confirming the decision. Update that same entry after
resolution. Do not capture vague ideas without an action and completion criteria.

Avoid raw logs, idle conversation, duplicate subtasks for one piece of work,
missing source-session IDs, empty handoff summaries, and manually edited status
fields. Keep evidence links and conclusions instead of making the next agent
repeat completed investigation.
