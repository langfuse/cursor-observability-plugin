#!/usr/bin/env node
import { l as infoLog, o as configureLogging, p as readStdin, r as asString, s as debugLog, t as PLUGIN_VERSION } from "./version-B2EdcJjP.mjs";
import { n as disabledReason, r as getConfig, t as ConversationStore } from "./state-DHhYKuAQ.mjs";
import { t as applyCapturePolicy } from "./privacy-BohI-nng.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

//#region src/index.ts
/**
* Cursor spawns one process per hook and waits for a decision on the `before*`
* gates, so only `stop` and `sessionEnd` may load the Langfuse SDK; every other
* hook has to answer immediately.
*
* Tracing problems are logged to `<state_dir>/hook.log` and never block Cursor.
* `LANGFUSE_CURSOR_FAIL_ON_ERROR=true` surfaces them as hook failures instead,
* for testing.
*/
/**
* User-facing setup message for a new chat with no project API key.
*
* `sessionStart` is the hook Cursor documents as accepting `additional_context`.
* `beforeSubmitPrompt` can show `user_message` only when `continue` is false,
* which would discard the user's first prompt, so a missing key never blocks.
* An already-open chat does not receive `sessionStart`; `/langfuse-setup`
* covers that case. Keep the steps aligned with `commands/langfuse-setup.md`.
*
* The leading sentence is the signal `rules/langfuse-setup.mdc` matches.
* A kill switch or `"enabled": false` does not get this text: the user turned
* tracing off on purpose.
*
* Empty key and baseUrl fields keep tracing off. Placeholder strings like
* `pk-lf-...` would count as keys and the hint would never show again.
* baseUrl stays empty so the file does not pick a region for the user.
*/
function credentialsFile(home) {
	return path.join(home, ".cursor", "langfuse.json");
}
function ensureCredentialsFile(home) {
	const file = credentialsFile(home);
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify({
			publicKey: "",
			secretKey: "",
			baseUrl: ""
		}, null, 2)}\n`);
		fs.chmodSync(file, 384);
	}
	return file;
}
function setupMessage(file) {
	return [
		"Langfuse tracing is not configured.",
		"",
		"Create a project at https://langfuse.com/cloud if you don't have one. In the project, open Settings → API Keys and copy the public key, secret key, and base URL for your region.",
		"",
		"Self-hosted: follow https://langfuse.com/self-hosting (Langfuse v4) and use your instance URL as the base URL.",
		"",
		`Paste the public key, secret key, and base URL into ${`[${file}](${pathToFileURL(file).href})`}.`
	].join("\n");
}
/** Decisions the gates expect. Everything we do is observe-only, so always allow. */
const PASSTHROUGH = {
	beforeSubmitPrompt: { continue: true },
	preToolUse: { permission: "allow" },
	beforeShellExecution: { permission: "allow" },
	beforeMCPExecution: { permission: "allow" },
	beforeReadFile: { permission: "allow" },
	beforeTabFileRead: { permission: "allow" },
	subagentStart: { permission: "allow" }
};
const RECORDED_HOOKS = /* @__PURE__ */ new Set([
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
	"sessionEnd"
]);
let failOnError = false;
async function exportAndClose(ctx, state, closedBy, stopPayload) {
	const { config, store, now } = ctx;
	const turnNumber = state.openTurn?.turnNumber ?? state.turnsCompleted + 1;
	await store.withLock(async () => {
		try {
			const { exportTurn } = await import("./export-C23vuE3p.mjs");
			const result = await exportTurn({
				config,
				store,
				state,
				turnNumber,
				closedBy,
				stopPayload,
				now,
				home: ctx.home,
				workspaceRoot: ctx.workspaceRoot
			});
			if (result.traceId) {
				state.exportedTraceIds.push(result.traceId);
				infoLog(`Exported turn ${turnNumber} (${result.eventCount} hook events, closed by ${closedBy}) as trace ${result.traceId}`);
			}
		} catch (error) {
			infoLog(`Export of turn ${turnNumber} failed (closed by ${closedBy}):`, error);
			if (config.fail_on_error) throw error;
		} finally {
			state.turnsCompleted = Math.max(state.turnsCompleted, turnNumber);
			delete state.openTurn;
			store.writeState(state);
			store.clearEvents(now + 1);
		}
	});
}
async function handle(payload, response) {
	const hook = payload.hook_event_name;
	const workspaceRoot = Array.isArray(payload.workspace_roots) ? asString(payload.workspace_roots[0]) : void 0;
	const config = getConfig({ workspaceRoot });
	payload = applyCapturePolicy(payload, config);
	configureLogging({
		debug: config.debug,
		logFile: path.join(config.state_dir, "hook.log")
	});
	failOnError = config.fail_on_error;
	if (!config.enabled) {
		if (hook === "beforeSubmitPrompt") infoLog(`Tracing off: ${disabledReason(config, process.env)}`);
		if (hook === "sessionStart" && disabledReason(config, process.env).startsWith("Langfuse config incomplete")) {
			const home = process.env.HOME ?? os.homedir();
			const file = credentialsFile(home);
			try {
				ensureCredentialsFile(home);
			} catch (error) {
				infoLog("could not create credentials file:", error);
			}
			response.additional_context = setupMessage(file);
		}
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
	const ctx = {
		config,
		store,
		now,
		home,
		workspaceRoot
	};
	const state = store.readState();
	debugLog(`hook ${hook} (plugin ${PLUGIN_VERSION}) for conversation ${conversationId}`);
	switch (hook) {
		case "sessionStart": {
			const p = payload;
			state.session = {
				composerMode: asString(p.composer_mode),
				isBackgroundAgent: p.is_background_agent === true,
				startedAt: now
			};
			store.writeState(state);
			return;
		}
		case "beforeSubmitPrompt":
			if (state.openTurn || store.readEvents().length > 0) await exportAndClose(ctx, state, "beforeSubmitPrompt");
			state.openTurn = {
				turnNumber: state.turnsCompleted + 1,
				startedAt: now,
				generationId: asString(payload.generation_id)
			};
			store.appendEvent(payload, config.max_chars, now);
			store.writeState(state);
			return;
		case "stop":
			store.appendEvent(payload, config.max_chars, now);
			await exportAndClose(ctx, state, "stop", payload);
			return;
		case "sessionEnd":
			store.appendEvent(payload, config.max_chars, now);
			if (state.openTurn || store.readEvents().length > 1) await exportAndClose(ctx, state, "sessionEnd");
			else store.clearEvents();
			return;
		default:
			store.appendEvent(payload, config.max_chars, now);
			return;
	}
}
async function runHook() {
	const subcommand = process.argv[2];
	if (subcommand === "setup" || subcommand === "status" || subcommand === "--help") {
		const cli = await import("./cli-DHWpcEEa.mjs");
		const args = process.argv.slice(3);
		process.exitCode = subcommand === "status" ? await cli.runStatus(args) : await cli.runSetup(args);
		return;
	}
	let payload;
	try {
		payload = await readStdin();
	} catch {
		process.stdout.write("{}\n");
		return;
	}
	const hook = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "";
	const response = { ...PASSTHROUGH[hook] ?? {} };
	try {
		if (payload) await handle(payload, response);
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

//#endregion
export { runHook };