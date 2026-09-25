import {
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
  type LangfuseObservationAttributes,
  type StartObservationOpts,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import { spanIdFor, type DeterministicIdGenerator } from "./ids.js";
import { readTranscriptTurns } from "./transcript.js";
import type { ChatMessage, Generation, SubagentRun, ToolCall, Turn } from "./types.js";
import {
  clipDeep,
  clipText,
  debugLog,
  parseTraceparent,
  toText,
  traceIdFromSeed,
} from "./utils.js";
import { PLUGIN_VERSION } from "./version.js";

/**
 * Emit one assembled Cursor turn as a Langfuse trace.
 *
 * Tree:
 *   Cursor Turn (agent)                       ← one trace per user prompt
 *   ├── LLM (generation)                      ← one per assistant message
 *   │   ├── Shell / Read / Write / … (tool)   ← tool calls that message requested
 *   │   │   └── Cursor Subagent (agent)       ← Task tool: the spawned subagent
 *   │   │       └── LLM Subagent (generation) ← from the subagent transcript
 *   │   └── …
 *   └── Context compaction (event)
 *
 * Every observation gets a deterministic id, so exporting the same turn twice
 * upserts instead of duplicating. All turns of a conversation share the
 * `conversation_id` as Langfuse session id.
 */

export const TRACE_NAME = "Cursor Turn";

export type EmitContext = {
  config: Config;
  ids: DeterministicIdGenerator;
};

export function traceIdForTurn(config: Config, conversationId: string, turnNumber: number): string {
  const parent = parseTraceparent(config.traceparent);
  if (parent) return parent.traceId;
  if (config.trace_seed) return traceIdFromSeed(`${config.trace_seed}:${turnNumber}`);
  return traceIdFromSeed(`cursor:${conversationId}:${turnNumber}`);
}

function clampEnd(start: number, end: number): Date {
  return new Date(Math.max(start, end));
}

function statusOf(turn: Turn): { level?: "WARNING" | "ERROR"; statusMessage?: string } {
  switch (turn.status) {
    case "error":
      return { level: "ERROR", statusMessage: "Turn ended with an error" };
    case "aborted":
      return { level: "WARNING", statusMessage: "Turn aborted by the user" };
    case "interrupted":
      return {
        level: "WARNING",
        statusMessage: `Turn closed by ${turn.closedBy} without a stop hook`,
      };
    default:
      return {};
  }
}

function usageDetails(turn: Turn): LangfuseGenerationAttributes["usageDetails"] {
  const usage = turn.usage;
  if (!usage) return undefined;
  const fresh = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const details: Record<string, number> = {
    input: fresh,
    output: usage.outputTokens,
    total: usage.inputTokens + usage.outputTokens,
  };
  if (usage.cacheReadTokens > 0) details.cache_read_input_tokens = usage.cacheReadTokens;
  if (usage.cacheWriteTokens > 0) details.cache_creation_input_tokens = usage.cacheWriteTokens;
  return details;
}

function toolCallsOutput(calls: ToolCall[], maxChars: number) {
  return calls.map((call, i) => ({
    id: call.toolUseId ?? `call-${i}`,
    type: "function",
    function: { name: call.name, arguments: clipText(toText(call.input), maxChars) },
  }));
}

function generationOutput(gen: Generation, maxChars: number): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = { role: "assistant" };
  if (gen.text) output.content = clipText(gen.text, maxChars);
  if (gen.thoughts.length > 0) {
    // Langfuse renders this ChatML shape as thinking blocks.
    output.thinking = gen.thoughts.map((t) => ({
      type: "thinking",
      content: clipText(t.text, maxChars),
    }));
  }
  if (gen.toolCalls.length > 0) output.tool_calls = toolCallsOutput(gen.toolCalls, maxChars);
  if (gen.otherBlocks.length > 0) output.blocks = clipDeep(gen.otherBlocks, maxChars);
  return Object.keys(output).length > 1 ? output : undefined;
}

function toolResultsMessage(gen: Generation, maxChars: number): ChatMessage | undefined {
  const results = gen.toolCalls
    .filter((c) => c.output !== undefined || c.failure)
    .map((c, i) => ({
      tool_use_id: c.toolUseId ?? `call-${i}`,
      name: c.name,
      ...(c.output !== undefined ? { output: clipDeep(c.output, maxChars) } : {}),
      ...(c.failure ? { error: c.failure.message ?? c.failure.failureType ?? "failed" } : {}),
    }));
  return results.length > 0 ? { role: "tool", tool_results: results } : undefined;
}

