import type { ConversationState, OpenTurn } from "./state.js";
import { selectTranscriptTurn } from "./transcript.js";
import type {
  AfterFileEditPayload,
  AgentResponsePayload,
  AgentThoughtPayload,
  Attachment,
  BeforeReadFilePayload,
  BeforeSubmitPromptPayload,
  ChatMessage,
  Compaction,
  Generation,
  HookBase,
  LoggedEvent,
  McpPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreCompactPayload,
  PreToolUsePayload,
  ShellPayload,
  StopPayload,
  SubagentRun,
  SubagentStartPayload,
  SubagentStopPayload,
  Thought,
  ToolCall,
  TranscriptTurn,
  Turn,
  TurnUsage,
} from "./types.js";
import {
  asNumber,
  asString,
  isRecord,
  modelParamsToRecord,
  toText,
  tryParseJson,
} from "./utils.js";

/**
 * Merge the hook event log of one turn with the Cursor transcript into a
 * `Turn` the tracer can emit.
 *
 * The event log is authoritative for timing, tool outputs, failures, thinking
 * blocks, subagents and token usage. The transcript is authoritative for the
 * assistant message boundaries (one generation per assistant row) and supplies
 * the conversation history. Either source may be missing: the transcript is
 * `null` in CLI mode, and a repo may register only some of the hooks.
 */

export type AssembleInput = {
  conversationId: string;
  events: LoggedEvent[];
  transcriptTurns?: TranscriptTurn[];
  transcriptPath?: string;
  openTurn?: OpenTurn;
  turnNumber: number;
  closedBy: Turn["closedBy"];
  stopPayload?: StopPayload;
  session?: ConversationState["session"];
  now: number;
  captureToolOutput: boolean;
};

type Response = { text: string; ts: number };

const eventsOf = <T extends HookBase>(events: LoggedEvent[], name: string) =>
  events.filter((e) => e.event === name) as Array<LoggedEvent & { payload: T }>;

function pickBase(events: LoggedEvent[], stopPayload?: StopPayload): HookBase | undefined {
  if (stopPayload) return stopPayload;
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]!.payload;
    if (p.conversation_id || p.model) return p;
  }
  return events[events.length - 1]?.payload;
}

function inputPath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return asString(input.path) ?? asString(input.file_path) ?? asString(input.filePath);
}

function inputCommand(input: unknown): string | undefined {
  return isRecord(input) ? asString(input.command) : undefined;
}

function isMcpToolName(name: string): boolean {
  return /^mcp[:_]/i.test(name);
}

/**
 * Cursor names the same MCP tool differently per surface: `MCP:create_note`
 * in the tool hooks, `mcp_notes_create_note` in the transcript, `create_note`
 * in the MCP hooks. Strip the `mcp` prefix and compare on the tool part.
 */
function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp[:_.-]+/, "")
    .replace(/[:.\-\s]+/g, "_");
}

export function nameMatchesTool(callName: string, toolName: string): boolean {
  const a = normalizeToolName(callName);
  const b = normalizeToolName(toolName);
  if (!a || !b) return false;
  return a === b || a.endsWith(`_${b}`) || b.endsWith(`_${a}`);
}

