import * as fs from "node:fs";
import * as path from "node:path";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
} from "@langfuse/tracing";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assembleTurn } from "../src/assemble.js";
import { DeterministicIdGenerator, spanIdFor } from "../src/ids.js";
import { emitTurn, traceIdForTurn } from "../src/trace.js";
import { parseTranscriptRows, splitTranscriptTurns } from "../src/transcript.js";
import type { StopPayload } from "../src/types.js";
import { traceIdFromSeed } from "../src/utils.js";
import { PLUGIN_VERSION } from "../src/version.js";
import {
  BASE_TS,
  CONVERSATION,
  WORKSPACE,
  baseConfig,
  cleanTmpDirs,
  ev,
  makeTmpDir,
  sampleEvents,
  transcriptRows,
} from "./helpers.js";

const exporter = new InMemorySpanExporter();
const ids = new DeterministicIdGenerator();
let provider: NodeTracerProvider;
// The real span processor (with an in-memory exporter) so propagated trace
// attributes and masking behave exactly as in production.
let processor: LangfuseSpanProcessor;

beforeAll(() => {
  processor = new LangfuseSpanProcessor({
    exporter,
    publicKey: baseConfig.public_key,
    secretKey: baseConfig.secret_key,
    exportMode: "immediate",
    mediaUploadEnabled: false,
    shouldExportSpan: () => true,
  });
  provider = new NodeTracerProvider({ spanProcessors: [processor], idGenerator: ids });
  provider.register();
  setLangfuseTracerProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
});
beforeEach(() => exporter.reset());
afterEach(cleanTmpDirs);

const attr = (span: ReadableSpan, key: string): string =>
  span.attributes[key] == null ? "" : String(span.attributes[key]);
const obsType = (span: ReadableSpan) => attr(span, "langfuse.observation.type");
const parentId = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;
const byName = (spans: ReadableSpan[], name: string) => spans.filter((s) => s.name === name);
const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

async function flushed<T>(p: Promise<T>): Promise<T> {
  const result = await p;
  await processor.forceFlush();
  return result;
}

function turnFromSample(extra: Partial<Parameters<typeof assembleTurn>[0]> = {}) {
  const events = sampleEvents();
  return assembleTurn({
    conversationId: CONVERSATION,
    events,
    turnNumber: 1,
    closedBy: "stop",
    stopPayload: events.find((e) => e.event === "stop")!.payload as StopPayload,
    now: BASE_TS + 1_000,
    captureToolOutput: true,
    ...extra,
  });
}

