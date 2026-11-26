---
name: easy-flow
description: >-
  Manage requirements, workspaces, todos, and durable development context with
  easy-flow. Use for ongoing development work, requirement handoffs, status and
  link updates, coding reviews, and session retrospectives. Skip one-off questions
  or small tasks that need no retained context.
---

# easy-flow

One requirement represents one verifiable deliverable. Keep what to build in
`requirement.md` and why in `context.md`. The board stores workflow metadata;
Markdown stores content. The desktop app displays both.

The next agent relies on `easy-flow context`. Attach decisions, sessions, links,
workspaces, and follow-up work to the owning requirement as they arise.

Write instructions, explanations, titles, summaries, and new prose in English
unless the user requests another language. Preserve IDs, paths, command flags,
required document headings, and machine values. Requirement statuses use stable English machine values, independent of the selected
display language. Legacy Chinese values remain accepted as input aliases.
Use supported English document headings for new content (see the command reference).
Do not translate existing data or change the application's language as a side effect.

## Start with ownership

1. In a requirement or workspace, read its explicit `req-…` or `wt-…` ID and run
   `easy-flow context <id>`. A workspace's identity is in its `AGENTS.md` frontmatter.
2. Elsewhere, run `easy-flow dir`. Search `**/requirement.md` in that data directory
   for the relevant repository and unfinished deliverable. Reuse a unique match
   only when its scope fits; do not attach unrelated work merely because it uses
   the same repository. If several scopes fit and context cannot distinguish them,
   ask which deliverable owns the work before changing its metadata.
3. If none fits, create a requirement under the appropriate project:
   `easy-flow req new "<action and outcome>" --project <project> --slug <slug> --summary "<deliverable>"`.
   Use `--parent <req-id>` instead of `--project` for a child requirement.
4. Register the current session:
   `easy-flow req session add <req-id> --agent codex --title "<current work>"`.
   Substitute the actual agent: `claude`, `codex`, `cursor`, `chengxiaobang`, or `antigravity`.
5. Read the todo section. Confirm inferred ownership with
   `easy-flow todo set <todo-id> --req <req-id>` before treating it as assigned.

If work has started without an owner, establish ownership before continuing.
Do not create requirements for disposable questions or read-only spot checks.

## Clarify only material uncertainty

Proceed when you can write acceptance criteria. Ask about outcomes, motivation,
boundaries, and acceptance when those are unclear; keep implementation out of
requirement clarification. Ask about competing approaches only when neither is
clearly better and choosing incorrectly would cause rework.

Respect authorization already given in the conversation. Before an irreversible
change or an external action such as publishing, pushing, opening a merge request,
or merging, establish authorization for that action. Prepare the reviewable work
first. Updating the user's own board and requirement metadata needs no separate
confirmation. Record consequential decisions in `context.md`; revisit them if scope
or contracts change.

## Deliver the requirement

| Phase | CLI status value | Work and evidence |
| --- | --- | --- |
| Prepare | `clarification` | Define deliverable, acceptance criteria, boundaries, and repositories. |
| Implementation | `in_progress` | Create a workspace for code changes, implement, verify, and update context. |
| User review | `review` | Complete independent coding review and required fixes, then hand over evidence. |
| Complete | `completed` | After merge and acceptance, satisfy the session-analysis requirement and close. |

Set status with `easy-flow req set <req-id> --status <value>`. Keep implementation,
fixes, and automated review in Implementation; switch to Review when handing work
to the user. Priorities are `p0`, `p1`, `p2`, `p3`; status and priority live only on
the board, never as manually maintained fields in Markdown.

### Code changes

Create a workspace before editing code:

```sh
easy-flow wt new <req-id> --repo <repository> --branch <branch> --short <short-name>
easy-flow context <wt-id>
```

Edit code in this workspace, not the main checkout or default branch. A workspace
sits beside the main checkout as `<repository>.<branch>` and contains its identity,
a `requirement.md` link, and a `design/` link to requirement-owned documents.
Do not invent a workspace for documentation-only skill edits outside a Git checkout.

After implementing and verifying code, read
[the coding review workflow](references/coding-review.md), run
`easy-flow review <wt-id> --json`, wait, and read the report. Verify findings, fix
confirmed in-scope defects, and recheck with
`easy-flow review <wt-id> --recheck <previous-report-path> --json` until no
blocker/high findings remain. A successful command means a report was produced,
not that the changes passed review. Never silently replace a bound reviewer session.

