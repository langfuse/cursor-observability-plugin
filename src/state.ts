import * as fs from "node:fs";
import * as path from "node:path";

import type { HookBase, LoggedEvent } from "./types.js";
import { clipDeep, debugLog } from "./utils.js";

/**
 * Per-conversation state kept between hook invocations.
 *
 * Cursor runs every hook as a fresh process, so the plugin keeps two files per
 * conversation under `<state_dir>/conversations/<conversation_id>/`:
 *
 * - `events.jsonl`: the hooks observed for the turn currently in flight, one
 *   JSON line each. Appended by the fast path, consumed and truncated when the
 *   turn is exported.
 * - `state.json`: turn counter, the open turn, session metadata and the trace
 *   ids already exported, so re-fired `stop` hooks stay idempotent.
 */
export type OpenTurn = {
  turnNumber: number;
  startedAt: number;
  generationId?: string;
};

export type ConversationState = {
  conversationId: string;
  turnsCompleted: number;
  openTurn?: OpenTurn;
  session?: {
    composerMode?: string;
    isBackgroundAgent?: boolean;
    startedAt?: number;
  };
  exportedTraceIds: string[];
  updatedAt: number;
};

const MAX_EXPORTED_IDS = 200;

export class ConversationStore {
  readonly dir: string;
  readonly eventsFile: string;
  readonly stateFile: string;

  constructor(
    readonly stateDir: string,
    readonly conversationId: string,
  ) {
    // The id comes from Cursor; keep it filesystem-safe anyway.
    const safeId = conversationId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
    this.dir = path.join(stateDir, "conversations", safeId);
    this.eventsFile = path.join(this.dir, "events.jsonl");
    this.stateFile = path.join(this.dir, "state.json");
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  readState(): ConversationState {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.stateFile, "utf-8"),
      ) as Partial<ConversationState>;
      return {
        conversationId: this.conversationId,
        turnsCompleted: typeof raw.turnsCompleted === "number" ? raw.turnsCompleted : 0,
        openTurn: raw.openTurn,
        session: raw.session,
        exportedTraceIds: Array.isArray(raw.exportedTraceIds) ? raw.exportedTraceIds : [],
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      };
    } catch {
      return {
        conversationId: this.conversationId,
        turnsCompleted: 0,
        exportedTraceIds: [],
        updatedAt: 0,
      };
    }
  }

  writeState(state: ConversationState): void {
    this.ensureDir();
    state.updatedAt = Date.now();
    if (state.exportedTraceIds.length > MAX_EXPORTED_IDS) {
      state.exportedTraceIds = state.exportedTraceIds.slice(-MAX_EXPORTED_IDS);
    }
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs.renameSync(tmp, this.stateFile);
  }

  /**
   * Append one hook event. Strings are clipped so a single line stays small
   * enough that concurrent appends (parallel tool calls) do not interleave.
   */
  appendEvent(payload: HookBase, maxChars: number, ts = Date.now()): void {
    this.ensureDir();
    const event: LoggedEvent = {
      ts,
      event: payload.hook_event_name,
      payload: clipDeep(payload, maxChars),
    };
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
  }

  readEvents(): LoggedEvent[] {
    let data: string;
    try {
      data = fs.readFileSync(this.eventsFile, "utf-8");
    } catch {
      return [];
    }
    const events: LoggedEvent[] = [];
    for (const line of data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as LoggedEvent;
        if (parsed && typeof parsed.ts === "number" && typeof parsed.event === "string") {
          events.push(parsed);
        }
      } catch {
        debugLog("skipping malformed event line");
      }
    }
    // Stable sort by observation time; appends are already ordered in practice.
    return events.sort((a, b) => a.ts - b.ts);
  }

  clearEvents(keepFrom?: number): void {
    if (keepFrom === undefined) {
      fs.rmSync(this.eventsFile, { force: true });
      return;
    }
    const remaining = this.readEvents().filter((e) => e.ts >= keepFrom);
    fs.rmSync(this.eventsFile, { force: true });
    for (const event of remaining) {
      fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`, "utf-8");
    }
  }

  /**
   * Best-effort exclusive lock for the export path. Times out instead of
   * failing so a stale lock never drops a turn; the caller logs the timeout.
   */
  async withLock<T>(fn: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
    this.ensureDir();
    const lockDir = path.join(this.dir, ".lock");
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(lockDir);
        acquired = true;
        break;
      } catch {
        // A lock older than 60s is stale (crashed hook); take it over.
        try {
          const age = Date.now() - fs.statSync(lockDir).mtimeMs;
          if (age > 60_000) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock vanished between attempts
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!acquired) debugLog("export lock timeout; proceeding without lock");
    try {
      return await fn();
    } finally {
      if (acquired) fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}
