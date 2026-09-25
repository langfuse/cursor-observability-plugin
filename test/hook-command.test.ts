import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cleanTmpDirs, common, makeTmpDir } from "./helpers.js";

/**
 * End-to-end through the built bundle: state machine, passthrough answers and
 * the export attempt. Langfuse itself is replaced by an unreachable address, so
 * the export fails fast and the test asserts the fail-open behaviour. The
 * happy path against a real project is `pnpm run test:live`.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookBin = path.join(repoRoot, "dist", "index.mjs");

type Run = { code: number | null; stdout: string; stderr: string };

function runHook(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBin], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(JSON.stringify({ ...common, ...payload }));
  });
}

afterEach(cleanTmpDirs);

describe("dist/index.mjs", () => {
  it("answers the gates and records the turn, then exports and resets on stop", async () => {
    const home = makeTmpDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      // Unreachable on purpose: the export must fail open, quickly.
      LANGFUSE_BASE_URL: "http://127.0.0.1:9",
      LANGFUSE_CURSOR_DEBUG: "true",
    };
    const stateDir = path.join(
      home,
      ".cursor",
      "langfuse",
      "conversations",
      common.conversation_id!,
    );

    let run = await runHook({ hook_event_name: "sessionStart", composer_mode: "agent" }, env);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("{}");

    run = await runHook({ hook_event_name: "beforeSubmitPrompt", prompt: "hello" }, env);
    expect(run.stdout).toBe('{"continue":true}');
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf-8"));
    expect(state.openTurn.turnNumber).toBe(1);
    expect(state.session.composerMode).toBe("agent");

    run = await runHook(
      {
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_input: { command: "ls" },
        tool_use_id: "a",
      },
      env,
    );
    expect(run.stdout).toBe('{"permission":"allow"}');
    run = await runHook(
      { hook_event_name: "beforeReadFile", file_path: "/w/x", content: "secret file body" },
      env,
    );
    expect(run.stdout).toBe('{"permission":"allow"}');
    run = await runHook({ hook_event_name: "afterAgentResponse", text: "done" }, env);
    expect(run.stdout).toBe("{}");

    const events = fs.readFileSync(path.join(stateDir, "events.jsonl"), "utf-8").trim().split("\n");
    expect(events).toHaveLength(4);
    // File contents are not stored unless opted in.
    expect(events[2]).not.toContain("secret file body");
    expect(events[2]).toContain('"content_length":16');

    run = await runHook({ hook_event_name: "stop", status: "completed", loop_count: 0 }, env);
    expect(run.code).toBe(0); // fail-open
    expect(run.stdout).toBe("{}");

    const after = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf-8"));
    expect(after.turnsCompleted).toBe(1);
    expect(after.openTurn).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "events.jsonl"))).toBe(false);
    const log = fs.readFileSync(path.join(home, ".cursor", "langfuse", "hook.log"), "utf-8");
    expect(log).toContain("emitted turn 1");
    expect(log).toContain("Export of turn 1 failed");
  }, 60_000);

  it("stays silent and fast when tracing is off", async () => {
    const home = makeTmpDir();
    const env = { PATH: process.env.PATH, HOME: home };
    const started = Date.now();
    const run = await runHook(
      { hook_event_name: "beforeShellExecution", command: "rm -rf /", cwd: "/" },
      env,
    );
    expect(run.stdout).toBe('{"permission":"allow"}');
    expect(run.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fs.existsSync(path.join(home, ".cursor", "langfuse", "conversations"))).toBe(false);
  });

  it("logs why tracing is off once per turn", async () => {
    const home = makeTmpDir();
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_TRACING_ENABLED: "false",
    };
    await runHook({ hook_event_name: "beforeSubmitPrompt", prompt: "x" }, env);
    const log = fs.readFileSync(path.join(home, ".cursor", "langfuse", "hook.log"), "utf-8");
    expect(log).toContain("kill switch");
  });

  it("surfaces export failures as a non-zero exit when fail_on_error is set", async () => {
    const home = makeTmpDir();
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: "http://127.0.0.1:9",
      LANGFUSE_CURSOR_FAIL_ON_ERROR: "true",
    };
    await runHook({ hook_event_name: "beforeSubmitPrompt", prompt: "x" }, env);
    const run = await runHook({ hook_event_name: "stop", status: "completed" }, env);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("{}");
  }, 60_000);

  it("answers neutrally on unparsable input", async () => {
    const child = spawn(process.execPath, [hookBin], {
      env: { PATH: process.env.PATH },
      stdio: "pipe",
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stdin.end("not json");
    await new Promise((r) => child.once("close", r));
    expect(stdout.trim()).toBe("{}");
  });
});

describe("end-to-end export", () => {
  /**
   * The one test that proves a turn actually leaves the process: drive the
   * built bundle through a small conversation and assert the OTLP request
   * arrives, at a receiver in this process. No keys and no internet, so it
   * runs on every CI run.
   */
  it("delivers a turn to the OTLP endpoint with the expected observation tree", async (ctx) => {
    const home = makeTmpDir();
    const workspace = makeTmpDir();
    const conversation = "e2e-11111111-2222-4333-8444-555555555555";

    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf-8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    // Some sandboxes forbid binding a local port. Skip rather than hang there;
    // CI and a normal dev machine run the test.
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, "127.0.0.1", () => resolve(true));
    });
    if (!listening) {
      ctx.skip("cannot bind 127.0.0.1 in this environment");
      return;
    }
    const { port } = server.address() as AddressInfo;

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
      LANGFUSE_CURSOR_FAIL_ON_ERROR: "true",
    };
    const common = { conversation_id: conversation, workspace_roots: [workspace] };

    const steps: Array<Record<string, unknown>> = [
      { hook_event_name: "beforeSubmitPrompt", prompt: "Add a README" },
      { hook_event_name: "afterAgentThought", text: "Check the repo first.", duration_ms: 900 },
      {
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_input: { command: "git status" },
        tool_use_id: "t1",
      },
      {
        hook_event_name: "postToolUse",
        tool_name: "Shell",
        tool_input: { command: "git status" },
        tool_output: JSON.stringify({ exitCode: 0, stdout: "clean\n" }),
        tool_use_id: "t1",
        duration: 80,
      },
      { hook_event_name: "afterAgentResponse", text: "Added README.md." },
      {
        hook_event_name: "stop",
        status: "completed",
        loop_count: 0,
        input_tokens: 10_000,
        output_tokens: 500,
        cache_read_tokens: 8_000,
        cache_write_tokens: 1_000,
      },
    ];
    for (const step of steps) {
      const run = await runHook({ ...common, ...step }, env);
      expect(run.code, `hook ${String(step.hook_event_name)} failed: ${run.stderr}`).toBe(0);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(bodies, "no OTLP request arrived").toHaveLength(1);
    const payload = bodies[0]!;
    expect(payload).toContain('"service.name"');
    expect(payload).toContain('"stringValue":"cursor"');
    expect(payload).toContain(conversation);
    expect(payload).toContain("Cursor Turn");
    expect(payload).toContain('"name":"LLM"');
    expect(payload).toContain('"name":"Shell"');
    expect(payload).toContain("Added README.md.");
    expect(payload).toContain("Check the repo first.");
    expect(payload).toContain("cache_read_input_tokens");
    // Keys must never travel in a payload.
    expect(payload).not.toContain("sk-lf-test");

    const log = fs.readFileSync(path.join(home, ".cursor", "langfuse", "hook.log"), "utf-8");
    expect(log).toMatch(
      /Exported turn 1 \(\d+ hook events, closed by stop\) as trace [0-9a-f]{32}/,
    );
  }, 60_000);
});