### Closure and retrospectives

The CLI permits Complete only when `session-analysis` is `completed`. When blocked
by this check, ask the user to arrange a separate session to analyze all linked agent
sessions. Do not mark analysis completed merely to bypass the check.

For retrospective work, first read
[session sources and evidence](references/session-retrospective.md). Save conclusions
under `docs/retro/`, then register `--session-analysis completed`; a supported finding
of no reusable lessons is valid. The UI may close an unanalyzed requirement with
`skipped`; this does not count as completed analysis for CLI closure.

Child completion does not automatically complete the parent. Assess the parent's
remaining acceptance criteria separately, even when the CLI mentions it.

## Keep context attached

| Information | Location or action |
| --- | --- |
| Deliverable, acceptance, repositories | `requirement.md`; preserve template headings used by the application |
| Motivation, constraints, decisions | `context.md` |
| Design, research, implementation evidence | `docs/<short-name>/`; workspace `design/` points here |
| Review reports and responses | `docs/review/` |
| Session-analysis conclusions | `docs/retro/` |
| Links to tasks, PRs/MRs, designs, documents, monitoring, screenshots | `easy-flow req link <req-id> "<label>=<https-url>" --json` |
| Current agent session | `easy-flow req session add <req-id> --agent <agent> --title "<work>"` |
| Follow-up work | `easy-flow todo new "<action>" --req <req-id> --source agent --session "<actual-session-id>" --summary "<handoff>"` |
| Status and priority | `easy-flow req set`; board only |
| Tags | Check `easy-flow taglist`, then `easy-flow req tag add <req-id> <tag>…` |

Register links as soon as obtained or changed. Verify that returned `links[].url`
contains the target URL. The board is the link authority; do not maintain a second
link list in `requirement.md`. Keep labels short and descriptive.

## Todos

Todos are global entries in the same board data, not a separate project or board.
The app opens individual todos from a requirement's related-todos section; use the
CLI for global todo management.

| Ownership | Action |
| --- | --- |
| Explicit `--req` | Work under that requirement. Mark `done` when its completion criteria are met. |
| Inferred from the source session | Confirm scope, then persist the requirement pointer with `todo set --req`. |
| Unassigned | Choose to do it (`in_progress`), cancel it (`cancelled`), or promote it to a requirement. |

Unassigned todos become overdue after seven days. Cancellation is a normal outcome.
For missing or completed requirement pointers, check the recorded closure decision
before reassigning or closing. If the user explicitly paused work and retained a
recovery todo, preserve it and document the blocker, recovery steps, and completion
criteria. Ending tracking or pausing work does not mean the deliverable is done.

Keep one main todo per source and piece of work. Split only for independently
closeable deliverables, different ownership/schedules, or substantial separate work.
A summary must let the next agent continue without this conversation: include known
results, next action, completion criteria, key IDs, and evidence locations.

For `agent` or `chat` sources, retain the actual source session identifier. Do not
invent it. Change titles and summaries through `todo set`; never manually store
status in todo Markdown. At Review or Complete, close only the todos whose criteria
are satisfied; leave the others actionable.

Read [the command reference](REFERENCE.md) for capture fields, promotion, import,
batch updates, and detailed command behavior.

## Command conventions and recovery

- Pass explicit IDs; never infer identity from the current directory alone.
- Slugs use lowercase English letters, digits, and hyphens. Specify `--slug` when
  automatic derivation is unsuitable. A requirement title cannot equal its slug.
- Titles describe an action and outcome. Child titles include a recognizable parent
  scope because the board does not group them by parent.
- Check `easy-flow <command> --help` for parameters not documented here. There is no
  `easy-flow req show`; use `easy-flow context <req-id>`.
- On `database is locked`, wait 2–4 seconds and retry the same operation. If it
  persists, inspect the contention; do not rebuild or clear the database.
- The desktop app's `sync_with_base_branch` cannot synchronize easy-flow-created
  workspaces. Use Git fetch and merge with the repository's intended base branch.
- Read only the reference needed for the current operation:
  [commands](REFERENCE.md), [coding review](references/coding-review.md), or
  [session retrospectives](references/session-retrospective.md).