function toolStatus(call: ToolCall): {
  level?: "WARNING" | "ERROR";
  statusMessage?: string;
} {
  if (call.failure) {
    const message = call.failure.message ?? `Tool ${call.failure.failureType ?? "failed"}`;
    if (call.failure.failureType === "permission_denied" || call.failure.isInterrupt) {
      return { level: "WARNING", statusMessage: message };
    }
    return { level: "ERROR", statusMessage: message };
  }
  if (call.sources.length === 1 && call.sources[0] === "preToolUse") {
    return { level: "WARNING", statusMessage: "Tool call did not complete before the turn ended" };
  }
  return {};
}

function toolName(call: ToolCall): string {
  if (call.mcpServer && !call.name.includes(call.mcpServer))
    return `${call.mcpServer}.${call.name}`;
  return call.name || "tool";
}

function subagentStatus(run: SubagentRun): { level?: "WARNING" | "ERROR"; statusMessage?: string } {
  if (run.status === "error")
    return { level: "ERROR", statusMessage: "Subagent ended with an error" };
  if (run.status === "aborted") return { level: "WARNING", statusMessage: "Subagent aborted" };
  if (run.missingStop) {
    return {
      level: "WARNING",
      statusMessage: "No subagentStop hook was observed for this subagent",
    };
  }
  return {};
}

