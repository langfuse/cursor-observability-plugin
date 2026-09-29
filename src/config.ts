import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { asNumber, asString, isRecord } from "./utils.js";

/**
 * Resolved plugin configuration.
 *
 * Resolution order (lowest → highest precedence):
 *   defaults → ~/.cursor/langfuse.json → <workspace>/.cursor/langfuse.json → environment
 *
 * For each environment variable the `LANGFUSE_CURSOR_*` form wins over the
 * matching `LANGFUSE_*` form, so credentials can be scoped to Cursor without
 * disturbing other Langfuse tooling on the same machine.
 *
 * Tracing is on when both keys are present. `LANGFUSE_TRACING_ENABLED=false`
 * (or `"enabled": false` in a config file) is the kill switch.
 */
export type Config = {
  enabled: boolean;
  public_key?: string;
  secret_key?: string;
  base_url: string;
  environment?: string;
  release?: string;
  user_id?: string;
  tags: string[];
  /** Tag traces `skill:<name>` when a turn loads a skill. Default true. */
  skill_tags: boolean;
  metadata: Record<string, string>;
  trace_seed?: string;
  traceparent?: string;
  max_chars: number;
  capture_tool_output: boolean;
  /** Store the file contents Cursor passes to `beforeReadFile` (default false). */
  capture_file_content: boolean;
  state_dir: string;
  debug: boolean;
  fail_on_error: boolean;
};

type PartialConfig = Partial<Config>;

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function parseTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through to comma-separated parsing
    }
  }
  return trimmed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function parseMetadata(value: unknown): Record<string, string> | undefined {
  let obj: unknown = value;
  if (typeof value === "string") {
    if (value.trim().length === 0) return undefined;
    try {
      obj = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(obj)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function readConfigFile(file: string): PartialConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  // Accept both snake_case (Codex plugin style) and camelCase (Pi plugin style) keys.
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) if (raw[key] !== undefined) return raw[key];
    return undefined;
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
    fail_on_error: parseBoolean(pick("fail_on_error", "failOnError")),
  });
}

function getVar(suffix: string, env: Record<string, string | undefined>): string | undefined {
  return asString(env[`LANGFUSE_CURSOR_${suffix}`]) ?? asString(env[`LANGFUSE_${suffix}`]);
}

function readEnvConfig(env: Record<string, string | undefined>): PartialConfig {
  return stripUndefined({
    enabled: parseBoolean(env.LANGFUSE_CURSOR_ENABLED ?? env.LANGFUSE_TRACING_ENABLED),
    public_key: getVar("PUBLIC_KEY", env),
    secret_key: getVar("SECRET_KEY", env),
    base_url: getVar("BASE_URL", env) ?? asString(env.LANGFUSE_HOST),
    environment:
      asString(env.LANGFUSE_CURSOR_ENVIRONMENT) ?? asString(env.LANGFUSE_TRACING_ENVIRONMENT),
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
    fail_on_error: parseBoolean(env.LANGFUSE_CURSOR_FAIL_ON_ERROR),
  });
}

export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

export type ConfigOptions = {
  home?: string;
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
};

export function getConfig(options: ConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const workspaceRoot = options.workspaceRoot ?? env.CURSOR_PROJECT_DIR ?? process.cwd();

  const globalConfig = readConfigFile(path.join(home, ".cursor", "langfuse.json")) ?? {};
  const projectConfig = readConfigFile(path.join(workspaceRoot, ".cursor", "langfuse.json")) ?? {};
  const envConfig = readEnvConfig(env);

  const merged: PartialConfig = { ...globalConfig, ...projectConfig, ...envConfig };
  const hasKeys = Boolean(merged.public_key && merged.secret_key);
  const stateDir = expandHome(merged.state_dir ?? path.join("~", ".cursor", "langfuse"), home);

  return {
    enabled: (merged.enabled ?? true) && hasKeys,
    public_key: merged.public_key,
    secret_key: merged.secret_key,
    base_url: (merged.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    environment: merged.environment,
    release: merged.release,
    user_id: merged.user_id,
    tags: merged.tags ?? [],
    skill_tags: merged.skill_tags ?? true,
    metadata: merged.metadata ?? {},
    trace_seed: merged.trace_seed,
    traceparent: merged.traceparent,
    max_chars: merged.max_chars && merged.max_chars > 0 ? Math.floor(merged.max_chars) : 20_000,
    capture_tool_output: merged.capture_tool_output ?? true,
    capture_file_content: merged.capture_file_content ?? false,
    state_dir: stateDir,
    debug: merged.debug ?? false,
    fail_on_error: merged.fail_on_error ?? false,
  };
}

export function disabledReason(config: Config, env: Record<string, string | undefined>): string {
  const killSwitch = parseBoolean(env.LANGFUSE_CURSOR_ENABLED ?? env.LANGFUSE_TRACING_ENABLED);
  if (killSwitch === false) return "kill switch LANGFUSE_TRACING_ENABLED=false";
  if (!config.public_key || !config.secret_key) {
    const missing = [
      !config.public_key ? "LANGFUSE_PUBLIC_KEY" : null,
      !config.secret_key ? "LANGFUSE_SECRET_KEY" : null,
    ].filter(Boolean);
    return `Langfuse config incomplete: missing ${missing.join(", ")}`;
  }
  return "enabled=false in a langfuse.json config file";
}
