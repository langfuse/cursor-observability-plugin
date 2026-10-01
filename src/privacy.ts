import type { Config } from "./config.js";
import type { HookBase } from "./types.js";

/** Apply capture settings before persistence, and to older events at export. */
export function applyCapturePolicy(
  payload: HookBase,
  config: Pick<Config, "capture_file_content" | "capture_tool_output">,
): HookBase {
  const captured = { ...payload };
  if (!config.capture_file_content && payload.hook_event_name === "beforeReadFile") {
    if (typeof captured.content === "string") captured.content_length = captured.content.length;
    delete captured.content;
  }
  const isFileRead =
    typeof payload.tool_name === "string" && /^(Read|ReadFile)$/i.test(payload.tool_name);
  if (!config.capture_tool_output || (!config.capture_file_content && isFileRead)) {
    delete captured.tool_output;
  }
  if (!config.capture_tool_output) {
    if (payload.hook_event_name === "afterShellExecution") delete captured.output;
    if (payload.hook_event_name === "afterMCPExecution") delete captured.result_json;
  }
  return captured;
}

export function createSecretMask(config: Pick<Config, "public_key" | "secret_key">) {
  const literals = [config.secret_key, config.public_key].filter(
    (k): k is string => typeof k === "string" && k.length >= 8,
  );
  const pattern = /\b(?:sk|pk)-lf-[0-9a-f-]{8,}\b/gi;
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const literal of literals) out = out.split(literal).join("[redacted-langfuse-key]");
      return out.replace(pattern, "[redacted-langfuse-key]");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v);
      return out;
    }
    return value;
  };
  return ({ data }: { data: unknown }) => redact(data);
}
