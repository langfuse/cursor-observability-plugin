import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function readStdin<T>(): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.on("end", () => {
      const trimmed = buffer.trim();
      if (!trimmed) {
        reject(new Error("empty hook stdin"));
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as T);
      } catch (error) {
        reject(
          new Error(
            `failed to parse hook stdin: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
    process.stdin.once("error", reject);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) {
    // Error properties are not enumerable, so JSON.stringify would yield "{}".
    const cause = (value as { cause?: unknown }).cause;
    return `${value.name}: ${value.message}${cause ? ` (cause: ${toText(cause)})` : ""}${
      debugEnabled && value.stack ? `\n${value.stack}` : ""
    }`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

export function clipDeep<T>(value: T, maxChars: number): T {
  if (typeof value === "string") return clipText(value, maxChars) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => clipDeep(v, maxChars)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v, maxChars);
    return out as T;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic 32-hex trace id, identical to the Langfuse SDKs'
 * `createTraceId(seed)` helper so external systems can precompute it.
 */
export function traceIdFromSeed(seed: string): string {
  return sha256Hex(seed).slice(0, 32);
}

export function spanIdFromSeed(seed: string): string {
  return sha256Hex(seed).slice(0, 16);
}

/** Cursor stores per-project data under a sanitized copy of the workspace path. */
export function sanitizeProjectPath(workspaceRoot: string): string {
  return workspaceRoot.replace(/^[/\\]+/, "").replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Where Cursor keeps the transcript for a conversation when the hook payload
 * carries no `transcript_path` (CLI mode). IDE builds nest the file in a
 * directory named after the conversation; the CLI writes it flat.
 */
export function guessTranscriptPath(
  home: string,
  workspaceRoot: string | undefined,
  conversationId: string,
): string | undefined {
  if (!workspaceRoot) return undefined;
  const dir = path.join(
    home,
    ".cursor",
    "projects",
    sanitizeProjectPath(workspaceRoot),
    "agent-transcripts",
  );
  const nested = path.join(dir, conversationId, `${conversationId}.jsonl`);
  const flat = path.join(dir, `${conversationId}.jsonl`);
  if (fs.existsSync(nested)) return nested;
  if (fs.existsSync(flat)) return flat;
  return undefined;
}

export function parseTraceparent(
  value: string | undefined,
): { traceId: string; spanId: string } | undefined {
  if (!value) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(value.trim());
  if (!match) return undefined;
  return { traceId: match[1]!.toLowerCase(), spanId: match[2]!.toLowerCase() };
}

/** Convert Cursor's `[{id, value}]` model params to a flat record. */
export function modelParamsToRecord(params: unknown): Record<string, string> | undefined {
  if (!Array.isArray(params)) return undefined;
  const out: Record<string, string> = {};
  for (const item of params) {
    if (isRecord(item) && typeof item.id === "string") out[item.id] = toText(item.value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

let debugEnabled = false;
let logFile: string | undefined;

export function configureLogging(options: { debug: boolean; logFile?: string }): void {
  debugEnabled = options.debug;
  logFile = options.logFile;
}

function writeLog(level: "INFO" | "DEBUG", args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args.map(toText).join(" ")}\n`;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line, "utf-8");
      return;
    } catch {
      // fall through to stderr
    }
  }
  process.stderr.write(`[langfuse-cursor] ${line}`);
}

/** Always recorded: configuration problems and delivery failures must never be silent. */
export function infoLog(...args: unknown[]): void {
  writeLog("INFO", args);
}

/** Recorded only with `debug: true`. */
export function debugLog(...args: unknown[]): void {
  if (!debugEnabled) return;
  writeLog("DEBUG", args);
}
