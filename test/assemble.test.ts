import { describe, expect, it } from "vitest";

import { assembleTurn, nameMatchesTool } from "../src/assemble.js";
import { parseTranscriptRows, splitTranscriptTurns } from "../src/transcript.js";
import type { StopPayload } from "../src/types.js";
import {
  BASE_TS,
  CONVERSATION,
  WORKSPACE,
  common,
  ev,
  sampleEvents,
  transcriptRows,
} from "./helpers.js";

function assemble(
  events = sampleEvents(),
  extra: Partial<Parameters<typeof assembleTurn>[0]> = {},
) {
  const stop = events.find((e) => e.event === "stop");
  return assembleTurn({
    conversationId: CONVERSATION,
    events,
    turnNumber: 1,
    closedBy: stop ? "stop" : "sessionEnd",
    stopPayload: stop?.payload as StopPayload | undefined,
    now: BASE_TS + 1_000,
    captureToolOutput: true,
    ...extra,
  });
}

describe("assembleTurn without a transcript (event-only path)", () => {
  const turn = assemble();

  it("takes the prompt, final text, status, model and usage from the hooks", () => {
    expect(turn.prompt).toBe("Add a README");
    expect(turn.finalText).toBe("Added README.md.");
    expect(turn.status).toBe("completed");
    expect(turn.model).toBe("claude-opus-4-7-thinking-max");
    expect(turn.modelId).toBe("claude-opus-4-7");
    expect(turn.modelParams).toEqual({ thinking: "true" });
    expect(turn.usage).toEqual({
      inputTokens: 10_000,
      outputTokens: 500,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_000,
    });
    expect(turn.startTime).toBe(BASE_TS);
    expect(turn.endTime).toBe(BASE_TS + 700);
    expect(turn.transcriptUsed).toBe(false);
  });

  it("closes one generation per afterAgentResponse and nests the tool calls in it", () => {
    expect(turn.generations).toHaveLength(1);
    const gen = turn.generations[0]!;
    expect(gen.source).toBe("events");
    expect(gen.text).toBe("Added README.md.");
    expect(gen.thoughts.map((t) => t.text)).toEqual(["Look at the repo first."]);
    expect(gen.toolCalls.map((c) => c.name)).toEqual(["Shell", "Write"]);
  });

  it("pairs pre/postToolUse by tool_use_id and enriches from the specific hooks", () => {
    const [shell, write] = assemble().generations[0]!.toolCalls;
    expect(shell!.toolUseId).toBe("t1");
    expect(shell!.output).toEqual({ exitCode: 0, stdout: "clean\n" });
    expect(shell!.sandbox).toBe(false);
    expect(shell!.durationMs).toBe(80);
    expect(shell!.startTime).toBe(BASE_TS + 200);
    expect(shell!.endTime).toBe(BASE_TS + 310);
    expect(shell!.sources).toEqual(
      expect.arrayContaining([
        "preToolUse",
        "postToolUse",
        "beforeShellExecution",
        "afterShellExecution",
      ]),
    );
    expect(write!.edits).toEqual([{ old_string: "", new_string: "# Demo\n" }]);
    expect(write!.output).toEqual({ success: true });
  });

  it("marks failed tools and keeps interrupted tools open until the turn ends", () => {
    const events = [
      ev("beforeSubmitPrompt", { prompt: "run tests" }, 0),
      ev(
        "preToolUse",
        { tool_name: "Shell", tool_input: { command: "npm test" }, tool_use_id: "a" },
        10,
      ),
      ev(
        "postToolUseFailure",
        {
          tool_name: "Shell",
          tool_input: { command: "npm test" },
          tool_use_id: "a",
          error_message: "Command timed out after 30s",
          failure_type: "timeout",
          duration: 30_000,
          is_interrupt: false,
        },
        50,
      ),
      ev("preToolUse", { tool_name: "Read", tool_input: { path: "/x" }, tool_use_id: "b" }, 60),
      ev("stop", { status: "aborted", loop_count: 0 }, 100),
    ];
    const turn = assemble(events);
    expect(turn.status).toBe("aborted");
    const calls = turn.generations.flatMap((g) => g.toolCalls);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.failure).toEqual({
      message: "Command timed out after 30s",
      failureType: "timeout",
      isInterrupt: false,
    });
    expect(calls[1]!.endTime).toBe(turn.endTime);
  });

  it("attaches subagents to the Task tool call that spawned them", () => {
    const events = [
      ev("beforeSubmitPrompt", { prompt: "explore" }, 0),
      ev(
        "preToolUse",
        { tool_name: "Task", tool_input: { description: "Explore auth" }, tool_use_id: "task-1" },
        10,
      ),
      ev(
        "subagentStart",
        {
          subagent_id: "s1",
          subagent_type: "explore",
          task: "Explore the authentication flow",
          tool_call_id: "task-1",
          subagent_model: "claude-sonnet-4-6",
        },
        20,
      ),
      ev(
        "subagentStop",
        {
          subagent_id: "s1",
          subagent_type: "explore",
          status: "completed",
          task: "Explore the authentication flow",
          summary: "Auth lives in src/auth.ts",
          duration_ms: 400,
          message_count: 6,
          tool_call_count: 3,
          modified_files: [],
          agent_transcript_path: null,
        },
        420,
      ),
      ev(
        "postToolUse",
        { tool_name: "Task", tool_input: {}, tool_output: "{}", tool_use_id: "task-1" },
        430,
      ),
      ev(
        "subagentStart",
        { subagent_id: "s2", subagent_type: "shell", task: "background job" },
        500,
      ),
      ev("afterAgentResponse", { text: "done" }, 600),
      ev("stop", { status: "completed" }, 700),
    ];
    const turn = assemble(events);
    const task = turn.generations[0]!.toolCalls.find((c) => c.name === "Task")!;
    expect(task.subagents).toHaveLength(1);
    expect(task.subagents[0]!.summary).toBe("Auth lives in src/auth.ts");
    expect(task.subagents[0]!.missingStop).toBe(false);
    // Background subagents never get a subagentStop (Cursor bug): kept as orphan, flagged.
    expect(turn.orphanSubagents).toHaveLength(1);
    expect(turn.orphanSubagents[0]!.missingStop).toBe(true);
  });

  it("builds tool calls from the specific hooks alone when the generic hooks are absent", () => {
    const events = [
      ev("beforeSubmitPrompt", { prompt: "x" }, 0),
      ev("beforeShellExecution", { command: "ls", cwd: WORKSPACE }, 10),
      ev("afterShellExecution", { command: "ls", output: "a\nb\n", duration: 5 }, 20),
      ev(
        "beforeMCPExecution",
        { tool_name: "create_note", tool_input: '{"title":"t"}', mcp_server_name: "notes" },
        30,
      ),
      ev(
        "afterMCPExecution",
        {
          tool_name: "create_note",
          tool_input: '{"title":"t"}',
          mcp_server_name: "notes",
          result_json: '{"ok":true}',
          duration: 9,
        },
        40,
      ),
      ev(
        "afterFileEdit",
        { file_path: "/w/a.ts", edits: [{ old_string: "a", new_string: "b" }] },
        50,
      ),
      ev("beforeReadFile", { file_path: "/w/b.ts", content_length: 12 }, 60),
      ev("stop", { status: "completed" }, 100),
    ];
    const calls = assemble(events).generations.flatMap((g) => g.toolCalls);
    expect(calls.map((c) => c.name)).toEqual(["Shell", "create_note", "Edit", "Read"]);
    expect(calls[0]!.output).toBe("a\nb\n");
    expect(calls[1]!.mcpServer).toBe("notes");
    expect(calls[1]!.input).toEqual({ title: "t" });
    expect(calls[1]!.output).toEqual({ ok: true });
    expect(calls[2]!.edits).toHaveLength(1);
  });

  it("drops tool outputs when capture is off", () => {
    const turn = assemble(sampleEvents(), { captureToolOutput: false });
    for (const call of turn.generations.flatMap((g) => g.toolCalls))
      expect(call.output).toBeUndefined();
  });

  it("reports turns closed without a stop hook as interrupted", () => {
    const events = sampleEvents().filter((e) => e.event !== "stop");
    const turn = assemble(events, { closedBy: "sessionEnd" });
    expect(turn.status).toBe("interrupted");
    expect(turn.usage).toBeUndefined();
  });
});

