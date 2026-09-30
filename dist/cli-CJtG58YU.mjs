import { r as asString, t as PLUGIN_VERSION } from "./version-ZGirXdLt.mjs";
import { r as getConfig, t as ConversationStore } from "./state-UwhyEkyv.mjs";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

//#region src/cli.ts
/**
* Setup and status commands.
*
* Cursor has no `cursor plugin install`, so a first-time setup is: put the
* plugin where Cursor finds it, and write the keys. `setup` does both and then
* proves the keys work against the Langfuse API, so nobody has to hand-write a
* hooks file.
*
* Loaded on demand from index.ts, so the per-event hook path never pays for it.
*/
/** Every agent hook the plugin subscribes to. Kept in sync with hooks/hooks.json
* and templates/project-hooks.json by test/cli.test.ts. */
const HOOK_EVENTS = [
	"sessionStart",
	"sessionEnd",
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
	"stop"
];
/** Hooks that assemble and upload a turn get a longer timeout than the gates. */
const SLOW_HOOKS = /* @__PURE__ */ new Set([
	"stop",
	"sessionEnd",
	"beforeSubmitPrompt"
]);
const mask = (key) => key ? `${key.slice(0, 11)}…${key.slice(-4)}` : "—";
function parseArgs(argv) {
	const out = /* @__PURE__ */ new Map();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const [flag, inline] = arg.slice(2).split("=", 2);
		if (inline !== void 0) out.set(flag, inline);
		else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.set(flag, argv[++i]);
		else out.set(flag, true);
	}
	return out;
}
function pluginRoot() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
async function verifyKeys(config) {
	const auth = Buffer.from(`${config.public_key}:${config.secret_key}`).toString("base64");
	try {
		const response = await fetch(`${config.base_url}/api/public/projects`, {
			headers: { Authorization: `Basic ${auth}` },
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) return {
			ok: false,
			detail: response.status === 401 ? "401 Unauthorized: the keys are wrong, or they belong to a different data region than base_url" : `HTTP ${response.status} from ${config.base_url}`
		};
		const project = (await response.json()).data?.[0];
		if (!project?.id) return {
			ok: true,
			detail: "keys accepted"
		};
		return {
			ok: true,
			detail: `project "${project.name}" (${config.base_url}/project/${project.id})`
		};
	} catch (error) {
		return {
			ok: false,
			detail: `cannot reach ${config.base_url}: ${String(error)}`
		};
	}
}
function writeJson(file, value, mode) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : void 0);
}
/**
* Is this hook entry one we wrote before?
*
* Name matching alone is not enough: a checkout can be renamed, and then a
* re-run would append a second entry per event. So an entry counts as ours
* when it equals the command we are writing, equals a command we recorded
* earlier, points at this bundle, or names the plugin.
*/
function isManagedCommand(entryCommand, command, previous) {
	if (entryCommand === command) return true;
	if (previous.includes(entryCommand)) return true;
	if (entryCommand.includes(path.join(pluginRoot(), "dist", "index.mjs"))) return true;
	return /langfuse|cursor-observability-plugin/i.test(entryCommand);
}
function registerHooks(file, command, previous = []) {
	let doc = { hooks: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		doc = {
			...parsed,
			hooks: parsed.hooks ?? {}
		};
	} catch {}
	doc.version ??= 1;
	let added = 0;
	let replaced = 0;
	for (const event of HOOK_EVENTS) {
		const entries = doc.hooks[event] ??= [];
		const mine = entries.findIndex((entry) => typeof entry.command === "string" && isManagedCommand(entry.command, command, previous));
		const entry = {
			command,
			timeout: SLOW_HOOKS.has(event) ? 60 : 10
		};
		if (mine >= 0) {
			entries[mine] = entry;
			replaced++;
		} else {
			entries.push(entry);
			added++;
		}
	}
	writeJson(file, doc);
	return {
		added,
		replaced
	};
}
function readManagedCommands(stateDir) {
	try {
		const doc = JSON.parse(fs.readFileSync(path.join(stateDir, "managed-hooks.json"), "utf-8"));
		return Array.isArray(doc.commands) ? doc.commands.filter((c) => typeof c === "string") : [];
	} catch {
		return [];
	}
}
function recordManagedCommand(stateDir, command) {
	const commands = readManagedCommands(stateDir).filter((c) => c !== command);
	commands.push(command);
	writeJson(path.join(stateDir, "managed-hooks.json"), { commands: commands.slice(-10) });
}
const PATH_COMMAND = "langfuse-cursor-hook";
/**
* The command to write into a hooks file.
*
* A user-level `~/.cursor/hooks.json` pins the absolute interpreter and bundle
* path: it never leaves this machine, and a Cursor started from Finder has no
* shell `PATH`, so a bare command can fail to launch.
*
* A project-level `<repo>/.cursor/hooks.json` is the opposite case. It gets
* committed and then runs on teammates' machines and in Cloud Agent VMs, where
* this machine's node path does not exist, so it has to go through `PATH` and
* rely on the globally installed package.
*/
function hookCommand(scope) {
	if (scope === "project") return PATH_COMMAND;
	return `"${process.execPath}" "${path.join(pluginRoot(), "dist", "index.mjs")}"`;
}
async function runSetup(argv) {
	const args = parseArgs(argv);
	const home = process.env.HOME ?? os.homedir();
	const projectPath = typeof args.get("project") === "string" ? String(args.get("project")) : void 0;
	const scopeDir = projectPath ? path.resolve(projectPath) : home;
	const configFile = path.join(scopeDir, ".cursor", "langfuse.json");
	const publicKey = (asString(args.get("public-key")) ?? process.env.LANGFUSE_PUBLIC_KEY) || void 0;
	const secretKey = (asString(args.get("secret-key")) ?? process.env.LANGFUSE_SECRET_KEY) || void 0;
	const baseUrl = (asString(args.get("base-url")) ?? process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
	const environment = asString(args.get("environment")) ?? process.env.LANGFUSE_TRACING_ENVIRONMENT;
	if (!publicKey || !secretKey) {
		process.stdout.write([
			"Langfuse setup for Cursor",
			"",
			"Pass your project keys, or export LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY first:",
			"",
			"  langfuse-cursor-hook setup --public-key pk-lf-… --secret-key sk-lf-…",
			"",
			"Options:",
			"  --base-url <url>        Langfuse host (default https://cloud.langfuse.com, the EU region)",
			"  --environment <name>    Langfuse environment label for the traces",
			"  --project <path>        Write the keys into <path>/.cursor/langfuse.json instead of ~/.cursor",
			"  --hooks                 Also register the hooks in hooks.json (use this when the plugin",
			"                          itself is not installed, e.g. a plain checkout)",
			"",
			"Find the keys in your Langfuse project under Settings → API Keys.",
			""
		].join("\n"));
		return 1;
	}
	const verified = await verifyKeys({
		public_key: publicKey,
		secret_key: secretKey,
		base_url: baseUrl
	});
	if (!verified.ok) {
		process.stdout.write(`✗ ${verified.detail}\n\nNothing was written.\n`);
		return 1;
	}
	writeJson(configFile, {
		publicKey,
		secretKey,
		baseUrl,
		...environment ? { environment } : {}
	}, 384);
	const lines = [`✓ keys verified: ${verified.detail}`, `✓ wrote ${configFile} (mode 600)`];
	if (args.get("hooks")) {
		const hooksFile = path.join(scopeDir, ".cursor", "hooks.json");
		const stateDir = getConfig({
			home,
			workspaceRoot: scopeDir
		}).state_dir;
		const command = hookCommand(projectPath ? "project" : "user");
		const { added, replaced } = registerHooks(hooksFile, command, readManagedCommands(stateDir));
		recordManagedCommand(stateDir, command);
		lines.push(projectPath ? `✓ hooks will run: ${PATH_COMMAND} (from PATH, so the file can be committed)` : `✓ hooks will run: ${process.execPath}`);
		lines.push(`✓ registered ${HOOK_EVENTS.length} hooks in ${hooksFile} (${added} added, ${replaced} updated)`);
	} else lines.push("", "The plugin's own hooks/hooks.json covers the hook registration. If you are", "running from a plain checkout rather than an installed plugin, re-run with --hooks.");
	if (projectPath && args.get("hooks")) lines.push("", `Commit .cursor/hooks.json, not .cursor/langfuse.json. Every machine that`, `runs it needs the package on PATH:`, "  npm install -g @langfuse/cursor-observability-plugin", "For Cloud Agents, put that in the install step of .cursor/environment.json", "and add the Langfuse keys as secrets in the dashboard.");
	lines.push("", "Restart Cursor, send the agent a prompt, then check:", "  langfuse-cursor-hook status", "");
	process.stdout.write(lines.join("\n"));
	return 0;
}
async function runStatus(argv) {
	const args = parseArgs(argv);
	const projectPath = typeof args.get("project") === "string" ? String(args.get("project")) : void 0;
	const config = getConfig({ workspaceRoot: projectPath ? path.resolve(projectPath) : void 0 });
	const home = process.env.HOME ?? os.homedir();
	const out = [
		`Langfuse Cursor plugin ${PLUGIN_VERSION}`,
		`  bundle        ${path.join(pluginRoot(), "dist", "index.mjs")}`,
		`  node          ${process.version} (${process.execPath})`,
		`  tracing       ${config.enabled ? "on" : "off"}`,
		`  host          ${config.base_url}`,
		`  public key    ${mask(config.public_key)}`,
		`  secret key    ${config.secret_key ? "set" : "—"}`,
		`  user          ${config.user_id ?? "(Cursor account email)"}`,
		`  environment   ${config.environment ?? "—"}`,
		`  tags          ${["cursor", ...config.tags].join(", ")}`,
		`  skill tags    ${config.skill_tags ? "on" : "off"}`,
		`  state dir     ${config.state_dir}`
	];
	const sources = [path.join(home, ".cursor", "langfuse.json"), ...projectPath ? [path.join(path.resolve(projectPath), ".cursor", "langfuse.json")] : []].filter((file) => fs.existsSync(file));
	out.push(`  config files  ${sources.length > 0 ? sources.join(", ") : "none (environment only)"}`);
	const hookFiles = [path.join(home, ".cursor", "hooks.json"), ...projectPath ? [path.join(path.resolve(projectPath), ".cursor", "hooks.json")] : []];
	for (const file of hookFiles) try {
		const doc = JSON.parse(fs.readFileSync(file, "utf-8"));
		const mine = Object.entries(doc.hooks ?? {}).filter(([, entries]) => entries.some((e) => typeof e.command === "string" && /langfuse/i.test(e.command)));
		out.push(`  hooks         ${file}: ${mine.length} Langfuse hooks registered`);
	} catch {}
	if (config.enabled) {
		const verified = await verifyKeys(config);
		out.push(`  connection    ${verified.ok ? "✓" : "✗"} ${verified.detail}`);
	}
	const logFile = path.join(config.state_dir, "hook.log");
	const exported = [];
	try {
		const log = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		exported.push(...log.filter((line) => line.includes("Exported turn")).slice(-3));
		out.push(`  log           ${logFile} (${log.length} lines)`);
	} catch {
		out.push(`  log           ${logFile} (not written yet)`);
	}
	const conversationsDir = path.join(config.state_dir, "conversations");
	try {
		const ids = fs.readdirSync(conversationsDir);
		const traces = ids.flatMap((id) => {
			return new ConversationStore(config.state_dir, id).readState().exportedTraceIds.slice(-1).map((trace) => ({
				id,
				trace
			}));
		});
		out.push(`  conversations ${ids.length} tracked, ${traces.length} with exported traces`);
		for (const { trace } of traces.slice(-3)) out.push(`                ${config.base_url}/project/~/traces/${trace}`);
	} catch {
		out.push("  conversations none yet");
	}
	if (exported.length > 0) out.push("", "Last exports:", ...exported.map((line) => `  ${line}`));
	process.stdout.write(`${out.join("\n")}\n`);
	return 0;
}

//#endregion
export { runSetup, runStatus };