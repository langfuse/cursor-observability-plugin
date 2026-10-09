import { i as clipDeep, n as asNumber, r as asString, s as debugLog, u as isRecord } from "./version-B2EdcJjP.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

//#region src/config.ts
function parseBoolean(value) {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return void 0;
	const normalized = value.trim().toLowerCase();
	if ([
		"1",
		"true",
		"yes",
		"on"
	].includes(normalized)) return true;
	if ([
		"0",
		"false",
		"no",
		"off"
	].includes(normalized)) return false;
}
function parseTags(value) {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value !== "string" || value.trim().length === 0) return void 0;
	const trimmed = value.trim();
	if (trimmed.startsWith("[")) try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
	} catch {}
	return trimmed.split(",").map((t) => t.trim()).filter(Boolean);
}
function parseMetadata(value) {
	let obj = value;
	if (typeof value === "string") {
		if (value.trim().length === 0) return void 0;
		try {
			obj = JSON.parse(value);
		} catch {
			return;
		}
	}
	if (!isRecord(obj)) return void 0;
	const out = {};
	for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
	return out;
}
function stripUndefined(value) {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0));
}
function readConfigFile(file) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return;
	}
	if (!isRecord(raw)) return void 0;
	const pick = (...keys) => {
		for (const key of keys) if (raw[key] !== void 0) return raw[key];
	};
	return stripUndefined({
		enabled: parseBoolean(pick("enabled")),
		public_key: asString(pick("public_key", "publicKey")),
		secret_key: asString(pick("secret_key", "secretKey")),
		base_url: asString(pick("base_url", "baseUrl", "host")),
		environment: asString(pick("environment")),
		release: asString(pick("release")),
		user_id: asString(pick("user_id", "userId")),
		tags: parseTags(pick("tags")),
		skill_tags: parseBoolean(pick("skill_tags", "skillTags")),
		metadata: parseMetadata(pick("metadata")),
		trace_seed: asString(pick("trace_seed", "traceSeed")),
		traceparent: asString(pick("traceparent")),
		max_chars: asNumber(pick("max_chars", "maxChars")),
		capture_tool_output: parseBoolean(pick("capture_tool_output", "captureToolOutput")),
		capture_file_content: parseBoolean(pick("capture_file_content", "captureFileContent")),
		state_dir: asString(pick("state_dir", "stateDir")),
		debug: parseBoolean(pick("debug")),
		fail_on_error: parseBoolean(pick("fail_on_error", "failOnError"))
	});
}
function getVar(suffix, env) {
	return asString(env[`LANGFUSE_CURSOR_${suffix}`]) ?? asString(env[`LANGFUSE_${suffix}`]);
}
function readEnvConfig(env) {
	return stripUndefined({
		enabled: parseBoolean(env.LANGFUSE_CURSOR_ENABLED ?? env.LANGFUSE_TRACING_ENABLED),
		public_key: getVar("PUBLIC_KEY", env),
		secret_key: getVar("SECRET_KEY", env),
		base_url: getVar("BASE_URL", env) ?? asString(env.LANGFUSE_HOST),
		environment: asString(env.LANGFUSE_CURSOR_ENVIRONMENT) ?? asString(env.LANGFUSE_TRACING_ENVIRONMENT),
		release: asString(env.LANGFUSE_CURSOR_RELEASE) ?? asString(env.LANGFUSE_RELEASE),
		user_id: getVar("USER_ID", env),
		tags: parseTags(env.LANGFUSE_CURSOR_TAGS ?? env.LANGFUSE_TAGS),
		skill_tags: parseBoolean(env.LANGFUSE_CURSOR_SKILL_TAGS),
		metadata: parseMetadata(env.LANGFUSE_CURSOR_METADATA),
		trace_seed: asString(env.LANGFUSE_CURSOR_TRACE_SEED),
		traceparent: asString(env.LANGFUSE_CURSOR_TRACEPARENT),
		max_chars: asNumber(env.LANGFUSE_CURSOR_MAX_CHARS),
		capture_tool_output: parseBoolean(env.LANGFUSE_CURSOR_CAPTURE_TOOL_OUTPUT),
		capture_file_content: parseBoolean(env.LANGFUSE_CURSOR_CAPTURE_FILE_CONTENT),
		state_dir: asString(env.LANGFUSE_CURSOR_STATE_DIR),
		debug: parseBoolean(env.LANGFUSE_CURSOR_DEBUG),
		fail_on_error: parseBoolean(env.LANGFUSE_CURSOR_FAIL_ON_ERROR)
	});
}
function expandHome(value, home) {
	if (value === "~") return home;
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
	return value;
}
function getConfig(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? os.homedir();
	const workspaceRoot = options.workspaceRoot ?? env.CURSOR_PROJECT_DIR ?? process.cwd();
	const globalConfig = readConfigFile(path.join(home, ".cursor", "langfuse.json")) ?? {};
	const projectConfig = readConfigFile(path.join(workspaceRoot, ".cursor", "langfuse.json")) ?? {};
	const envConfig = readEnvConfig(env);
	const merged = {
		...globalConfig,
		...projectConfig,
		...envConfig
	};
	const usesProjectKeys = projectConfig.public_key && projectConfig.secret_key && !envConfig.public_key && !envConfig.secret_key;
	const baseUrl = envConfig.base_url ?? (usesProjectKeys ? projectConfig.base_url : globalConfig.base_url);
	const hasKeys = Boolean(merged.public_key && merged.secret_key);
	const stateDir = expandHome(merged.state_dir ?? path.join("~", ".cursor", "langfuse"), home);
	return {
		enabled: (merged.enabled ?? true) && hasKeys && Boolean(baseUrl),
		public_key: merged.public_key,
		secret_key: merged.secret_key,
		base_url: baseUrl?.replace(/\/+$/, "") ?? "",
		environment: merged.environment,
		release: merged.release,
		user_id: merged.user_id,
		tags: merged.tags ?? [],
		skill_tags: merged.skill_tags ?? true,
		metadata: merged.metadata ?? {},
		trace_seed: merged.trace_seed,
		traceparent: merged.traceparent,
		max_chars: merged.max_chars && merged.max_chars > 0 ? Math.floor(merged.max_chars) : 2e4,
		capture_tool_output: merged.capture_tool_output ?? true,
		capture_file_content: merged.capture_file_content ?? false,
		state_dir: stateDir,
		debug: merged.debug ?? false,
		fail_on_error: merged.fail_on_error ?? false
	};
}
function disabledReason(config, env) {
	if (parseBoolean(env.LANGFUSE_CURSOR_ENABLED ?? env.LANGFUSE_TRACING_ENABLED) === false) return "kill switch LANGFUSE_TRACING_ENABLED=false";
	if (!config.public_key || !config.secret_key || !config.base_url) return `Langfuse config incomplete: missing ${[
		!config.public_key ? "LANGFUSE_PUBLIC_KEY" : null,
		!config.secret_key ? "LANGFUSE_SECRET_KEY" : null,
		!config.base_url ? "LANGFUSE_BASE_URL" : null
	].filter(Boolean).join(", ")}`;
	return "enabled=false in a langfuse.json config file";
}