function buildToolCalls(events: LoggedEvent[], captureToolOutput: boolean): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();

  const findOpenByName = (name: string | undefined): ToolCall | undefined =>
    calls.find(
      (c) => !c.toolUseId && c.endTime === c.startTime && (name === undefined || c.name === name),
    );

  for (const e of eventsOf<PreToolUsePayload>(events, "preToolUse")) {
    const call: ToolCall = {
      toolUseId: asString(e.payload.tool_use_id),
      name: asString(e.payload.tool_name) ?? "tool",
      input: e.payload.tool_input,
      startTime: e.ts,
      endTime: e.ts,
      cwd: asString(e.payload.cwd),
      sources: ["preToolUse"],
      subagents: [],
    };
    calls.push(call);
    if (call.toolUseId) byId.set(call.toolUseId, call);
  }

  const closeCall = (
    e: LoggedEvent & { payload: PostToolUsePayload | PostToolUseFailurePayload },
    source: string,
  ): ToolCall => {
    const id = asString(e.payload.tool_use_id);
    const name = asString(e.payload.tool_name) ?? "tool";
    let call = (id && byId.get(id)) || undefined;
    if (!call) call = findOpenByName(name);
    if (!call) {
      // post without pre (hook added mid-turn, or the pre hook failed): synthesize.
      const duration = asNumber(e.payload.duration) ?? 0;
      call = {
        toolUseId: id,
        name,
        input: e.payload.tool_input,
        startTime: e.ts - duration,
        endTime: e.ts,
        cwd: asString(e.payload.cwd),
        sources: [],
        subagents: [],
      };
      calls.push(call);
      if (id) byId.set(id, call);
    }
    call.sources.push(source);
    call.endTime = Math.max(e.ts, call.startTime);
    call.durationMs = asNumber(e.payload.duration) ?? call.durationMs;
    if (call.input === undefined) call.input = e.payload.tool_input;
    return call;
  };

  for (const e of eventsOf<PostToolUsePayload>(events, "postToolUse")) {
    const call = closeCall(e, "postToolUse");
    if (captureToolOutput && e.payload.tool_output !== undefined) {
      call.output = tryParseJson(e.payload.tool_output);
    }
  }

  for (const e of eventsOf<PostToolUseFailurePayload>(events, "postToolUseFailure")) {
    const call = closeCall(e, "postToolUseFailure");
    call.failure = {
      message: asString(e.payload.error_message),
      failureType: asString(e.payload.failure_type),
      isInterrupt: e.payload.is_interrupt === true,
    };
  }

  // A pre without post that is still open: give it a zero-length span for now;
  // the caller extends it to the turn end for interrupted turns.

  const shellBefore = eventsOf<ShellPayload>(events, "beforeShellExecution");
  const shellAfter = eventsOf<ShellPayload>(events, "afterShellExecution");
  const shellCalls = new Map<string, ToolCall[]>(); // command -> synthesized calls
  for (const e of shellBefore) {
    const command = asString(e.payload.command) ?? "";
    const existing = calls.find(
      (c) =>
        !c.sources.includes("beforeShellExecution") &&
        inputCommand(c.input) === command &&
        Math.abs(c.startTime - e.ts) < 30_000,
    );
    const call: ToolCall = existing ?? {
      name: "Shell",
      input: { command, ...(e.payload.cwd ? { cwd: e.payload.cwd } : {}) },
      startTime: e.ts,
      endTime: e.ts,
      cwd: asString(e.payload.cwd),
      sources: [],
      subagents: [],
    };
    if (!existing) calls.push(call);
    call.sources.push("beforeShellExecution");
    if (typeof e.payload.sandbox === "boolean") call.sandbox = e.payload.sandbox;
    const list = shellCalls.get(command) ?? [];
    list.push(call);
    shellCalls.set(command, list);
  }
  for (const e of shellAfter) {
    const command = asString(e.payload.command) ?? "";
    const list = shellCalls.get(command);
    let call = list?.find((c) => !c.sources.includes("afterShellExecution"));
    if (!call) {
      call = calls.find(
        (c) =>
          !c.sources.includes("afterShellExecution") &&
          inputCommand(c.input) === command &&
          Math.abs(c.startTime - e.ts) < 300_000,
      );
    }
    if (!call) {
      const duration = asNumber(e.payload.duration) ?? 0;
      call = {
        name: "Shell",
        input: { command },
        startTime: e.ts - duration,
        endTime: e.ts,
        sources: [],
        subagents: [],
      };
      calls.push(call);
    }
    call.sources.push("afterShellExecution");
    call.endTime = Math.max(call.endTime, e.ts);
    call.durationMs = asNumber(e.payload.duration) ?? call.durationMs;
    if (typeof e.payload.sandbox === "boolean") call.sandbox = e.payload.sandbox;
    if (captureToolOutput && call.output === undefined && e.payload.output !== undefined) {
      call.output = e.payload.output;
    }
  }

  const mcpBefore = eventsOf<McpPayload>(events, "beforeMCPExecution");
  const mcpAfter = eventsOf<McpPayload>(events, "afterMCPExecution");
  const mcpOpen: ToolCall[] = [];
  for (const e of mcpBefore) {
    const toolName = asString(e.payload.tool_name) ?? "tool";
    const existing = calls.find(
      (c) =>
        !c.sources.includes("beforeMCPExecution") &&
        (nameMatchesTool(c.name, toolName) || isMcpToolName(c.name)) &&
        Math.abs(c.startTime - e.ts) < 30_000,
    );
    const call: ToolCall = existing ?? {
      name: toolName,
      input: tryParseJson(e.payload.tool_input),
      startTime: e.ts,
      endTime: e.ts,
      sources: [],
      subagents: [],
    };
    if (!existing) calls.push(call);
    call.sources.push("beforeMCPExecution");
    call.mcpServer = asString(e.payload.mcp_server_name) ?? call.mcpServer;
    if (call.input === undefined) call.input = tryParseJson(e.payload.tool_input);
    mcpOpen.push(call);
  }
  for (const e of mcpAfter) {
    const toolName = asString(e.payload.tool_name) ?? "tool";
    let call = mcpOpen.find(
      (c) => !c.sources.includes("afterMCPExecution") && nameMatchesTool(c.name, toolName),
    );
    if (!call) {
      call = calls.find(
        (c) => !c.sources.includes("afterMCPExecution") && nameMatchesTool(c.name, toolName),
      );
    }
    if (!call) {
      const duration = asNumber(e.payload.duration) ?? 0;
      call = {
        name: toolName,
        input: tryParseJson(e.payload.tool_input),
        startTime: e.ts - duration,
        endTime: e.ts,
        sources: [],
        subagents: [],
      };
      calls.push(call);
    }
    call.sources.push("afterMCPExecution");
    call.mcpServer = asString(e.payload.mcp_server_name) ?? call.mcpServer;
    call.endTime = Math.max(call.endTime, e.ts);
    call.durationMs = asNumber(e.payload.duration) ?? call.durationMs;
    if (captureToolOutput && call.output === undefined && e.payload.result_json !== undefined) {
      call.output = tryParseJson(e.payload.result_json);
    }
  }

  for (const e of eventsOf<AfterFileEditPayload>(events, "afterFileEdit")) {
    const file = asString(e.payload.file_path);
    const call = calls.find(
      (c) =>
        c.edits === undefined &&
        inputPath(c.input) === file &&
        /write|replace|edit/i.test(c.name) &&
        Math.abs(c.endTime - e.ts) < 30_000,
    );
    if (call) {
      call.edits = e.payload.edits;
      call.sources.push("afterFileEdit");
      call.endTime = Math.max(call.endTime, e.ts);
    } else {
      calls.push({
        name: "Edit",
        input: { file_path: file, edits: e.payload.edits },
        startTime: e.ts,
        endTime: e.ts,
        edits: e.payload.edits,
        sources: ["afterFileEdit"],
        subagents: [],
      });
    }
  }

  const hasGenericHooks = calls.some((c) => c.sources.includes("preToolUse"));
  if (!hasGenericHooks) {
    for (const e of eventsOf<BeforeReadFilePayload>(events, "beforeReadFile")) {
      calls.push({
        name: "Read",
        input: {
          file_path: e.payload.file_path,
          ...(e.payload.content !== undefined ? { content: e.payload.content } : {}),
          ...(e.payload.content_length !== undefined
            ? { content_length: e.payload.content_length }
            : {}),
        },
        startTime: e.ts,
        endTime: e.ts,
        sources: ["beforeReadFile"],
        subagents: [],
      });
    }
  }

  return calls.sort((a, b) => a.startTime - b.startTime);
}