describe("assembleTurn with a transcript", () => {
  const transcript = splitTranscriptTurns(
    parseTranscriptRows(
      transcriptRows("Earlier question", [{ text: "Earlier answer" }]) +
        transcriptRows("Add a README", [
          {
            text: "Checking the repo.",
            tools: [{ name: "Shell", input: { command: "git status" } }],
          },
          {
            text: "Writing the file.",
            tools: [{ name: "Write", input: { path: `${WORKSPACE}/README.md` } }],
          },
          { text: "Added README.md." },
        ]),
    ),
  );
  const turn = assemble(sampleEvents(), { transcriptTurns: transcript, turnNumber: 2 });

  it("uses the assistant rows as generation boundaries and matches the observed tool calls", () => {
    expect(turn.transcriptUsed).toBe(true);
    expect(turn.generations).toHaveLength(3);
    expect(turn.generations.map((g) => g.text)).toEqual([
      "Checking the repo.",
      "Writing the file.",
      "Added README.md.",
    ]);
    expect(turn.generations[0]!.toolCalls.map((c) => c.toolUseId)).toEqual(["t1"]);
    expect(turn.generations[1]!.toolCalls.map((c) => c.toolUseId)).toEqual(["t2"]);
    expect(turn.generations[2]!.toolCalls).toHaveLength(0);
    for (let i = 1; i < turn.generations.length; i++) {
      expect(turn.generations[i]!.startTime).toBe(turn.generations[i - 1]!.endTime);
    }
    expect(turn.generations[2]!.endTime).toBe(turn.endTime);
  });

  it("carries the earlier turns as conversation history", () => {
    expect(turn.history).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]);
  });

  it("falls back to the transcript prompt when beforeSubmitPrompt never fired", () => {
    const events = sampleEvents().filter((e) => e.event !== "beforeSubmitPrompt");
    const t = assemble(events, { transcriptTurns: transcript, turnNumber: 2 });
    expect(t.prompt).toBe("Add a README");
  });
});

describe("nameMatchesTool", () => {
  it("matches the MCP naming variants Cursor uses across surfaces", () => {
    expect(nameMatchesTool("MCP:create_note", "mcp_notes_create_note")).toBe(true);
    expect(nameMatchesTool("mcp_notes_create_note", "create_note")).toBe(true);
    expect(nameMatchesTool("Shell", "shell")).toBe(true);
    expect(nameMatchesTool("Read", "Write")).toBe(false);
  });
});

describe("event payload metadata", () => {
  it("prefers the stop payload for model fields", () => {
    const events = [
      ev("beforeSubmitPrompt", { prompt: "x", model: "old-model" }, 0),
      ev("stop", { status: "completed", model: "new-model", model_id: "new-id" }, 10),
    ];
    const turn = assemble(events);
    expect(turn.model).toBe("new-model");
    expect(turn.modelId).toBe("new-id");
    expect(turn.userEmail).toBe(common.user_email);
    expect(turn.eventCounts).toEqual({ beforeSubmitPrompt: 1, stop: 1 });
  });
});