//#endregion
//#region src/state.ts
const MAX_EXPORTED_IDS = 200;
var ConversationStore = class {
	stateDir;
	conversationId;
	dir;
	eventsFile;
	stateFile;
	constructor(stateDir, conversationId) {
		this.stateDir = stateDir;
		this.conversationId = conversationId;
		const safeId = conversationId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
		this.dir = path.join(stateDir, "conversations", safeId);
		this.eventsFile = path.join(this.dir, "events.jsonl");
		this.stateFile = path.join(this.dir, "state.json");
	}
	ensureDir() {
		fs.mkdirSync(this.dir, { recursive: true });
	}
	readState() {
		try {
			const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
			return {
				conversationId: this.conversationId,
				turnsCompleted: typeof raw.turnsCompleted === "number" ? raw.turnsCompleted : 0,
				openTurn: raw.openTurn,
				session: raw.session,
				exportedTraceIds: Array.isArray(raw.exportedTraceIds) ? raw.exportedTraceIds : [],
				updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
			};
		} catch {
			return {
				conversationId: this.conversationId,
				turnsCompleted: 0,
				exportedTraceIds: [],
				updatedAt: 0
			};
		}
	}
	writeState(state) {
		this.ensureDir();
		state.updatedAt = Date.now();
		if (state.exportedTraceIds.length > MAX_EXPORTED_IDS) state.exportedTraceIds = state.exportedTraceIds.slice(-200);
		const tmp = `${this.stateFile}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
		fs.renameSync(tmp, this.stateFile);
	}
	/**
	* Append one hook event. Strings are clipped so a single line stays small
	* enough that concurrent appends (parallel tool calls) do not interleave.
	*/
	appendEvent(payload, maxChars, ts = Date.now()) {
		this.ensureDir();
		const event = {
			ts,
			event: payload.hook_event_name,
			payload: clipDeep(payload, maxChars)
		};
		fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
	}
	readEvents() {
		let data;
		try {
			data = fs.readFileSync(this.eventsFile, "utf-8");
		} catch {
			return [];
		}
		const events = [];
		for (const line of data.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed && typeof parsed.ts === "number" && typeof parsed.event === "string") events.push(parsed);
			} catch {
				debugLog("skipping malformed event line");
			}
		}
		return events.sort((a, b) => a.ts - b.ts);
	}
	clearEvents(keepFrom) {
		if (keepFrom === void 0) {
			fs.rmSync(this.eventsFile, { force: true });
			return;
		}
		const remaining = this.readEvents().filter((e) => e.ts >= keepFrom);
		fs.rmSync(this.eventsFile, { force: true });
		for (const event of remaining) fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
	}
	/**
	* Best-effort exclusive lock for the export path. Times out instead of
	* failing so a stale lock never drops a turn; the caller logs the timeout.
	*/
	async withLock(fn, timeoutMs = 5e3) {
		this.ensureDir();
		const lockDir = path.join(this.dir, ".lock");
		const deadline = Date.now() + timeoutMs;
		let acquired = false;
		while (Date.now() < deadline) try {
			fs.mkdirSync(lockDir);
			acquired = true;
			break;
		} catch {
			try {
				if (Date.now() - fs.statSync(lockDir).mtimeMs > 6e4) {
					fs.rmSync(lockDir, {
						recursive: true,
						force: true
					});
					continue;
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!acquired) debugLog("export lock timeout; proceeding without lock");
		try {
			return await fn();
		} finally {
			if (acquired) fs.rmSync(lockDir, {
				recursive: true,
				force: true
			});
		}
	}
};

//#endregion
export { disabledReason as n, getConfig as r, ConversationStore as t };