function buildSubagents(events: LoggedEvent[]): SubagentRun[] {
  const runs: SubagentRun[] = [];
  const open = new Map<string, SubagentRun>();
  for (const e of eventsOf<SubagentStartPayload>(events, "subagentStart")) {
    const run: SubagentRun = {
      subagentId: asString(e.payload.subagent_id),
      type: asString(e.payload.subagent_type),
      model: asString(e.payload.subagent_model),
      task: asString(e.payload.task),
      toolCallId: asString(e.payload.tool_call_id),
      isParallelWorker: e.payload.is_parallel_worker === true,
      gitBranch: asString(e.payload.git_branch),
      startTime: e.ts,
      endTime: e.ts,
      missingStop: true,
    };
    runs.push(run);
    if (run.subagentId) open.set(run.subagentId, run);
  }
  for (const e of eventsOf<SubagentStopPayload>(events, "subagentStop")) {
    const id = asString(e.payload.subagent_id);
    let run = (id && open.get(id)) || undefined;
    if (!run) {
      run = runs.find(
        (r) =>
          r.missingStop &&
          (!e.payload.task || !r.task || r.task === e.payload.task) &&
          (!e.payload.subagent_type || !r.type || r.type === e.payload.subagent_type),
      );
    }
    const duration = asNumber(e.payload.duration_ms);
    if (!run) {
      run = {
        subagentId: id,
        startTime: duration !== undefined ? e.ts - duration : e.ts,
        endTime: e.ts,
        missingStop: false,
      };
      runs.push(run);
    }
    run.missingStop = false;
    run.endTime = Math.max(e.ts, run.startTime);
    run.type = run.type ?? asString(e.payload.subagent_type);
    run.task = run.task ?? asString(e.payload.task);
    run.description = asString(e.payload.description);
    run.summary = asString(e.payload.summary);
    run.status = asString(e.payload.status);
    run.durationMs = duration;
    run.messageCount = asNumber(e.payload.message_count);
    run.toolCallCount = asNumber(e.payload.tool_call_count);
    run.modifiedFiles = Array.isArray(e.payload.modified_files)
      ? e.payload.modified_files.map(String)
      : undefined;
    run.transcriptPath = asString(e.payload.agent_transcript_path);
  }
  return runs;
}

