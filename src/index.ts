import * as os from "node:os";
import * as path from "node:path";

import { disabledReason, getConfig, type Config } from "./config.js";
import { ConversationStore, type ConversationState } from "./state.js";
import type { HookBase, SessionStartPayload, StopPayload, Turn } from "./types.js";
import { asString, configureLogging, debugLog, infoLog, readStdin } from "./utils.js";
import { PLUGIN_VERSION } from "./version.js";

/**
 * Cursor spawns one process per hook and waits for a decision on the `before*`
 * gates, so only `stop` and `sessionEnd` may load the Langfuse SDK; every other
 * hook has to answer immediately.
 *
 * Tracing problems are logged to `<state_dir>/hook.log` and never block Cursor.
 * `LANGFUSE_CURSOR_FAIL_ON_ERROR=true` surfaces them as hook failures instead,
 * for testing.
 */

/** Decisions the gates expect. Everything we do is observe-only, so always allow. */
const PASSTHROUGH: Record<string, Record<string, unknown>> = {
  beforeSubmitPrompt: { continue: true },
  preToolUse: { permission: "allow" },
  beforeShellExecution: { permission: "allow" },
  beforeMCPExecution: { permission: "allow" },
  beforeReadFile: { permission: "allow" },
  beforeTabFileRead: { permission: "allow" },
  subagentStart: { permission: "allow" },
};

const RECORDED_HOOKS = new Set([
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "afterAgentResponse",
  "afterAgentThought",
  "preCompact",
  "stop",
  "sessionEnd",
]);

let failOnError = false;

type Context = {
  config: Config;
  store: ConversationStore;
  now: number;
  home: string;
  workspaceRoot?: string;
};

async function exportAndClose(
  ctx: Context,
  state: ConversationState,
  closedBy: Turn["closedBy"],
  stopPayload?: StopPayload,
): Promise<void> {
  const { config, store, now } = ctx;
  const turnNumber = state.openTurn?.turnNumber ?? state.turnsCompleted + 1;
  await store.withLock(async () => {
    try {
      const { exportTurn } = await import("./export.js");
      const result = await exportTurn({
        config,
        store,
        state,
        turnNumber,
        closedBy,
        stopPayload,
        now,
        home: ctx.home,
        workspaceRoot: ctx.workspaceRoot,
      });
      if (result.traceId) {
        state.exportedTraceIds.push(result.traceId);
        infoLog(
          `Exported turn ${turnNumber} (${result.eventCount} hook events, closed by ${closedBy}) as trace ${result.traceId}`,
        );
      }
    } catch (error) {
      infoLog(`Export of turn ${turnNumber} failed (closed by ${closedBy}):`, error);
      if (config.fail_on_error) throw error;
    } finally {
      // The turn is over either way; the next prompt starts a new one.
      state.turnsCompleted = Math.max(state.turnsCompleted, turnNumber);
      delete state.openTurn;
      store.writeState(state);
      // Keep events that arrived while we were exporting (they belong to the next turn).
      store.clearEvents(now + 1);
    }
  });
}

async function handle(payload: HookBase): Promise<void> {
  const hook = payload.hook_event_name;
  const workspaceRoot = Array.isArray(payload.workspace_roots)
    ? asString(payload.workspace_roots[0])
    : undefined;
  const config = getConfig({ workspaceRoot });
  configureLogging({ debug: config.debug, logFile: path.join(config.state_dir, "hook.log") });
  failOnError = config.fail_on_error;

  if (!config.enabled) {
    // One line per turn, not per event.
    if (hook === "beforeSubmitPrompt")
      infoLog(`Tracing off: ${disabledReason(config, process.env)}`);
    return;
  }
  if (!RECORDED_HOOKS.has(hook) && hook !== "sessionStart") {
    debugLog(`ignoring hook ${hook}`);
    return;
  }

  const conversationId = asString(payload.conversation_id) ?? asString(payload.session_id);
  if (!conversationId) {
    debugLog(`hook ${hook} without conversation_id; ignoring`);
    return;
  }

  const now = Date.now();
  const home = process.env.HOME ?? os.homedir();
  const store = new ConversationStore(config.state_dir, conversationId);
  const ctx: Context = { config, store, now, home, workspaceRoot };
  const state = store.readState();
  debugLog(`hook ${hook} (plugin ${PLUGIN_VERSION}) for conversation ${conversationId}`);

  switch (hook) {
    case "sessionStart": {
      const p = payload as SessionStartPayload;
      state.session = {
        composerMode: asString(p.composer_mode),
        isBackgroundAgent: p.is_background_agent === true,
        startedAt: now,
      };
      store.writeState(state);
      return;
    }

    case "beforeSubmitPrompt": {
      // A previous turn that never saw `stop` (crash, hook added mid-turn,
      // headless CLI) is flushed before the new one starts.
      if (state.openTurn || store.readEvents().length > 0) {
        await exportAndClose(ctx, state, "beforeSubmitPrompt");
      }
      state.openTurn = {
        turnNumber: state.turnsCompleted + 1,
        startedAt: now,
        generationId: asString(payload.generation_id),
      };
      store.appendEvent(payload, config.max_chars, now);
      store.writeState(state);
      return;
    }

    case "stop": {
      store.appendEvent(payload, config.max_chars, now);
      await exportAndClose(ctx, state, "stop", payload as StopPayload);
      return;
    }

    case "sessionEnd": {
      store.appendEvent(payload, config.max_chars, now);
      if (state.openTurn || store.readEvents().length > 1) {
        await exportAndClose(ctx, state, "sessionEnd");
      } else {
        store.clearEvents();
      }
      return;
    }

    case "beforeReadFile": {
      if (!config.capture_file_content && typeof payload.content === "string") {
        const { content, ...rest } = payload;
        store.appendEvent({ ...rest, content_length: content.length }, config.max_chars, now);
      } else {
        store.appendEvent(payload, config.max_chars, now);
      }
      return;
    }

    default:
      store.appendEvent(payload, config.max_chars, now);
      return;
  }
}

export async function runHook(): Promise<void> {
  // `setup` and `status` are for humans; Cursor only ever runs the bare hook.
  const subcommand = process.argv[2];
  if (subcommand === "setup" || subcommand === "status" || subcommand === "--help") {
    const cli = await import("./cli.js");
    const args = process.argv.slice(3);
    process.exitCode =
      subcommand === "status" ? await cli.runStatus(args) : await cli.runSetup(args);
    return;
  }

  let payload: HookBase | undefined;
  try {
    payload = await readStdin<HookBase>();
  } catch {
    // No usable payload: answer neutrally so Cursor is never blocked.
    process.stdout.write("{}\n");
    return;
  }
  const hook = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "";
  const response = PASSTHROUGH[hook] ?? {};
  try {
    if (payload) await handle(payload);
  } catch (error) {
    infoLog(`hook ${hook} failed:`, error);
    if (failOnError) process.exitCode = 1;
  } finally {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

runHook().catch((error) => {
  process.stderr.write(`[langfuse-cursor] fatal: ${String(error)}\n`);
  if (failOnError) process.exitCode = 1;
});
