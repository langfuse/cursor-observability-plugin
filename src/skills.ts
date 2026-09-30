import type { Config } from "./config.js";
import type { ToolCall, Turn } from "./types.js";
import { toText } from "./utils.js";

const READ_TOOLS = new Set(["read"]);
const SHELL_TOOLS = new Set(["shell", "bash"]);
const PATH_FIELDS = ["path", "file_path", "filePath", "target_file", "uri"];
const COMMAND_FIELDS = ["command", "cmd"];
const MAX_SKILL_NAME_LENGTH = 64;

// The skill name is the directory that contains SKILL.md. Category folders may
// sit between the skills root and that directory. `skills-cursor` is listed
// first so it is not consumed by the `skills` prefix.
const SKILL_ROOT = "(?:skills-cursor|skills)";
const SKILL_DOC = new RegExp(
  `(?:^|[\\\\/])${SKILL_ROOT}(?:[\\\\/][A-Za-z0-9._@+-]+)*[\\\\/]([A-Za-z0-9._@+-]+)[\\\\/]SKILL\\.md\\b`,
  "gi",
);
const SKILL_SCRIPT = new RegExp(
  `(?:^|[\\\\/])${SKILL_ROOT}(?:[\\\\/][A-Za-z0-9._@+-]+)*[\\\\/]([A-Za-z0-9._@+-]+)[\\\\/]scripts[\\\\/]`,
  "gi",
);

function collect(text: string): string[] {
  const names: string[] = [];
  for (const pattern of [SKILL_DOC, SKILL_SCRIPT]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1]?.trim() ?? "";
      if (
        name.length > 0 &&
        name.length <= MAX_SKILL_NAME_LENGTH &&
        !name.startsWith(".") &&
        !names.includes(name)
      ) {
        names.push(name);
      }
    }
  }
  return names;
}

function fieldText(input: unknown, fields: string[]): string | undefined {
  if (typeof input === "string") return input;
  if (input == null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) parts.push(value.map((part) => toText(part)).join(" "));
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Skills this call loaded by reading SKILL.md or running a file under scripts/. */
export function skillsForToolCall(call: Pick<ToolCall, "name" | "input">): string[] {
  const name = call.name.toLowerCase();
  const fields = READ_TOOLS.has(name) ? PATH_FIELDS : SHELL_TOOLS.has(name) ? COMMAND_FIELDS : [];
  if (fields.length === 0) return [];
  const text = fieldText(call.input, fields);
  return text ? collect(text) : [];
}

/** `cursor`, configured tags, then one `skill:<name>` per skill this turn loaded. */
export function traceTags(config: Pick<Config, "tags" | "skill_tags">, turn: Turn): string[] {
  const tags = ["cursor", ...config.tags.filter((tag) => tag !== "cursor")];
  if (!config.skill_tags) return tags;
  for (const generation of turn.generations) {
    for (const call of generation.toolCalls) {
      for (const name of skillsForToolCall(call)) {
        const tag = `skill:${name}`;
        if (!tags.includes(tag)) tags.push(tag);
      }
    }
  }
  return tags;
}