export async function emitTurn(turn: Turn, ctx: EmitContext): Promise<string> {
  const { config, ids } = ctx;
  const maxChars = config.max_chars;
  const traceId = traceIdForTurn(config, turn.conversationId, turn.turnNumber);
  const parent = parseTraceparent(config.traceparent);

  // Queue the deterministic span id right before the SDK call that consumes it.
  const start: Starter = (label, name, attributes, options) => {
    ids.queueSpanId(spanIdFor(traceId, label));
    return (
      startObservation as unknown as (
        n: string,
        a: LangfuseObservationAttributes,
        o: StartObservationOpts,
      ) => LangfuseObservation
    )(name, attributes, options);
  };

  const emit = async () => {
    const rootParent: SpanContext | undefined = parent
      ? {
          traceId: parent.traceId,
          spanId: parent.spanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        }
      : undefined;
    if (!rootParent) ids.queueTraceId(traceId);

    const rootInput = turn.prompt
      ? {
          role: "user",
          content: clipText(turn.prompt, maxChars),
          ...(turn.attachments && turn.attachments.length > 0
            ? {
                attachments: turn.attachments.map((a) => ({
                  type: a.type,
                  file_path: a.file_path,
                })),
              }
            : {}),
        }
      : undefined;
    const rootOutput = turn.finalText
      ? { role: "assistant", content: clipText(turn.finalText, maxChars) }
      : undefined;

    const root = start(
      "root",
      TRACE_NAME,
      {
        input: rootInput,
        output: rootOutput,
        ...statusOf(turn),
        metadata: {
          "cursor.conversation_id": turn.conversationId,
          "cursor.generation_id": turn.generationId,
          "cursor.turn": turn.turnNumber,
          "cursor.status": turn.status,
          "cursor.closed_by": turn.closedBy,
          "cursor.loop_count": turn.loopCount,
          "cursor.model": turn.model,
          "cursor.model_id": turn.modelId,
          "cursor.model_params": turn.modelParams,
          "cursor.version": turn.cursorVersion,
          "cursor.workspace_roots": turn.workspaceRoots,
          "cursor.composer_mode": turn.composerMode,
          "cursor.background_agent": turn.isBackgroundAgent,
          "cursor.transcript_path": turn.transcriptPath,
          "cursor.transcript_used": turn.transcriptUsed,
          "cursor.tool_call_count": turn.generations.reduce((n, g) => n + g.toolCalls.length, 0),
          "cursor.hook_events": turn.eventCounts,
          "cursor.timing_source": "hook-observed",
          "langfuse.plugin.version": PLUGIN_VERSION,
          ...(parent ? { parent_trace_id: parent.traceId, parent_span_id: parent.spanId } : {}),
        },
      },
      { asType: "agent", startTime: new Date(turn.startTime), parentSpanContext: rootParent },
    );

    const messages: ChatMessage[] = [...turn.history];
    if (turn.prompt) messages.push({ role: "user", content: clipText(turn.prompt, maxChars) });

    turn.generations.forEach((gen, i) => {
      const isLast = i === turn.generations.length - 1;
      const output = generationOutput(gen, maxChars);
      const generation = start(
        `gen:${i}`,
        "LLM",
        {
          input: messages.length > 0 ? [...messages] : undefined,
          output,
          model: turn.modelId ?? turn.model,
          modelParameters: turn.modelParams,
          // Cursor reports usage once per turn, so the turn total lives on the
          // last generation. The others carry explicit zeros: a generation with
          // a model and no usage would make Langfuse infer tokens from the
          // text, which double counts on top of the turn total.
          usageDetails: isLast
            ? usageDetails(turn)
            : turn.usage
              ? { input: 0, output: 0, total: 0 }
              : undefined,
          metadata: {
            "cursor.generation_index": i,
            "cursor.boundary_source": gen.source,
            ...(turn.usage
              ? { "cursor.usage_scope": isLast ? "turn" : "reported-on-last-generation" }
              : {}),
            ...(gen.thoughts.length > 0
              ? {
                  "cursor.thinking_ms": gen.thoughts.reduce((n, t) => n + (t.durationMs ?? 0), 0),
                }
              : {}),
          },
        },
        {
          asType: "generation",
          startTime: new Date(gen.startTime),
          parentSpanContext: root.otelSpan.spanContext(),
        },
      );

      gen.toolCalls.forEach((call, j) => {
        emitToolCall(call, generation, `gen:${i}:tool:${j}`, start, maxChars, gen.endTime);
      });

      generation.end(clampEnd(gen.startTime, gen.endTime));

      if (output) messages.push(output as ChatMessage);
      const toolMessage = toolResultsMessage(gen, maxChars);
      if (toolMessage) messages.push(toolMessage);
    });

    turn.orphanSubagents.forEach((run, k) => {
      emitSubagent(run, root, `sub:orphan:${k}`, start, maxChars);
    });

    turn.compactions.forEach((compaction, k) => {
      start(
        `compact:${k}`,
        "Context compaction",
        {
          metadata: {
            "cursor.trigger": compaction.trigger,
            "cursor.context_usage_percent": compaction.contextUsagePercent,
            "cursor.context_tokens": compaction.contextTokens,
            "cursor.context_window_size": compaction.contextWindowSize,
            "cursor.message_count": compaction.messageCount,
            "cursor.messages_to_compact": compaction.messagesToCompact,
            "cursor.is_first_compaction": compaction.isFirstCompaction,
          },
        },
        {
          asType: "event",
          startTime: new Date(compaction.ts),
          parentSpanContext: root.otelSpan.spanContext(),
        },
      );
    });

    root.end(clampEnd(turn.startTime, turn.endTime));
  };

  if (parent) {
    // Attached mode: trace name, session, user and tags belong to the caller.
    await emit();
  } else {
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.metadata)) {
      if (v.length <= 200) metadata[k] = v;
    }
    await propagateAttributes(
      {
        sessionId: turn.conversationId,
        traceName: TRACE_NAME,
        tags: ["cursor", ...config.tags.filter((t) => t !== "cursor")],
        ...(config.user_id || turn.userEmail ? { userId: config.user_id ?? turn.userEmail } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
      emit,
    );
  }

  debugLog(`emitted turn ${turn.turnNumber} of ${turn.conversationId} as trace ${traceId}`);
  return traceId;
}

type Starter = (
  label: string,
  name: string,
  attributes: LangfuseObservationAttributes,
  options: StartObservationOpts,
) => LangfuseObservation;