function attachSubagents(calls: ToolCall[], runs: SubagentRun[]): SubagentRun[] {
  const orphans: SubagentRun[] = [];
  for (const run of runs) {
    let call = run.toolCallId ? calls.find((c) => c.toolUseId === run.toolCallId) : undefined;
    if (!call) {
      call = calls.find(
        (c) =>
          /^task$/i.test(c.name) &&
          c.subagents.length === 0 &&
          c.startTime <= run.startTime + 1_000 &&
          (c.endTime === c.startTime || c.endTime + 1_000 >= run.startTime),
      );
    }
    if (call) {
      call.subagents.push(run);
      call.endTime = Math.max(call.endTime, run.endTime);
    } else {
      orphans.push(run);
    }
  }
  return orphans;
}

function assignByWindow<T extends { ts?: number; startTime?: number }>(
  items: T[],
  generations: Generation[],
  pick: (gen: Generation, item: T) => void,
): void {
  for (const item of items) {
    const t = item.ts ?? item.startTime ?? 0;
    let target = generations.find((g) => t <= g.endTime);
    if (!target) target = generations[generations.length - 1];
    if (target) pick(target, item);
  }
}

function buildGenerationsFromTranscript(
  transcriptTurn: TranscriptTurn,
  calls: ToolCall[],
  thoughts: Thought[],
  responses: Response[],
  turnStart: number,
  turnEnd: number,
): Generation[] {
  const rows = transcriptTurn.assistantRows;
  const generations: Generation[] = rows.map((row) => ({
    startTime: turnStart,
    endTime: turnEnd,
    text: row.text || undefined,
    thoughts: [],
    toolCalls: [],
    otherBlocks: row.otherBlocks,
    source: "transcript" as const,
  }));

  const unassigned = [...calls];
  rows.forEach((row, i) => {
    for (const use of row.toolUses) {
      const idx = unassigned.findIndex((c) => nameMatchesTool(c.name, use.name));
      if (idx >= 0) {
        generations[i]!.toolCalls.push(unassigned.splice(idx, 1)[0]!);
      } else {
        // Observed in the transcript but no hook fired for it (hook not registered).
        generations[i]!.toolCalls.push({
          name: use.name,
          input: use.input,
          startTime: turnStart,
          endTime: turnStart,
          sources: ["transcript"],
          subagents: [],
        });
      }
    }
  });

  // Boundaries: one afterAgentResponse per assistant row when the counts line up,
  // otherwise the end of the last tool call in the row.
  const alignedResponses = responses.length === rows.length;
  for (let i = 0; i < generations.length; i++) {
    const gen = generations[i]!;
    gen.startTime = i === 0 ? turnStart : generations[i - 1]!.endTime;
    const toolEnd = gen.toolCalls.reduce((m, c) => Math.max(m, c.endTime), gen.startTime);
    const responseEnd = alignedResponses ? responses[i]!.ts : undefined;
    gen.endTime =
      i === generations.length - 1
        ? Math.max(turnEnd, toolEnd)
        : Math.max(gen.startTime, responseEnd ?? toolEnd);
    if (alignedResponses && !gen.text) gen.text = responses[i]!.text;
    for (const call of gen.toolCalls) {
      if (call.sources.includes("transcript")) {
        call.startTime = gen.startTime;
        call.endTime = gen.startTime;
      }
    }
  }

  assignByWindow(unassigned, generations, (gen, call) => gen.toolCalls.push(call));
  assignByWindow(thoughts, generations, (gen, thought) => gen.thoughts.push(thought));
  return generations;
}