describe("emitTurn", () => {
  it("emits agent → generation → tool with deterministic ids and trace attributes", async () => {
    const turn = turnFromSample();
    const traceId = await flushed(emitTurn(turn, { config: baseConfig, ids }));
    expect(traceId).toBe(traceIdFromSeed(`cursor:${CONVERSATION}:1`));

    const spans = exporter.getFinishedSpans();
    const root = byName(spans, "Cursor Turn")[0]!;
    expect(obsType(root)).toBe("agent");
    expect(root.spanContext().traceId).toBe(traceId);
    expect(root.spanContext().spanId).toBe(spanIdFor(traceId, "root"));
    expect(parentId(root)).toBeUndefined();
    expect(attr(root, LangfuseOtelSpanAttributes.TRACE_SESSION_ID)).toBe(CONVERSATION);
    expect(attr(root, LangfuseOtelSpanAttributes.TRACE_USER_ID)).toBe("dev@example.com");
    expect(attr(root, LangfuseOtelSpanAttributes.TRACE_NAME)).toBe("Cursor Turn");
    expect(root.attributes[LangfuseOtelSpanAttributes.TRACE_TAGS]).toEqual(["cursor"]);
    expect(attr(root, "langfuse.observation.input")).toContain("Add a README");
    expect(attr(root, "langfuse.observation.output")).toContain("Added README.md.");
    expect(ms(root.startTime)).toBe(BASE_TS);
    expect(ms(root.endTime)).toBe(BASE_TS + 700);

    const gens = byName(spans, "LLM");
    expect(gens).toHaveLength(1);
    const gen = gens[0]!;
    expect(obsType(gen)).toBe("generation");
    expect(parentId(gen)).toBe(root.spanContext().spanId);
    expect(attr(gen, "langfuse.observation.model.name")).toBe("claude-opus-4-7");
    const output = JSON.parse(attr(gen, "langfuse.observation.output"));
    expect(output.role).toBe("assistant");
    expect(output.thinking[0]).toEqual({ type: "thinking", content: "Look at the repo first." });
    expect(output.tool_calls.map((t: { function: { name: string } }) => t.function.name)).toEqual([
      "Shell",
      "Write",
    ]);
    const usage = JSON.parse(attr(gen, "langfuse.observation.usage_details"));
    expect(usage).toEqual({
      input: 1_000,
      output: 500,
      total: 10_500,
      cache_read_input_tokens: 8_000,
      cache_creation_input_tokens: 1_000,
    });

    const tools = spans.filter((s) => obsType(s) === "tool");
    expect(tools.map((s) => s.name).sort()).toEqual(["Shell", "Write"]);
    for (const tool of tools) expect(parentId(tool)).toBe(gen.spanContext().spanId);
    const shell = byName(spans, "Shell")[0]!;
    expect(JSON.parse(attr(shell, "langfuse.observation.output"))).toEqual({
      exitCode: 0,
      stdout: "clean\n",
    });
    expect(ms(shell.startTime)).toBe(BASE_TS + 200);
    expect(ms(shell.endTime)).toBe(BASE_TS + 310);
  });

  it("is idempotent: the same turn yields the same span ids", async () => {
    await flushed(emitTurn(turnFromSample(), { config: baseConfig, ids }));
    const first = exporter
      .getFinishedSpans()
      .map((s) => s.spanContext().spanId)
      .sort();
    exporter.reset();
    await flushed(emitTurn(turnFromSample(), { config: baseConfig, ids }));
    const second = exporter
      .getFinishedSpans()
      .map((s) => s.spanContext().spanId)
      .sort();
    expect(second).toEqual(first);
  });

  it("splits generations along the transcript rows and zero-fills usage on the non-final ones", async () => {
    const transcript = splitTranscriptTurns(
      parseTranscriptRows(
        transcriptRows("Add a README", [
          { text: "Checking.", tools: [{ name: "Shell", input: { command: "git status" } }] },
          {
            text: "Writing.",
            tools: [{ name: "Write", input: { path: `${WORKSPACE}/README.md` } }],
          },
          { text: "Added README.md." },
        ]),
      ),
    );
    await flushed(
      emitTurn(turnFromSample({ transcriptTurns: transcript }), { config: baseConfig, ids }),
    );
    const spans = exporter.getFinishedSpans();
    const gens = byName(spans, "LLM").sort((a, b) => ms(a.startTime) - ms(b.startTime));
    expect(gens).toHaveLength(3);
    expect(JSON.parse(attr(gens[0]!, "langfuse.observation.usage_details"))).toEqual({
      input: 0,
      output: 0,
      total: 0,
    });
    expect(JSON.parse(attr(gens[2]!, "langfuse.observation.usage_details")).total).toBe(10_500);
    const input = JSON.parse(attr(gens[1]!, "langfuse.observation.input"));
    expect(input.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(input[2].tool_results[0].output).toEqual({ exitCode: 0, stdout: "clean\n" });
  });

  it("flags failures and interrupted turns with levels", async () => {
    const events = [
      ev("beforeSubmitPrompt", { prompt: "run" }, 0),
      ev(
        "preToolUse",
        { tool_name: "Shell", tool_input: { command: "npm test" }, tool_use_id: "a" },
        10,
      ),
      ev(
        "postToolUseFailure",
        { tool_name: "Shell", tool_use_id: "a", error_message: "boom", failure_type: "error" },
        50,
      ),
      ev("sessionEnd", { reason: "window_close" }, 90),
    ];
    const turn = assembleTurn({
      conversationId: CONVERSATION,
      events,
      turnNumber: 3,
      closedBy: "sessionEnd",
      now: BASE_TS + 100,
      captureToolOutput: true,
    });
    await flushed(emitTurn(turn, { config: baseConfig, ids }));
    const spans = exporter.getFinishedSpans();
    const root = byName(spans, "Cursor Turn")[0]!;
    expect(attr(root, "langfuse.observation.level")).toBe("WARNING");
    expect(attr(root, "langfuse.observation.status_message")).toContain("sessionEnd");
    const shell = byName(spans, "Shell")[0]!;
    expect(attr(shell, "langfuse.observation.level")).toBe("ERROR");
    expect(attr(shell, "langfuse.observation.status_message")).toBe("boom");
  });

  it("nests subagents under the Task tool and reads their transcript", async () => {
    const dir = makeTmpDir();
    const subTranscript = path.join(dir, "sub.jsonl");
    fs.writeFileSync(
      subTranscript,
      transcriptRows("Review the README", [
        { text: "Reading.", tools: [{ name: "Read", input: { path: "/w/README.md" } }] },
        { text: "Looks good." },
      ]),
    );
    const events = [
      ev("beforeSubmitPrompt", { prompt: "review" }, 0),
      ev(
        "preToolUse",
        { tool_name: "Task", tool_input: { description: "Review" }, tool_use_id: "task-1" },
        10,
      ),
      ev(
        "subagentStart",
        {
          subagent_id: "s1",
          subagent_type: "generalPurpose",
          task: "Review the README",
          tool_call_id: "task-1",
          subagent_model: "claude-sonnet-4-6",
        },
        20,
      ),
      ev(
        "subagentStop",
        {
          subagent_id: "s1",
          status: "completed",
          task: "Review the README",
          summary: "Looks good.",
          duration_ms: 300,
          agent_transcript_path: subTranscript,
        },
        320,
      ),
      ev(
        "postToolUse",
        { tool_name: "Task", tool_input: {}, tool_output: "{}", tool_use_id: "task-1" },
        330,
      ),
      ev("afterAgentResponse", { text: "Reviewed." }, 400),
      ev("stop", { status: "completed" }, 500),
    ];
    const turn = assembleTurn({
      conversationId: CONVERSATION,
      events,
      turnNumber: 1,
      closedBy: "stop",
      stopPayload: events[events.length - 1]!.payload as StopPayload,
      now: BASE_TS + 600,
      captureToolOutput: true,
    });
    await flushed(emitTurn(turn, { config: baseConfig, ids }));
    const spans = exporter.getFinishedSpans();
    const task = byName(spans, "Task")[0]!;
    const sub = byName(spans, "Cursor Subagent")[0]!;
    expect(obsType(sub)).toBe("agent");
    expect(parentId(sub)).toBe(task.spanContext().spanId);
    expect(attr(sub, "langfuse.observation.output")).toContain("Looks good.");
    const subGens = byName(spans, "LLM Subagent").sort((a, b) => ms(a.startTime) - ms(b.startTime));
    expect(subGens).toHaveLength(2);
    for (const g of subGens) expect(parentId(g)).toBe(sub.spanContext().spanId);
    expect(attr(subGens[0]!, "langfuse.observation.model.name")).toBe("claude-sonnet-4-6");
    const read = byName(spans, "Read")[0]!;
    expect(parentId(read)).toBe(subGens[0]!.spanContext().spanId);
  });

  it("attaches to an existing trace when a traceparent is configured", async () => {
    const config = {
      ...baseConfig,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    };
    const turn = turnFromSample();
    expect(traceIdForTurn(config, CONVERSATION, 1)).toBe("0af7651916cd43dd8448eb211c80319c");
    await flushed(emitTurn(turn, { config, ids }));
    const root = byName(exporter.getFinishedSpans(), "Cursor Turn")[0]!;
    expect(root.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(parentId(root)).toBe("b7ad6b7169203331");
    // Trace-level attributes belong to the calling application in attached mode.
    expect(root.attributes[LangfuseOtelSpanAttributes.TRACE_TAGS]).toBeUndefined();
  });

  it("derives trace ids from a configured seed", () => {
    const config = { ...baseConfig, trace_seed: "run-42" };
    expect(traceIdForTurn(config, CONVERSATION, 2)).toBe(traceIdFromSeed("run-42:2"));
  });
});

describe("instrumentation resource", () => {
  it("names the service instead of leaking the node path, and honours OTEL_SERVICE_NAME", async () => {
    const { setupInstrumentation } = await import("../src/instrumentation.js");

    const attributesOf = (env: Record<string, string | undefined>) => {
      const saved = process.env.OTEL_SERVICE_NAME;
      if (env.OTEL_SERVICE_NAME === undefined) delete process.env.OTEL_SERVICE_NAME;
      else process.env.OTEL_SERVICE_NAME = env.OTEL_SERVICE_NAME;
      const instrumentation = setupInstrumentation(baseConfig);
      // The provider is not reachable from the return value, so read the
      // resource off a span it produces.
      const span = startObservation("probe", {}, { asType: "span" });
      span.end();
      const resource = (
        span.otelSpan as unknown as { resource: { attributes: Record<string, unknown> } }
      ).resource.attributes;
      if (saved === undefined) delete process.env.OTEL_SERVICE_NAME;
      else process.env.OTEL_SERVICE_NAME = saved;
      void instrumentation;
      return resource;
    };

    const defaults = attributesOf({});
    expect(defaults["service.name"]).toBe("cursor");
    expect(String(defaults["service.name"])).not.toContain("unknown_service");
    expect(defaults["service.version"]).toBe(PLUGIN_VERSION);

    expect(attributesOf({ OTEL_SERVICE_NAME: "cursor-cloud" })["service.name"]).toBe(
      "cursor-cloud",
    );
  });
});
