# Coding review workflow

Use after code implementation and verification, before handing changes to the user.
The original coding session owns fixes and workflow progression; the independent
Codex reviewer produces findings only. All coding clients use the same CLI entrypoint.

## Run, fix, and recheck

1. Update requirement decisions, acceptance criteria, and design as needed. Save
   verification commands and results in the requirement's documents.
2. Read the explicit `wt-id` from the workspace's `AGENTS.md`. Run
   `easy-flow review <wt-id> --json`. Use `--base <ref>` for a specific comparison
   baseline or `--model <model>` for a specific model when needed.
3. Wait for completion without editing the reviewed workspace. For long-running
   execution, keep the task ID and use the current client's background-result tools
   to follow the same invocation through to its final result.
4. Read the file returned as `reportPath`. Exit code 0 and `ok=true` mean a report
   was obtained, not that no defects exist. On failure, inspect `error`, the report,
   and `logPath`. Correct execution conditions before retrying in the same bound
   reviewer session. If no valid report is available, label the review unverified.
5. Verify each finding against the agreed scope. Make the smallest appropriate fix
   and run relevant checks. Append a disposition for each finding to the report's
   processing-results section: finding ID, change location, commands, and results.
   Preserve original findings. Explain rejected findings with evidence; ask the user
   about unresolved behavior, contract, or scope decisions.
6. For high- or medium-severity findings, provide an executable reproducer: a test,
   script, or preview procedure. Code-path inspection alone is unverified. Run the
   same reproducer first during recheck.
7. Run `easy-flow review <wt-id> --recheck <absolute-previous-report-path> --json`.
   Wait and read the new report. It inherits the original baseline and reads earlier
   findings and dispositions while resuming the workspace's bound reviewer session.
8. Continue until no blocker/high findings remain. One review, one fix pass, and one
   recheck are a starting point, not a guaranteed limit. If the same issue remains
   open for two consecutive rounds, add an executable reproducer or seek a user
   decision before repeating unchanged work. Start a fresh review round without
   `--recheck` when the user adds a new review focus.
9. Record remaining findings and unverified items in the latest report's
   processing-results section. Hand over report paths, verification results, and
   decisions needed from the user. Then set the requirement to `Review`.

Keep the requirement in Implementation during automated review and fixes. For
multiple changed code workspaces, obtain a report for each; record each `wt-id`.
Their reports share the requirement's incrementing round sequence.

## Reviewer identity

Each requirement/workspace pair has one reviewer session persisted in the database.
All ordinary reviews, model changes, baseline changes, retries, and rechecks resume
it. For an older workspace without a binding, the CLI adopts the reviewer from the
latest matching report. It creates a new session only when neither a binding nor
reviewer history exists. Stop if history cannot identify the reviewer or the bound
session cannot be resumed; do not silently create a replacement.

The CLI registers the reviewer under the same requirement. Its working directory
and workspace roots point to the reviewed worktree. The reviewer is accessible in
Codex Desktop history and through easy-flow's session links. Reports record the
session ID; the binding determines identity, while the chosen report determines
round content and baseline.

Use the reviewer's configured findings criteria. A separate `self-codereview` skill,
if available to the reviewer, can supply those criteria; the caller needs only the
easy-flow review CLI and the resulting report.

## Reports and execution details

Reports and diagnostic logs live in the requirement's `docs/review/`, typically
`01-review.md`, `02-recheck.md`, and subsequent incrementing rounds. Every attempt
preserves a new report, including failures, which return a nonzero exit code.
Use report findings as the repair handoff; tool output in logs is diagnostic evidence.

The default baseline is the merge base of the main checkout's HEAD and workspace
HEAD. Review includes commits since that baseline, staged and unstaged changes,
and untracked files. `--base` selects an explicit baseline and cannot be combined
with `--recheck`.

Only one review invocation may run per workspace. A lock records its PID; verify
process state before addressing a stale lock. Do not launch duplicate invocations
merely because the first exceeds a tool's wait window.

For Chengxiaobang, where supported, start `Shell` with `run_in_background=true`,
retain the task ID, and use `TaskOutput`. In Claude Desktop or other clients, follow
the available tool definitions for background execution and result retrieval.