function buildGenerationsFromEvents(
  calls: ToolCall[],
  thoughts: Thought[],
  responses: Response[],
  turnStart: number,
  turnEnd: number,
): Generation[] {
  const generations: Generation[] = [];
  let cursor = turnStart;
  for (const response of responses) {
    generations.push({
      startTime: cursor,
      endTime: Math.max(response.ts, cursor),
      text: response.text,
      thoughts: [],
      toolCalls: [],
      otherBlocks: [],
      source: "events",
    });
    cursor = Math.max(response.ts, cursor);
  }
  const trailingCalls = calls.filter((c) => c.startTime >= cursor);
  const trailingThoughts = thoughts.filter((t) => t.ts >= cursor);
  if (trailingCalls.length > 0 || trailingThoughts.length > 0 || generations.length === 0) {
    if (trailingCalls.length > 0 || trailingThoughts.length > 0 || calls.length > 0) {
      generations.push({
        startTime: cursor,
        endTime: Math.max(turnEnd, cursor),
        thoughts: [],
        toolCalls: [],
        otherBlocks: [],
        source: "events",
      });
    }
  }
  if (generations.length > 0) {
    generations[generations.length - 1]!.endTime = Math.max(
      generations[generations.length - 1]!.endTime,
      turnEnd,
    );
  }
  assignByWindow(calls, generations, (gen, call) => gen.toolCalls.push(call));
  assignByWindow(thoughts, generations, (gen, thought) => gen.thoughts.push(thought));
  return generations;
}

function usageFromStop(stop: StopPayload | undefined): TurnUsage | undefined {
  if (!stop) return undefined;
  const input = asNumber(stop.input_tokens);
  const output = asNumber(stop.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: asNumber(stop.cache_read_tokens) ?? 0,
    cacheWriteTokens: asNumber(stop.cache_write_tokens) ?? 0,
  };
}

export function historyFromTranscript(turns: TranscriptTurn[], upTo: number): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < upTo && i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.userText) history.push({ role: "user", content: turn.userText });
    for (const row of turn.assistantRows) {
      const message: ChatMessage = { role: "assistant" };
      if (row.text) message.content = row.text;
      if (row.toolUses.length > 0) {
        message.tool_calls = row.toolUses.map((use, j) => ({
          id: use.id ?? `transcript-${i}-${j}`,
          type: "function",
          function: { name: use.name, arguments: toText(use.input) },
        }));
      }
      if (message.content !== undefined || message.tool_calls) history.push(message);
    }
  }
  return history;
}

