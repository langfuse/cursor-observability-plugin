import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { applyCapturePolicy } from "../src/privacy.js";
import { cleanTmpDirs, makeTmpDir } from "./helpers.js";

const hookBin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
afterEach(cleanTmpDirs);

it.each(["Read", "ReadFile"])(
  "suppresses %s results while preserving other tool results",
  (tool_name) => {
    const config = { capture_file_content: false, capture_tool_output: true };
    expect(
      applyCapturePolicy(
        { hook_event_name: "postToolUse", tool_name, tool_output: "private" },
        config,
      ).tool_output,
    ).toBeUndefined();
    expect(
      applyCapturePolicy(
        { hook_event_name: "postToolUse", tool_name: "Shell", tool_output: "ok" },
        config,
      ).tool_output,
    ).toBe("ok");
  },
);

it.each([
  { files: false, tools: false },
  { files: false, tools: true },
  { files: true, tools: false },
  { files: true, tools: true },
])(
  "enforces capture before persistence and export, and masks error statuses ($files, $tools)",
  async ({ files, tools }) => {
    const home = makeTmpDir();
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += String(chunk)));
      req.on("end", () => {
        bodies.push(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      LANGFUSE_CURSOR_CAPTURE_FILE_CONTENT: String(files),
      LANGFUSE_CURSOR_CAPTURE_TOOL_OUTPUT: String(tools),
      LANGFUSE_CURSOR_FAIL_ON_ERROR: "true",
    };
    async function hook(payload: Record<string, unknown>) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [hookBin], {
          env,
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
        child.stdin.end(
          JSON.stringify({ conversation_id: "privacy", workspace_roots: [home], ...payload }),
        );
      });
    }
    try {
      await hook({ hook_event_name: "beforeSubmitPrompt", prompt: "inspect files" });
      await hook({ hook_event_name: "beforeReadFile", file_path: "/file", content: "FILE_MARKER" });
      await hook({
        hook_event_name: "postToolUse",
        tool_name: "Read",
        tool_use_id: "r",
        tool_output: "READ_MARKER",
      });
      await hook({
        hook_event_name: "postToolUse",
        tool_name: "Shell",
        tool_use_id: "s",
        tool_output: "GENERIC_MARKER",
      });
      await hook({
        hook_event_name: "afterShellExecution",
        command: "echo example",
        output: "SHELL_MARKER",
      });
      await hook({
        hook_event_name: "afterMCPExecution",
        tool_name: "lookup",
        result_json: "MCP_MARKER",
      });
      await hook({
        hook_event_name: "postToolUseFailure",
        tool_name: "Shell",
        tool_use_id: "error",
        error_message: "failed with sk-lf-test and pk-lf-test",
        failure_type: "error",
      });
      await hook({ hook_event_name: "afterAgentResponse", text: "done" });
      const eventFile = path.join(home, ".cursor/langfuse/conversations/privacy/events.jsonl");
      const local = fs.readFileSync(eventFile, "utf8");
      expect(local.includes("FILE_MARKER")).toBe(files);
      expect(local.includes("READ_MARKER")).toBe(files && tools);
      for (const marker of ["GENERIC_MARKER", "SHELL_MARKER", "MCP_MARKER"])
        expect(local.includes(marker)).toBe(tools);
      // Older versions persisted results even when capture was disabled.
      fs.appendFileSync(
        eventFile,
        JSON.stringify({
          ts: Date.now(),
          event: "postToolUse",
          payload: {
            hook_event_name: "postToolUse",
            tool_name: "Read",
            tool_use_id: "legacy",
            tool_output: "LEGACY_READ_MARKER",
          },
        }) + "\n",
      );
      await hook({ hook_event_name: "stop", status: "completed" });
      const exported = bodies.join("\n");
      expect(bodies.length).toBeGreaterThan(0);
      expect(exported.includes("READ_MARKER")).toBe(files && tools);
      expect(exported.includes("LEGACY_READ_MARKER")).toBe(files && tools);
      for (const marker of ["GENERIC_MARKER", "SHELL_MARKER", "MCP_MARKER"])
        expect(exported.includes(marker)).toBe(tools);
      expect(exported).toContain("langfuse.observation.status_message");
      expect(exported).toContain("redacted-langfuse-key");
      expect(exported).not.toContain(env.LANGFUSE_SECRET_KEY);
      expect(exported).not.toContain(env.LANGFUSE_PUBLIC_KEY);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);
