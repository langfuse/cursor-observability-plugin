import { assembleTurn } from "./assemble.js";
import type { Config } from "./config.js";
import { setupInstrumentation } from "./instrumentation.js";
import type { ConversationState, ConversationStore } from "./state.js";
import { emitTurn } from "./trace.js";
import { readTranscriptTurnsSettled } from "./transcript.js";
import type { StopPayload, Turn } from "./types.js";
import { asString, debugLog, guessTranscriptPath } from "./utils.js";

/**
 * The slow path: assemble the turn in flight and upload it to Langfuse.
 *
 * Loaded on demand (dynamic import) so the per-event fast path never pays for
 * the Langfuse SDK and OpenTelemetry.
 */
export type ExportParams = {
  config: Config;
  store: ConversationStore;
  state: ConversationState;
  turnNumber: number;
  closedBy: Turn["closedBy"];
  stopPayload?: StopPayload;
  now: number;
  home: string;
  workspaceRoot?: string;
};

export type ExportResult = { traceId?: string; eventCount: number; turn?: Turn };

export async function exportTurn(params: ExportParams): Promise<ExportResult> {
  const { config, store, state } = params;
  const events = store.readEvents();
  if (events.length === 0 && params.closedBy !== "stop") {
    debugLog("nothing to export: no events for the open turn");
    return { eventCount: 0 };
  }

  const transcriptPath =
    asString(params.stopPayload?.transcript_path) ??
    [...events]
      .reverse()
      .map((e) => asString(e.payload.transcript_path))
      .find(Boolean) ??
    guessTranscriptPath(params.home, params.workspaceRoot, store.conversationId);

  const transcriptTurns = transcriptPath
    ? await readTranscriptTurnsSettled(transcriptPath)
    : undefined;
  if (transcriptPath && !transcriptTurns) debugLog(`transcript not readable: ${transcriptPath}`);

  const turn = assembleTurn({
    conversationId: store.conversationId,
    events,
    transcriptTurns,
    transcriptPath,
    openTurn: state.openTurn,
    turnNumber: params.turnNumber,
    closedBy: params.closedBy,
    stopPayload: params.stopPayload,
    session: state.session,
    now: params.now,
    captureToolOutput: config.capture_tool_output,
  });

  const instrumentation = setupInstrumentation(config);
  let traceId: string | undefined;
  try {
    traceId = await emitTurn(turn, { config, ids: instrumentation.ids });
  } finally {
    await instrumentation.shutdown();
  }
  return { traceId, eventCount: events.length, turn };
}