export function assembleTurn(input: AssembleInput): Turn {
  const { events, stopPayload } = input;
  const base = pickBase(events, stopPayload);

  const prompts = eventsOf<BeforeSubmitPromptPayload>(events, "beforeSubmitPrompt");
  const promptEvent = prompts[prompts.length - 1];
  const stopEvent = eventsOf<StopPayload>(events, "stop").pop();

  const firstTs = events[0]?.ts;
  const lastTs = events[events.length - 1]?.ts;
  const startTime = input.openTurn?.startedAt ?? promptEvent?.ts ?? firstTs ?? input.now;
  const endTime = Math.max(startTime, stopEvent?.ts ?? lastTs ?? input.now);

  const calls = buildToolCalls(events, input.captureToolOutput);
  for (const call of calls) {
    if (call.endTime === call.startTime && !call.sources.some((s) => s.startsWith("post"))) {
      if (call.sources.includes("preToolUse") && call.sources.length === 1) call.endTime = endTime;
    }
  }
  const orphanSubagents = attachSubagents(calls, buildSubagents(events));

  const thoughts: Thought[] = eventsOf<AgentThoughtPayload>(events, "afterAgentThought")
    .filter((e) => typeof e.payload.text === "string" && e.payload.text.length > 0)
    .map((e) => ({ text: e.payload.text!, durationMs: asNumber(e.payload.duration_ms), ts: e.ts }));
  const responses: Response[] = eventsOf<AgentResponsePayload>(events, "afterAgentResponse")
    .filter((e) => typeof e.payload.text === "string")
    .map((e) => ({ text: e.payload.text!, ts: e.ts }));

  const prompt = asString(promptEvent?.payload.prompt);
  let transcriptTurn: TranscriptTurn | undefined;
  let history: ChatMessage[] = [];
  if (input.transcriptTurns && input.transcriptTurns.length > 0) {
    const selected = selectTranscriptTurn(input.transcriptTurns, input.turnNumber, prompt);
    if (selected) {
      transcriptTurn = selected.turn;
      history = historyFromTranscript(input.transcriptTurns, selected.index);
    }
  }

  const generations =
    transcriptTurn && transcriptTurn.assistantRows.length > 0
      ? buildGenerationsFromTranscript(
          transcriptTurn,
          calls,
          thoughts,
          responses,
          startTime,
          endTime,
        )
      : buildGenerationsFromEvents(calls, thoughts, responses, startTime, endTime);

  const lastRowText = transcriptTurn?.assistantRows
    .map((r) => r.text)
    .filter(Boolean)
    .pop();
  const finalText = responses[responses.length - 1]?.text ?? lastRowText;

  let status: Turn["status"] = "unknown";
  if (input.closedBy === "stop") {
    const s = asString(stopPayload?.status);
    status = s === "completed" || s === "aborted" || s === "error" ? s : "unknown";
  } else if (input.closedBy === "sessionEnd" || input.closedBy === "beforeSubmitPrompt") {
    status = "interrupted";
  }

  const compactions: Compaction[] = eventsOf<PreCompactPayload>(events, "preCompact").map((e) => ({
    ts: e.ts,
    trigger: asString(e.payload.trigger),
    contextUsagePercent: asNumber(e.payload.context_usage_percent),
    contextTokens: asNumber(e.payload.context_tokens),
    contextWindowSize: asNumber(e.payload.context_window_size),
    messageCount: asNumber(e.payload.message_count),
    messagesToCompact: asNumber(e.payload.messages_to_compact),
    isFirstCompaction: e.payload.is_first_compaction === true,
  }));

  const eventCounts: Record<string, number> = {};
  for (const e of events) eventCounts[e.event] = (eventCounts[e.event] ?? 0) + 1;

  const attachments = Array.isArray(promptEvent?.payload.attachments)
    ? (promptEvent!.payload.attachments as Attachment[])
    : undefined;

  return {
    conversationId: input.conversationId,
    generationId:
      asString(stopPayload?.generation_id) ?? asString(promptEvent?.payload.generation_id),
    turnNumber: input.turnNumber,
    startTime,
    endTime,
    prompt: prompt ?? transcriptTurn?.userText ?? undefined,
    attachments,
    finalText,
    status,
    closedBy: input.closedBy,
    loopCount: asNumber(stopPayload?.loop_count),
    model: asString(base?.model),
    modelId: asString(base?.model_id),
    modelParams: modelParamsToRecord(base?.model_params),
    generations,
    orphanSubagents,
    compactions,
    usage: usageFromStop(stopPayload),
    history,
    cursorVersion: asString(base?.cursor_version),
    workspaceRoots: Array.isArray(base?.workspace_roots)
      ? base!.workspace_roots!.map(String)
      : undefined,
    userEmail: asString(base?.user_email),
    transcriptPath: input.transcriptPath,
    transcriptUsed: transcriptTurn !== undefined,
    composerMode: input.session?.composerMode,
    isBackgroundAgent: input.session?.isBackgroundAgent,
    eventCounts,
  };
}
