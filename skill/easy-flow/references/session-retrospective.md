# Session retrospective sources

First snapshot the requirement and registered sessions with
`easy-flow req session ls <req-id>`. Select sessions by requirement scope and retain
relevant history across months. Distinguish current registration from historical
work ownership within a session.

## Read-only sources

These locations were verified locally in November 2026. Check actual paths and
schemas when client versions change. Treat every source as read-only.

| Client | Index and message sources |
| --- | --- |
| Claude | Read `cliSessionId` from desktop `claude-code-sessions/.../local_*.json`, then read `~/.claude/projects/.../<cliSessionId>.jsonl`. |
| Codex | Use `threads` in `~/.codex/state_5.sqlite` to locate `rollout_path` and `history_mode`. For migrated sessions, read `item_json` from `thread_history_1.sqlite` table `thread_items`, ordered by `rollout_ordinal`. |
| Cursor | Combine JSONL with `Library/Application Support/Cursor/User/globalStorage/state.vscdb`. The `cursorDiskKV` session prefix for `bubbleId` contains messages and tools; composer headers and `createdAt` help recover order. |
| Chengxiaobang | Read `messages` in `~/.chengxiaobang/data/chengxiaobang.sqlite` by `created_at` and stable row order. Combine `content` and `payload` to reconstruct messages, `toolCall`, and `toolResult`. |
| Antigravity | Read `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (Agent Manager; the IDE and CLI use `antigravity-ide` and `antigravity-cli`). The file is a rolling window rewritten at checkpoints; also read `transcript_full.jsonl` and use the larger one. Steps carry `type` such as `USER_INPUT` and `PLANNER_RESPONSE`. Not yet verified on this machine. |

- Claude's `attachment.queued_command` also contains mid-session input. Values
  `human`/`humanTurn` in `origin.kind` identify human instructions;
  `task-notification` identifies task notifications. Check both and preserve roles.
- Identify mirrored tool records by `tool_use_id` or `call_id`. Index record counts
  are not deduplicated tool-call counts.
- Cursor's `toolFormerData.result` can be a JSON string; terminal content is in its
  parsed `output`. An empty result provides no verified output. KV records may
  contain later messages absent from JSONL; include the final turns.
- Prefer Codex's original messages and tool records. Turn summaries do not replace
  complete sessions. Private reasoning and repeated system prompts are not user
  decisions.

## Attribute evidence and conclusions

Include identifiable unregistered validation sessions that clearly belong to the
requirement. Count shared sessions once and attribute relevant phases to their
actual requirements. When a session was rebound, use the timing of internal work;
do not assign its entire history to its last registered requirement.

For each session, state which messages, tool calls/results, and supplementary
sources were read, plus what is missing. Retain original message IDs and source
file or export line numbers. Quote only necessary redacted excerpts; never retain
cookies or keys in reports.

Distinguish an actual skill gap, reusable knowledge, behavior already covered by
the current skill, and insufficient evidence. Read the current skill before
recommending changes. Keep versions and conditions attached to isolated cases.
Describe tests, checks, merges, releases, and business acceptance separately.
If the user ends tracking or pauses work, record the closure reason and explicitly
retained recovery todos.

Save conclusions under the requirement's `docs/retro/`. After analysis, register
`easy-flow req set <req-id> --session-analysis completed`. A documented conclusion
that no reusable lessons were found is valid. Do not change installed skills or
long-term memory merely because a retrospective recommends it; implement those
changes only within the user's authorized scope.
