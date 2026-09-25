# Cursor integration: analysis and design notes

Written 2026-09-11 while building the first version of this plugin. It records
what the existing Langfuse coding-agent integrations cover, what customers
asked for in their issue trackers, what Cursor exposes, and the decisions taken
here, so a reviewer can check the reasoning rather than reverse-engineer it.

## 1. What our integrations cover today

Sources: the Claude Code, Codex, OpenCode and Pi plugins (README + source, as of
2026-09-10) and their GitHub issues and PRs.

| Capability                                  | Claude Code (Python hook)                      | Codex (TS plugin)                        | OpenCode (TS plugin)               | Pi (TS extension)                         |
| ------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Mechanism                                   | `Stop`/`SessionEnd` hook reads transcript      | `Stop` hook reads rollout JSONL          | In-process plugin, OpenCode events | In-process extension, Pi lifecycle events |
| One trace per user prompt, session grouping | yes (`Conversational Turn`, session id)        | yes (`Codex Turn`, thread id)            | yes                                | yes, turn numbering survives restart      |
| Constant trace name for name-based grouping | yes (issue #50)                                | yes                                      | yes                                | yes (PR #11)                              |
| Generations with conversation history input | yes (PR #80)                                   | previous tool results as input           | yes (issue #24, PR #29)            | yes                                       |
| Tool calls with input, output, error level  | yes (PR #77, #84)                              | yes                                      | yes (issues #9, #22)               | yes                                       |
| Token usage incl. cache / reasoning splits  | yes, cache-write priced by TTL (#34, #73)      | yes (normalised, #39)                    | yes                                | yes (PR #2, #7)                           |
| Thinking / reasoning blocks                 | yes (PR #76)                                   | reasoning summaries                      | yes (PR #4)                        | n/a                                       |
| Subagents nested under the spawning turn    | yes, incl. teams and workflows (#11, #45, #66) | yes (#42, #45)                           | yes (#8, #20, #27)                 | yes (PR #3)                               |
| Images as Langfuse media                    | yes (PR #56)                                   | no                                       | no                                 | yes (PR #5)                               |
| Skill tags                                  | yes (`skill:<name>`)                           | PR open (#67)                            | no                                 | no                                        |
| Operator tags / metadata on every trace     | yes (`CC_LANGFUSE_TRACE_TAGS`, #62, #69)       | yes (`LANGFUSE_CODEX_TAGS`, `_METADATA`) | requested (#34)                    | no                                        |
| User id                                     | configured                                     | configured or Codex auth email           | configured                         | configured                                |
| Environment / release labels                | via SDK env                                    | yes                                      | yes                                | yes                                       |
| Deterministic trace ids for harnesses       | yes (`CC_LANGFUSE_TRACE_SEED`)                 | yes (`LANGFUSE_CODEX_TRACE_SEED`)        | no                                 | no                                        |
| Attach to a parent trace (traceparent)      | yes (PR #32)                                   | PR open (#72)                            | child sessions link to parent      | subagent context via env                  |
| Kill switch                                 | requested (#35)                                | opt-in `TRACE_TO_LANGFUSE`               | remove plugin                      | `LANGFUSE_TRACING_ENABLED=false`          |
| Config precedence env > project > global    | yes (#30, #47)                                 | yes                                      | env or file                        | env over file                             |
| Truncation of large payloads                | `CC_LANGFUSE_MAX_CHARS`                        | `LANGFUSE_CODEX_MAX_CHARS`               | no                                 | PR to remove (#32)                        |
| Secret masking                              | no                                             | no                                       | no                                 | yes (Langfuse keys)                       |
| Dedup across re-fired hooks / resumes       | state + deterministic ids (#19, #33, #38)      | sidecar of uploaded turn ids (#46, #66)  | n/a                                | n/a                                       |
| Never block the agent (fail open)           | yes                                            | yes, `FAIL_ON_ERROR` for testing         | yes                                | yes                                       |
| Self-explaining log file                    | yes (`langfuse_hook.log`, #78)                 | debug to stderr                          | no                                 | status line                               |
| Windows                                     | uv/python                                      | fixed (#55, #61, #64)                    | n/a                                | n/a                                       |

### What customers asked for, by theme

Counted across the four trackers (about 190 issues and PRs):

1. **Nothing silently lost.** Duplicate or missing turns are the largest theme:
   Claude #33/#48/#67, Codex #12/#46/#51/#65/#66, OpenCode #20. Root causes
   were lock timeouts, hooks firing before the transcript was flushed, resumed
   sessions re-ingesting history, and turns without ids that could not be
   deduplicated.
2. **Correct token and cost accounting.** Cache splits, TTL pricing, double
   counted cached input, reasoning tokens (Claude #21/#34, Codex #22/#28/#39,
   Pi #2/#7/#10).
3. **Debuggable generations.** Real input (system prompt and history), rendered
   tool calls and thinking blocks, correct latency (OpenCode #1/#24, Claude
   #39/#68/#77, Codex #47).
4. **Subagents visible and attached** (Claude #5/#28/#43, Codex #41/#44,
   OpenCode #8/#20).
5. **Operational control.** Operator tags and metadata for shared projects,
   per-project routing, kill switch, deterministic ids for harnesses, parent
   trace attachment, configurable state dir (Claude #30/#35/#41/#62/#69,
   OpenCode #34, Codex #72).
6. **It has to run where people run the agent.** Desktop app PATH problems,
   Windows shells, proxies and TLS (Claude #12/#18/#75, Codex #32/#55).

## 2. What Cursor exposes

Source: https://cursor.com/docs/hooks (reference section, 2026-09), the Cursor
Cloud Agents docs, forum threads by Cursor staff, and a real transcript
captured by the `entireio/cli` project.

### Hooks

21 hook events, run as child processes with JSON on stdin/stdout. Every payload
carries `conversation_id`, `generation_id`, `model`, `model_id`,
`model_params`, `cursor_version`, `workspace_roots`, `user_email` and
`transcript_path`. Relevant per-event data:

| Hook                                           | Gives us                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `beforeSubmitPrompt`                           | prompt text, attachments (turn start)                                                                                              |
| `preToolUse` / `postToolUse`                   | tool name, input, JSON output, `tool_use_id`, cwd, duration                                                                        |
| `postToolUseFailure`                           | error message, failure type (error / timeout / permission_denied), interrupt                                                       |
| `beforeShellExecution` / `afterShellExecution` | full command, full terminal output, sandbox flag, duration                                                                         |
| `beforeMCPExecution` / `afterMCPExecution`     | MCP server name, params, result JSON                                                                                               |
| `afterFileEdit`                                | file path and diff hunks                                                                                                           |
| `beforeReadFile`                               | file path and full content (we store only the length by default)                                                                   |
| `afterAgentThought`                            | aggregated thinking text and duration                                                                                              |
| `afterAgentResponse`                           | completed assistant message text                                                                                                   |
| `subagentStart` / `subagentStop`               | type, task, model, status, summary, counts, modified files, own transcript path                                                    |
| `preCompact`                                   | context size, usage percent, messages compacted                                                                                    |
| `stop`                                         | status, loop count, and in recent builds `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` (undocumented) |
| `sessionStart` / `sessionEnd`                  | composer mode, background flag, duration, reason                                                                                   |

### Transcript

`~/.cursor/projects/<sanitized workspace path>/agent-transcripts/<id>/<id>.jsonl`
(IDE, nested) or `<id>.jsonl` (CLI, flat). Rows are
`{"role":"user"|"assistant","message":{"content":[blocks]}}` plus
`{"type":"turn_ended","status":"success"}` markers. Assistant rows carry text
and `tool_use` blocks (name + input, no id). User rows wrap the prompt in
`<timestamp>` and `<user_query>` tags. The file has **no timestamps, no tool
results, no token usage and no message ids** (confirmed by Cursor staff on the
forum), and it is not guaranteed to be flushed when `stop` fires.

### Where hooks run

- IDE: everything.
- Cloud Agents: project hooks (`.cursor/hooks.json`) and team/enterprise hooks
  only. No `~/.cursor`, no `sessionStart`/`sessionEnd`, no MCP hooks, no Tab
  hooks; hooks are off during early read-only turns. Secrets come from the
  Cloud Agents dashboard as environment variables.
- CLI (`agent`): `transcript_path` is `null`; interactive mode fires the full
  lifecycle, headless `-p` mode fires only session and tool hooks.
- Known Cursor bugs (forum, 2026-08/09): `subagentStop` never fires for
  background subagents; `summary`, `modified_files` and `agent_transcript_path`
  are often missing or null.

### What Cursor does not give us

- Per-model-call token usage. Usage is per turn, on `stop`, and only in recent
  builds. There is no request-level boundary at all except the assistant rows
  in the transcript.
- The system prompt, rules and skills content that formed the request.
- Tool results in the transcript; only the hooks have them.
- Images: not in the transcript. Where they do live is unclear on current
  builds. Older sources describe a per-session SQLite store at
  `~/.cursor/chats/<workspace>/<session>/store.db`, but that path does not exist
  on 3.20.10; `state.vscdb` carries a `composer.planMigrationToHomeDirCompleted`
  flag, so Cursor moved this data into the home directory. What remains in
  SQLite are leftovers (`composerData:`, `bubbleId:`) plus a new
  `conversation-search.db` full-text index whose `conversations.source` column
  allows `'local'` and `'cloud-cache'`.
- Cursor's Enterprise OpenTelemetry export sends metrics and logs, never traces
  or prompt content, so it cannot feed Langfuse's OTLP endpoint (which accepts
  traces only; `/v1/metrics` is a no-op and `/v1/logs` does not exist).

## 3. Design decisions

1. **Event log + transcript, assembled at `stop`.** Every hook appends one
   line to a per-conversation file and returns in ~40 ms; nothing loads the
   SDK on the blocking gates. `stop` merges the log with the transcript. The
   transcript is optional (CLI, disabled transcripts) and only improves
   generation boundaries and history; the hooks carry the essential data.
   This mirrors the Codex and Claude plugins (transcript at Stop) while
   respecting that Cursor's gates block the agent loop.
2. **One trace per turn, `Cursor Turn`, session = `conversation_id`, user =
   Cursor account email.** Same shape as Codex (`agent` root, `LLM`
   generations, tool observations) so dashboards and evaluators built for one
   coding agent work for the other.
3. **Deterministic ids for everything.** Trace id from
   `cursor:<conversation>:<turn>` (or a seed), span ids from stable labels via a
   custom OpenTelemetry `IdGenerator`. Re-fired `stop` hooks, follow-up loops
   and crash retries upsert instead of duplicating. This is the direct answer
   to theme 1 above without a sidecar ledger.
4. **Turn usage on the last generation, explicit zeros elsewhere.** Langfuse
   infers tokens from text for a generation that names a model but reports no
   usage, which would double count on top of the turn total. Zero usage with
   `cursor.usage_scope` metadata keeps cost exact. Usage keys are the generic
   Anthropic-style `input` (fresh), `output`, `cache_read_input_tokens`,
   `cache_creation_input_tokens`; the live test priced Opus correctly.
5. **Generation input = conversation history.** Earlier transcript turns plus
   the running user/assistant/tool messages of the current turn, as in Claude
   #80 and OpenCode #24. The system prompt is unavailable and omitted.
6. **Never lose a turn.** `beforeSubmitPrompt` and `sessionEnd` flush an open
   turn as `interrupted` (WARNING). Export failures are logged with the cause
   and the turn is closed, so one bad upload cannot wedge the next turns.
   `withLock` times out instead of dropping (Claude #48).
7. **Config like Codex, kill switch like Pi.** Global and project
   `langfuse.json` (snake_case and camelCase accepted), env wins,
   `LANGFUSE_CURSOR_*` over `LANGFUSE_*`, `LANGFUSE_TRACING_ENABLED=false`
   kill switch. On by default when keys exist, because project hooks in a repo
   run on every teammate's machine and asking each of them to opt in defeats
   the point.
8. **Privacy defaults.** File contents from `beforeReadFile` are not stored
   (length only); tool outputs can be switched off; Langfuse keys are masked;
   everything is clipped to `max_chars`.
9. **Two distribution paths, one bundle.** A Cursor Plugin
   (`.cursor-plugin/plugin.json` + `hooks/hooks.json`, committed `dist/`) for
   the IDE and marketplace, and an npm package with a `langfuse-cursor-hook` bin
   for project hooks in Cloud Agents, the CLI and team repos.

## 4. Verified

- Test suite (55 tests): transcript parsing against a real Cursor session,
  config precedence, turn assembly (event-only and with transcript, failures,
  subagents, MCP naming), the emitted observation tree against an in-memory
  OpenTelemetry exporter (structure, deterministic ids, usage, levels,
  traceparent), hook-list parity across the three places they are declared, and
  the built bundle end to end: a conversation driven through `dist/index.mjs`
  with the OTLP request asserted at a receiver in the test process.
- Against Langfuse Cloud project `testing_ccode`, from replayed hook payloads:
  two traces in one session, 17 observations in turn 1 (root agent, 5 `LLM`
  generations, 6 tool calls including one `ERROR`, a `Cursor Subagent` with two
  `LLM Subagent` generations and its own `Read` tool, one compaction event),
  turn usage priced by Langfuse's `claude-opus-4-7` model definition ($0.111
  for turn 1, $0.040 for turn 2, exactly the reported turn usage):
  - https://cloud.langfuse.com/project/cmqqw1yao001iad0dohmvzben/traces/8507d1a8213bb383f5af81bc458c20d4
  - https://cloud.langfuse.com/project/cmqqw1yao001iad0dohmvzben/traces/37647e384f2fb2e2cb14aaf0a3f1ac2e
- Setup and status: keys verified against the Langfuse API before anything is
  written, nothing written on a 401, hook registration idempotent and merging
  with hooks from other tools.

**Confirmed against a real Cursor session** (3.20.10, 2026-09-11, two turns in
the IDE agent):

- `input_tokens` / `output_tokens` **do arrive** on `stop`, undocumented but
  present: one turn reported 28,697 input and 367 output. `cache_read_tokens`
  and `cache_write_tokens` were absent or zero in those turns.
- `afterAgentResponse` fired **once per turn**, not once per assistant message:
  one turn had a single `afterAgentResponse` while the transcript held two
  assistant rows. The trace still shows two generations, because the split falls
  back to the transcript rows. That fallback is what makes the per-message split
  work at all.
- The turn still had **no cost**, and not because of missing tokens: Langfuse has
  no price definition matching the model Cursor reported (`cursor-grok-4.6-medium`
  / `grok-4.6`). Zero of 182 model definitions match it. This is a gap in
  Langfuse's model list, not in the plugin, and it affects every non-Anthropic,
  non-OpenAI model Cursor offers.
- `sessionStart` had not fired for a conversation that was already open when the
  hooks were installed, so `cursor.composer_mode` and `cursor.background_agent`
  were missing from that trace. The same will happen in Cloud Agents, where
  `sessionStart` never fires, so those two fields cannot be used to tell local
  from cloud apart. `CURSOR_CODE_REMOTE` (set by Cursor in remote workspaces) is
  the better signal and is not read yet.

**Still unverified.** Both concern the plugin install path, not the hooks:

- That Cursor expands `${CURSOR_PLUGIN_ROOT}` in a plugin's `hooks.json`
  commands, and which working directory plugin hooks get. `setup --hooks`
  sidesteps this by writing absolute paths, which is how the real session above
  was traced.
- The real `tool_name` for MCP tools in `preToolUse` (`MCP:<tool>` per the
  matcher docs). Matching is tolerant of the variants seen so far.

A real session records every raw payload to
`~/.cursor/langfuse/conversations/<id>/events.jsonl`, which is the ground truth
for checking the rest.

## 5. Gaps and follow-ups

| Gap                                     | Why                                                                                  | Option                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cost for non-OpenAI/Anthropic models | Langfuse has no price definition for the Grok, Gemini and other models Cursor offers | Add the model names Cursor reports to Langfuse's model definitions; own ticket, independent of this plugin                                                                                    |
| Per-request token usage                 | Cursor reports usage per turn only                                                   | Ask Cursor (forum thread 166592 already requests it); for headless runs wrap `agent --print --output-format stream-json`, whose `result` event has usage                                      |
| Images                                  | Not in transcript or hooks                                                           | Locate them first: the `~/.cursor/chats/.../store.db` path from older sources is gone on 3.20.10. Reading Cursor's SQLite means tracking a schema mid-migration, which is what LangSmith does |
| System prompt / rules / skills content  | Not exposed                                                                          | Tag `skill:<name>` from `beforeReadFile` paths under `.cursor/skills` or `SKILL.md` (cheap, next version)                                                                                     |
| Headless CLI turns without prompt       | `beforeSubmitPrompt` and `stop` do not fire in `-p` mode                             | Same CLI wrapper as above                                                                                                                                                                     |
| Background subagents never stop         | Cursor bug                                                                           | Already flagged with WARNING; revisit when fixed                                                                                                                                              |
| Windows                                 | Cursor spawns through cmd.exe                                                        | The hook command is a plain `node …` invocation; needs a Windows run to confirm quoting                                                                                                       |

## 6. Open before publishing

1. **One real Cursor session**, to settle the four assumptions in section 4.
2. **The borrowed test fixture.** `test/fixtures/transcript-real-session.jsonl`
   comes from `entireio/cli` (MIT, Copyright 2026 Entire Inc.) and
   `test/fixtures/NOTICE.md` carries the required notice. Cleaner: capture and
   redact a transcript from one of our own sessions, then drop the notice.
3. **Decide the default.** Tracing starts as soon as both keys are present,
   while the Codex plugin requires an explicit `TRACE_TO_LANGFUSE=true`. Project
   hooks in a shared repo run on every teammate's machine, so this should be a
   conscious call.
4. **A logo and `interface.brandColor`** when submitting to the marketplace. A
   relative `logo` path resolves to a `raw.githubusercontent.com` URL, so it
   only renders once the repo is public and listed; it was removed for now.
5. **A screenshot for the docs page**, from a real session. Every other
   developer-tool integration page has one.
6. **`CONTRIBUTING.md`**, as the OpenCode plugin has, covering the build and the
   committed-`dist` rule.
7. **A self-hosted smoke test.** The TypeScript SDK needs platform >= 3.95.0;
   only Cloud was exercised.