function emitToolCall(
  call: ToolCall,
  parent: LangfuseObservation,
  label: string,
  start: Starter,
  maxChars: number,
  fallbackEnd: number,
): void {
  const tool = start(
    label,
    toolName(call),
    {
      input: clipDeep(call.input, maxChars),
      output: call.output !== undefined ? clipDeep(call.output, maxChars) : undefined,
      ...toolStatus(call),
      metadata: {
        "cursor.tool_name": call.name,
        "cursor.tool_use_id": call.toolUseId,
        "cursor.duration_ms": call.durationMs,
        "cursor.cwd": call.cwd,
        "cursor.sandbox": call.sandbox,
        "cursor.mcp_server": call.mcpServer,
        "cursor.failure_type": call.failure?.failureType,
        "cursor.is_interrupt": call.failure?.isInterrupt,
        "cursor.edits": call.edits ? clipDeep(call.edits, maxChars) : undefined,
        "cursor.sources": call.sources.join(","),
      },
    },
    {
      asType: "tool",
      startTime: new Date(call.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );

  call.subagents.forEach((run, k) => {
    emitSubagent(run, tool, `${label}:sub:${k}`, start, maxChars);
  });

  const end =
    call.endTime > call.startTime
      ? call.endTime
      : call.subagents.length
        ? fallbackEnd
        : call.endTime;
  tool.end(clampEnd(call.startTime, end));
}

function emitSubagent(
  run: SubagentRun,
  parent: LangfuseObservation,
  label: string,
  start: Starter,
  maxChars: number,
): void {
  const agent = start(
    label,
    "Cursor Subagent",
    {
      input: run.task ? { role: "user", content: clipText(run.task, maxChars) } : undefined,
      output: run.summary
        ? { role: "assistant", content: clipText(run.summary, maxChars) }
        : undefined,
      ...subagentStatus(run),
      metadata: {
        "cursor.subagent_id": run.subagentId,
        "cursor.subagent_type": run.type,
        "cursor.subagent_model": run.model,
        "cursor.description": run.description,
        "cursor.status": run.status,
        "cursor.tool_call_id": run.toolCallId,
        "cursor.is_parallel_worker": run.isParallelWorker,
        "cursor.git_branch": run.gitBranch,
        "cursor.duration_ms": run.durationMs,
        "cursor.message_count": run.messageCount,
        "cursor.tool_call_count": run.toolCallCount,
        "cursor.modified_files": run.modifiedFiles,
        "cursor.agent_transcript_path": run.transcriptPath,
        "cursor.missing_stop": run.missingStop,
      },
    },
    {
      asType: "agent",
      startTime: new Date(run.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );

  const turns = run.transcriptPath ? readTranscriptTurns(run.transcriptPath) : undefined;
  if (turns && turns.length > 0) {
    const rows = turns.flatMap((t) => t.assistantRows);
    const span = Math.max(1, run.endTime - run.startTime);
    rows.forEach((row, i) => {
      // No timestamps in the transcript: spread the rows evenly over the run.
      const rowStart = run.startTime + Math.floor((span * i) / rows.length);
      const rowEnd = run.startTime + Math.floor((span * (i + 1)) / rows.length);
      const generation = start(
        `${label}:gen:${i}`,
        "LLM Subagent",
        {
          input:
            i === 0 && run.task
              ? [{ role: "user", content: clipText(run.task, maxChars) }]
              : undefined,
          output: {
            role: "assistant",
            ...(row.text ? { content: clipText(row.text, maxChars) } : {}),
            ...(row.toolUses.length > 0
              ? {
                  tool_calls: row.toolUses.map((use, j) => ({
                    id: use.id ?? `sub-${i}-${j}`,
                    type: "function",
                    function: { name: use.name, arguments: clipText(toText(use.input), maxChars) },
                  })),
                }
              : {}),
          },
          model: run.model,
          // Cursor reports no usage for subagents; explicit zeros stop Langfuse
          // from inferring tokens from the text and inflating the turn cost.
          usageDetails: { input: 0, output: 0, total: 0 },
          metadata: {
            "cursor.generation_index": i,
            "cursor.boundary_source": "transcript",
            "cursor.usage_scope": "not-reported",
          },
        },
        {
          asType: "generation",
          startTime: new Date(rowStart),
          parentSpanContext: agent.otelSpan.spanContext(),
        },
      );
      row.toolUses.forEach((use, j) => {
        const tool = start(
          `${label}:gen:${i}:tool:${j}`,
          use.name,
          {
            input: clipDeep(use.input, maxChars),
            metadata: { "cursor.tool_name": use.name, "cursor.sources": "transcript" },
          },
          {
            asType: "tool",
            startTime: new Date(rowStart),
            parentSpanContext: generation.otelSpan.spanContext(),
          },
        );
        tool.end(new Date(rowStart));
      });
      generation.end(clampEnd(rowStart, rowEnd));
    });
  }

  agent.end(clampEnd(run.startTime, run.endTime));
}
