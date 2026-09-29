import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "../src/config.js";
import type { HookBase, LoggedEvent } from "../src/types.js";

export const CONVERSATION = "11111111-2222-4333-8444-555555555555";
export const WORKSPACE = "/work/demo";

export const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  tags: [],
  skill_tags: true,
  metadata: {},
  max_chars: 20_000,
  capture_tool_output: true,
  capture_file_content: false,
  state_dir: path.join(os.tmpdir(), "lf-cursor-test-state"),
  debug: false,
  fail_on_error: false,
};

export const common: HookBase = {
  hook_event_name: "",
  conversation_id: CONVERSATION,
  generation_id: "gen-1",
  model: "claude-opus-4-7-thinking-max",
  model_id: "claude-opus-4-7",
  model_params: [{ id: "thinking", value: "true" }],
  cursor_version: "3.12.30",
  workspace_roots: [WORKSPACE],
  user_email: "dev@example.com",
  transcript_path: null,
};

export function ev(name: string, payload: Record<string, unknown>, ts: number): LoggedEvent {
  return {
    ts: BASE_TS + ts,
    event: name,
    payload: { ...common, ...payload, hook_event_name: name },
  };
}

export const BASE_TS = 1_800_000_000_000;

export function sampleEvents(): LoggedEvent[] {
  return [
    ev("beforeSubmitPrompt", { prompt: "Add a README", attachments: [] }, 0),
    ev("afterAgentThought", { text: "Look at the repo first.", duration_ms: 900 }, 100),
    ev(
      "preToolUse",
      {
        tool_name: "Shell",
        tool_input: { command: "git status" },
        tool_use_id: "t1",
        cwd: WORKSPACE,
      },
      200,
    ),
    ev("beforeShellExecution", { command: "git status", cwd: WORKSPACE, sandbox: false }, 210),
    ev(
      "afterShellExecution",
      { command: "git status", output: "clean\n", duration: 80, sandbox: false },
      300,
    ),
    ev(
      "postToolUse",
      {
        tool_name: "Shell",
        tool_input: { command: "git status" },
        tool_output: JSON.stringify({ exitCode: 0, stdout: "clean\n" }),
        tool_use_id: "t1",
        duration: 80,
      },
      310,
    ),
    ev(
      "preToolUse",
      {
        tool_name: "Write",
        tool_input: { path: `${WORKSPACE}/README.md`, contents: "# Demo\n" },
        tool_use_id: "t2",
      },
      400,
    ),
    ev(
      "afterFileEdit",
      { file_path: `${WORKSPACE}/README.md`, edits: [{ old_string: "", new_string: "# Demo\n" }] },
      450,
    ),
    ev(
      "postToolUse",
      {
        tool_name: "Write",
        tool_input: { path: `${WORKSPACE}/README.md` },
        tool_output: JSON.stringify({ success: true }),
        tool_use_id: "t2",
        duration: 40,
      },
      460,
    ),
    ev("afterAgentResponse", { text: "Added README.md." }, 600),
    ev(
      "stop",
      {
        status: "completed",
        loop_count: 0,
        input_tokens: 10_000,
        output_tokens: 500,
        cache_read_tokens: 8_000,
        cache_write_tokens: 1_000,
      },
      700,
    ),
  ];
}

export function transcriptRows(
  prompt: string,
  rows: Array<{ text: string; tools?: Array<{ name: string; input: unknown }> }>,
) {
  const lines = [
    JSON.stringify({
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: `<timestamp>Monday, Aug 24, 2026, 3:01 PM (UTC-5)</timestamp>\n<user_query>\n${prompt}\n</user_query>`,
          },
        ],
      },
    }),
    ...rows.map((r) =>
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: r.text },
            ...(r.tools ?? []).map((t) => ({ type: "tool_use", name: t.name, input: t.input })),
          ],
        },
      }),
    ),
    JSON.stringify({ type: "turn_ended", status: "success" }),
  ];
  return `${lines.join("\n")}\n`;
}

const tmpDirs: string[] = [];
export function makeTmpDir(prefix = "lf-cursor-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
export function cleanTmpDirs(): void {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
}
