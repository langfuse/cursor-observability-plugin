import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

//#region src/utils.ts
function readStdin() {
	return new Promise((resolve, reject) => {
		let buffer = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => buffer += chunk);
		process.stdin.on("end", () => {
			const trimmed = buffer.trim();
			if (!trimmed) {
				reject(/* @__PURE__ */ new Error("empty hook stdin"));
				return;
			}
			try {
				resolve(JSON.parse(trimmed));
			} catch (error) {
				reject(/* @__PURE__ */ new Error(`failed to parse hook stdin: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
		process.stdin.once("error", reject);
	});
}
function isRecord(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function asNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function toText(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Error) {
		const cause = value.cause;
		return `${value.name}: ${value.message}${cause ? ` (cause: ${toText(cause)})` : ""}${debugEnabled && value.stack ? `\n${value.stack}` : ""}`;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
function tryParseJson(value) {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}
function clipText(value, maxChars) {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}
function clipDeep(value, maxChars) {
	if (typeof value === "string") return clipText(value, maxChars);
	if (Array.isArray(value)) return value.map((v) => clipDeep(v, maxChars));
	if (isRecord(value)) {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v, maxChars);
		return out;
	}
	return value;
}
function sha256Hex(input) {
	return createHash("sha256").update(input).digest("hex");
}
/**
* Deterministic 32-hex trace id, identical to the Langfuse SDKs'
* `createTraceId(seed)` helper so external systems can precompute it.
*/
function traceIdFromSeed(seed) {
	return sha256Hex(seed).slice(0, 32);
}
function spanIdFromSeed(seed) {
	return sha256Hex(seed).slice(0, 16);
}
/** Cursor stores per-project data under a sanitized copy of the workspace path. */
function sanitizeProjectPath(workspaceRoot) {
	return workspaceRoot.replace(/^[/\\]+/, "").replace(/[^A-Za-z0-9]/g, "-");
}
/**
* Where Cursor keeps the transcript for a conversation when the hook payload
* carries no `transcript_path` (CLI mode). IDE builds nest the file in a
* directory named after the conversation; the CLI writes it flat.
*/
function guessTranscriptPath(home, workspaceRoot, conversationId) {
	if (!workspaceRoot) return void 0;
	const dir = path.join(home, ".cursor", "projects", sanitizeProjectPath(workspaceRoot), "agent-transcripts");
	const nested = path.join(dir, conversationId, `${conversationId}.jsonl`);
	const flat = path.join(dir, `${conversationId}.jsonl`);
	if (fs.existsSync(nested)) return nested;
	if (fs.existsSync(flat)) return flat;
}
function parseTraceparent(value) {
	if (!value) return void 0;
	const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(value.trim());
	if (!match) return void 0;
	return {
		traceId: match[1].toLowerCase(),
		spanId: match[2].toLowerCase()
	};
}
/** Convert Cursor's `[{id, value}]` model params to a flat record. */
function modelParamsToRecord(params) {
	if (!Array.isArray(params)) return void 0;
	const out = {};
	for (const item of params) if (isRecord(item) && typeof item.id === "string") out[item.id] = toText(item.value);
	return Object.keys(out).length > 0 ? out : void 0;
}
let debugEnabled = false;
let logFile;
function configureLogging(options) {
	debugEnabled = options.debug;
	logFile = options.logFile;
}
function writeLog(level, args) {
	const line = `${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${args.map(toText).join(" ")}\n`;
	if (logFile) try {
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		fs.appendFileSync(logFile, line, "utf-8");
		return;
	} catch {}
	process.stderr.write(`[langfuse-cursor] ${line}`);
}
/** Always recorded: configuration problems and delivery failures must never be silent. */
function infoLog(...args) {
	writeLog("INFO", args);
}
/** Recorded only with `debug: true`. */
function debugLog(...args) {
	if (!debugEnabled) return;
	writeLog("DEBUG", args);
}

//#endregion
//#region src/version.ts
/** Plugin version, recorded on every trace as `langfuse.plugin.version`. Keep in sync with package.json. */
const PLUGIN_VERSION = "0.1.0";

//#endregion
export { tryParseJson as _, clipText as a, guessTranscriptPath as c, modelParamsToRecord as d, parseTraceparent as f, traceIdFromSeed as g, toText as h, clipDeep as i, infoLog as l, spanIdFromSeed as m, asNumber as n, configureLogging as o, readStdin as p, asString as r, debugLog as s, PLUGIN_VERSION as t, isRecord as u };