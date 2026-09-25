# Langfuse Observability Plugin for Cursor

This plugin sends [Cursor](https://cursor.com) agent sessions to
[Langfuse](https://langfuse.com). It records the user prompts, the agent turns,
the model generations, the tool calls with their outputs, subagents and the
per-turn token usage, with no change to the way you work.

Langfuse documents this integration on the
[Cursor integration page](https://langfuse.com/integrations/developer-tools/cursor).

> [!WARNING]
> This is an experimental release, so future versions can bring breaking changes.

## What can this integration trace?

The plugin runs as a set of [Cursor hooks](https://cursor.com/docs/hooks). Every
hook appends its event to a small per-conversation log, and the `stop` hook
turns that log plus Cursor's own transcript into one Langfuse trace per turn:

- **Agent turns**: one trace per user prompt (`Cursor Turn`), with all turns of
  a conversation grouped under one session ID. Aborted and failed turns carry a
  `WARNING` or `ERROR` level.
- **Model generations**: one `LLM` observation per assistant message, with the
  conversation history as input, the assistant text, thinking blocks and the
  requested tool calls as output, and the model with its parameters
  (thinking, context, effort).
- **Token usage and cost**: Cursor reports input, output, cache-read and
  cache-write tokens once per turn on the `stop` hook. The plugin records them
  on the turn's last generation, so Langfuse prices the turn with its model
  definitions. Older Cursor builds do not send these fields; the trace then has
  no usage.
- **Tool calls**: every tool Cursor runs (`Shell`, `Read`, `Write`,
  `StrReplace`, `Grep`, `Glob`, `Task`, MCP tools) as a tool observation with
  input, output, duration, working directory and sandbox flag. Failed, timed
  out and denied calls are flagged with their error. File edits carry the
  diff hunks Cursor reports.
- **Subagents**: `Task` subagents nest under the tool call that spawned them,
  with task, summary, status, counts, and their own transcript as nested
  `LLM Subagent` generations when Cursor provides its path.
- **Context compaction**: an event with the context size before compaction.
- **Sessions, users, tags**: turns are grouped by Cursor's conversation id, the
  user is the signed-in Cursor account (override with `LANGFUSE_USER_ID`), and
  every trace carries the `cursor` tag plus your own.

Tracing covers the Cursor IDE agent, Cloud Agents (project hooks) and the
Cursor CLI. See [Where hooks run](#where-hooks-run) for the differences.

## Prerequisites

- Node.js 22 or newer on the `PATH` of the process that launches Cursor.
  A GUI app on macOS does not read your shell profile, so a Node installed
  through a version manager may be invisible to it; see
  [Troubleshooting](#troubleshooting).
- A [Langfuse Cloud](https://cloud.langfuse.com) account or a
  [self-hosted](https://langfuse.com/self-hosting) instance (v3.95.0 or newer),
  and a project API key pair.

## Install

### Option 1: Cursor Plugin (IDE, per user)

Until the plugin is listed on the Cursor Marketplace, load it as a local plugin
and run `setup`:

```bash
git clone https://github.com/langfuse/cursor-observability-plugin ~/.cursor/plugins/local/langfuse-observability
node ~/.cursor/plugins/local/langfuse-observability/dist/index.mjs setup \
  --public-key pk-lf-… --secret-key sk-lf-…
```

Then restart Cursor (or run **Developer: Reload Window**). The plugin ships its
own `hooks/hooks.json`, so there is no hooks file to write by hand, and `dist/`
is committed, so no build step runs on your machine.

On Teams and Enterprise plans an admin has to allow local plugin imports, or
distribute the repository through a team marketplace.

### Option 2: npm package (Cloud Agents, CLI, teams)

```bash
npm install -g @langfuse/cursor-observability-plugin
langfuse-cursor-hook setup --public-key pk-lf-… --secret-key sk-lf-… --hooks
```

`--hooks` registers every agent hook in `~/.cursor/hooks.json`. Add
`--project .` to write the repository's `.cursor/hooks.json` instead, which is
what Cloud Agents and the CLI read; see [Cloud Agents](#cloud-agents).

### What `setup` does

- Verifies the keys against the Langfuse API and names the project they belong
  to, so a wrong key or the wrong data region fails immediately rather than
  silently.
- Writes `~/.cursor/langfuse.json` with mode 600 (or `<project>/.cursor/` with
  `--project`). Nothing is written when the keys do not verify.
- With `--hooks`, registers the 18 agent hooks, merging with hooks from other
  tools and replacing its own entries on a re-run. The command depends on the
  scope: a user-level `~/.cursor/hooks.json` pins the absolute path of the
  `node` that ran setup, because a Cursor launched from Finder does not inherit
  your shell `PATH`. A project-level file (`--project`) is meant to be
  committed, so it calls `langfuse-cursor-hook` through `PATH` instead, which is
  what works on teammates' machines and in Cloud Agent VMs.

Options: `--base-url`, `--environment`, `--project <path>`, `--hooks`. Without
keys it prints usage. Keys are also picked up from `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY`.

### Check the setup

```bash
langfuse-cursor-hook status
```

Prints the resolved configuration, which config files it read, whether the
connection works, how many hooks are registered, and the last exported traces.

### Manual alternative

Everything `setup` writes is plain JSON you can write yourself. Create
`~/.cursor/langfuse.json`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development"
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is omitted, the
plugin uses `https://cloud.langfuse.com` (EU region). `userId` defaults to the
email of the signed-in Cursor account.

Or set environment variables where Cursor can see them:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com" # 🇪🇺 EU (default)
```

Configuration is resolved as **defaults → `~/.cursor/langfuse.json` →
`<project>/.cursor/langfuse.json` → environment variables** (environment wins).
`LANGFUSE_CURSOR_*` variables take precedence over the matching `LANGFUSE_*`
variables, so you can scope credentials to Cursor without disturbing other
Langfuse tooling.

Tracing is on as soon as both keys are present. Run a prompt in Cursor, then
open your Langfuse project to see the trace.

## Configuration options

| Config key (`langfuse.json`)                  | Environment variable                                           | Default                      | Description                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `publicKey` / `public_key`                    | `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_CURSOR_PUBLIC_KEY`           | —                            | Langfuse public key (`pk-lf-...`). Required.                                                |
| `secretKey` / `secret_key`                    | `LANGFUSE_SECRET_KEY` / `LANGFUSE_CURSOR_SECRET_KEY`           | —                            | Langfuse secret key (`sk-lf-...`). Required.                                                |
| `baseUrl` / `base_url`                        | `LANGFUSE_BASE_URL` / `LANGFUSE_CURSOR_BASE_URL`               | `https://cloud.langfuse.com` | Langfuse host. US: `https://us.cloud.langfuse.com`, Japan: `https://jp.cloud.langfuse.com`. |
| `enabled`                                     | `LANGFUSE_TRACING_ENABLED` / `LANGFUSE_CURSOR_ENABLED`         | `true`                       | Kill switch. `false` stops tracing without removing the keys.                               |
| `environment`                                 | `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_CURSOR_ENVIRONMENT` | —                            | Langfuse environment label (e.g. `production`).                                             |
| `release`                                     | `LANGFUSE_RELEASE` / `LANGFUSE_CURSOR_RELEASE`                 | —                            | Release label for the traces.                                                               |
| `userId` / `user_id`                          | `LANGFUSE_USER_ID` / `LANGFUSE_CURSOR_USER_ID`                 | Cursor account email         | User id attached to every trace.                                                            |
| `tags`                                        | `LANGFUSE_TAGS` / `LANGFUSE_CURSOR_TAGS`                       | —                            | Extra trace tags, JSON array or comma-separated. `cursor` is always added.                  |
| `metadata`                                    | `LANGFUSE_CURSOR_METADATA`                                     | —                            | JSON object of trace metadata (string values, ≤200 characters).                             |
| `traceSeed` / `trace_seed`                    | `LANGFUSE_CURSOR_TRACE_SEED`                                   | —                            | Deterministic trace ids, see [Deterministic trace ids](#deterministic-trace-ids).           |
| `traceparent`                                 | `LANGFUSE_CURSOR_TRACEPARENT`                                  | —                            | W3C traceparent of an existing trace to attach turns to.                                    |
| `maxChars` / `max_chars`                      | `LANGFUSE_CURSOR_MAX_CHARS`                                    | `20000`                      | Truncate captured strings to this many characters.                                          |
| `captureToolOutput` / `capture_tool_output`   | `LANGFUSE_CURSOR_CAPTURE_TOOL_OUTPUT`                          | `true`                       | Store shell output, MCP results and tool outputs.                                           |
| `captureFileContent` / `capture_file_content` | `LANGFUSE_CURSOR_CAPTURE_FILE_CONTENT`                         | `false`                      | Store the file contents Cursor passes to `beforeReadFile` (only their length by default).   |
| `stateDir` / `state_dir`                      | `LANGFUSE_CURSOR_STATE_DIR`                                    | `~/.cursor/langfuse`         | Directory for the per-conversation event logs, state and `hook.log`.                        |
| `debug`                                       | `LANGFUSE_CURSOR_DEBUG`                                        | `false`                      | Verbose logging to `<stateDir>/hook.log`.                                                   |
| `failOnError` / `fail_on_error`               | `LANGFUSE_CURSOR_FAIL_ON_ERROR`                                | `false`                      | Report export errors as hook failures instead of failing open. Useful while testing.        |

## Where hooks run

| Surface              | What you get                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cursor IDE agent     | Everything above. The transcript path arrives in every hook payload.                                                                                                                                                                             |
| Cloud Agents         | Project hooks from `.cursor/hooks.json` only; `~/.cursor` is not available. `sessionStart`, `sessionEnd` and the MCP hooks do not fire there, and hooks start only once the agent has a writable environment. See [Cloud Agents](#cloud-agents). |
| Cursor CLI (`agent`) | Interactive mode fires the full lifecycle. Headless `agent -p` runs fire only `sessionStart`, `sessionEnd` and the tool hooks: the plugin then exports the run as one turn when the session ends, without prompt or token usage.                 |
| Self-hosted machines | Same as Cloud Agents, plus `sessionStart` and `sessionEnd`.                                                                                                                                                                                      |

### Cloud Agents

1. Install the hook binary in the agent environment. Add it to the install step
   of your `.cursor/environment.json`, or to the environment's install script in
   the Cloud Agents dashboard:

   ```json
   { "install": "npm install -g @langfuse/cursor-observability-plugin" }
   ```

2. Register the project hooks and commit them:

   ```bash
   langfuse-cursor-hook setup --project . --hooks --public-key pk-lf-… --secret-key sk-lf-…
   git add .cursor/hooks.json      # the keys file stays local, do not commit it
   ```

   [`templates/project-hooks.json`](./templates/project-hooks.json) is the same
   file with `langfuse-cursor-hook` as the command, if you prefer to copy it.

3. Add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` as
   **Secrets** in the Cloud Agents dashboard. They are injected as environment
   variables when an agent starts; agents already running do not see new
   secrets.

Cloud agent traces carry `cursor.workspace_roots` pointing at the VM checkout
and the user of the Cursor account that started the agent.

## Deterministic trace ids

Trace ids are derived from the conversation, so exporting a turn twice updates
the same trace instead of creating a duplicate:

- Turn N of a conversation: `hex(sha256("cursor:<conversation_id>:<N>")).slice(0, 32)`.
- With `LANGFUSE_CURSOR_TRACE_SEED=<seed>`: `hex(sha256("<seed>:<N>")).slice(0, 32)`,
  which a harness can compute before the run starts. Use a unique seed per
  conversation.

Both derivations match the Langfuse SDKs' `createTraceId(seed)` helper.

## Attach runs to an existing trace

When your own instrumented workflow drives Cursor, pass the W3C traceparent of
your span as `LANGFUSE_CURSOR_TRACEPARENT`. Every turn then appears under that
span, and the trace name, session, user and tags stay under your control.

## Enable and disable tracing

| Scope                     | How                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| One project               | Create `<project>/.cursor/langfuse.json` with `{ "enabled": false }`                         |
| The current shell         | `export LANGFUSE_TRACING_ENABLED=false` (undo with `unset`)                                  |
| Everywhere, keep the keys | Add `"enabled": false` to `~/.cursor/langfuse.json`                                          |
| Remove the plugin         | Delete `~/.cursor/plugins/local/langfuse-observability`, or the `.cursor/hooks.json` entries |

When tracing is off the hooks still answer Cursor (always `allow`), write no
state and record one `Tracing off: <reason>` line per turn in `hook.log`.

## Troubleshooting

Nearly every failure explains itself in `~/.cursor/langfuse/hook.log`. Send one
message, then match the newest lines against this table:

| What the log shows                               | What to do                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No log file at all                               | The hooks never ran. Check the **Hooks** tab in Cursor's Customize view and the Hooks output channel. A common cause is `node` missing from the PATH Cursor was launched with: install Node system-wide, or launch Cursor from a shell that has it (`cursor .`). |
| `Tracing off: Langfuse config incomplete`        | The keys did not reach the hook. GUI apps do not read your shell profile, so prefer `~/.cursor/langfuse.json` over `export`.                                                                                                                                     |
| `Tracing off: kill switch`                       | `LANGFUSE_TRACING_ENABLED=false` is set somewhere in the inherited environment.                                                                                                                                                                                  |
| `Export of turn N failed`                        | Delivery failed after the turn was assembled. Check `baseUrl` against the region of your keys, key validity, and proxy reachability. Set `LANGFUSE_CURSOR_DEBUG=true` for the full error.                                                                        |
| `Exported turn N ... as trace <id>` but no trace | Ingestion is asynchronous; wait a few seconds. Then confirm the keys belong to the project you are looking at.                                                                                                                                                   |
| `transcript not readable`                        | Cursor did not hand over a transcript (CLI mode, or transcripts disabled). The turn is still traced from the hook events; only the conversation history and exact message boundaries are missing.                                                                |

Cursor runs each hook as a separate process with a timeout. The per-event fast
path takes about 40 ms; the `stop` hook takes a few hundred milliseconds while
it uploads.

## Data sent to Langfuse

When enabled, the plugin uploads prompts, assistant messages, thinking text,
tool inputs and outputs (shell output, MCP results, file edits), subagent
tasks and summaries, model names and parameters, token usage, workspace paths
and the Cursor account email. File contents that Cursor reads are not stored
unless `captureFileContent` is on; tool outputs can be switched off with
`captureToolOutput`. Your Langfuse keys are masked from every payload before
upload. Do not enable tracing for work you do not want stored in Langfuse.

## How it works

Cursor spawns a process per hook and pipes a JSON payload to it. The plugin
splits its work into a fast path and a slow path:

1. **Every hook** appends its payload (strings clipped to `maxChars`) to
   `~/.cursor/langfuse/conversations/<conversation_id>/events.jsonl` and
   answers immediately. The blocking gates (`beforeSubmitPrompt`, `preToolUse`,
   `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`,
   `subagentStart`) always answer `allow`.
2. **`stop`** reads the event log and Cursor's transcript
   (`~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`), waits
   briefly for Cursor to flush the turn, and merges them: the transcript gives
   the assistant message boundaries and the conversation history, the hooks
   give timing, tool outputs, failures, thinking, subagents and token usage.
3. The turn is emitted with the
   [Langfuse TypeScript SDK](https://langfuse.com/docs/observability/sdk/overview)
   on OpenTelemetry, with deterministic trace and observation ids, then flushed.
4. `beforeSubmitPrompt` and `sessionEnd` flush a turn that never saw `stop`
   (a crash, or a headless CLI run) as an `interrupted` turn.

The hook fails open: any tracing error is logged and swallowed so it never
blocks Cursor.

## Development

```bash
pnpm install
pnpm run lint      # prettier, tsc, build
pnpm test          # builds, then runs the test suite
```

The suite covers the transcript reader against a real Cursor session, config
precedence, turn assembly, the emitted observation tree against an in-memory
OpenTelemetry exporter, and the built bundle end to end: a small conversation is
driven through `dist/index.mjs` and the OTLP request is asserted at a receiver
in the test process, so no keys and no network are needed.

The bundle in `dist/` is committed because Cursor loads marketplace plugins
straight from Git. Run `pnpm run build` after changing `src/` and commit the
result; CI fails when the bundle is stale.

## Release

1. Bump the version in `package.json`, `.cursor-plugin/plugin.json` and
   `src/version.ts`, rebuild, and merge.
2. Tag the commit `v<version>` and push the tag. The release workflow stages
   the npm package and drafts a GitHub release.

## License

[MIT](./LICENSE)
