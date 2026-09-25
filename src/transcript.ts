import * as fs from "node:fs";

import type {
  TranscriptAssistantRow,
  TranscriptBlock,
  TranscriptOtherBlock,
  TranscriptRow,
  TranscriptToolUse,
  TranscriptTurn,
} from "./types.js";
import { isRecord } from "./utils.js";

/**
 * Cursor transcript reader.
 *
 * Cursor writes one JSON object per line to
 * `~/.cursor/projects/<project>/agent-transcripts/<id>[/<id>].jsonl`:
 *
 *   {"role":"user","message":{"content":[{"type":"text","text":"<timestamp>…</timestamp>\n<user_query>\nls\n</user_query>"}]}}
 *   {"role":"assistant","message":{"content":[{"type":"text","text":"…"},{"type":"tool_use","name":"Shell","input":{…}}]}}
 *   {"type":"turn_ended","status":"success"}
 *
 * The file carries no timestamps, no tool results, no token usage and no
 * message ids. The hook event log supplies those; the transcript supplies the
 * exact assistant message boundaries and the conversation history.
 */

export function parseTranscriptRows(data: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) rows.push(parsed as TranscriptRow);
    } catch {
      // skip malformed lines rather than losing the whole transcript
    }
  }
  return rows;
}

const TIMESTAMP_RE = /^\s*<timestamp>([\s\S]*?)<\/timestamp>\s*/;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

export function cleanUserText(raw: string): { text: string; timestamp?: string } {
  let text = raw;
  let timestamp: string | undefined;
  const ts = TIMESTAMP_RE.exec(text);
  if (ts) {
    timestamp = ts[1]?.trim();
    text = text.slice(ts[0].length);
  }
  const query = USER_QUERY_RE.exec(text);
  if (query) text = query[1] ?? "";
  return { text: text.trim(), timestamp };
}

function rowRole(row: TranscriptRow): string | undefined {
  if ("role" in row && typeof row.role === "string") return row.role;
  if ("type" in row && (row.type === "user" || row.type === "assistant")) return row.type;
  return undefined;
}

function rowBlocks(row: TranscriptRow): TranscriptBlock[] {
  const message = (row as { message?: unknown }).message;
  if (isRecord(message)) {
    const content = message.content;
    if (Array.isArray(content)) return content.filter(isRecord) as TranscriptBlock[];
    if (typeof content === "string") return [{ type: "text", text: content }];
  }
  // Minimal rows seen in some tooling fixtures: {"type":"user","text":"…"}
  const text = (row as { text?: unknown }).text;
  if (typeof text === "string") return [{ type: "text", text }];
  return [];
}

function toAssistantRow(blocks: TranscriptBlock[]): TranscriptAssistantRow {
  const texts: string[] = [];
  const toolUses: TranscriptToolUse[] = [];
  const otherBlocks: TranscriptOtherBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) texts.push(text);
    } else if (block.type === "tool_use") {
      const b = block as { name?: unknown; input?: unknown; id?: unknown };
      toolUses.push({
        name: typeof b.name === "string" ? b.name : "tool",
        input: b.input,
        ...(typeof b.id === "string" ? { id: b.id } : {}),
      });
    } else {
      otherBlocks.push(block as TranscriptOtherBlock);
    }
  }
  return { text: texts.join("\n"), toolUses, otherBlocks };
}

export function splitTranscriptTurns(rows: TranscriptRow[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | undefined;

  for (const row of rows) {
    const type = (row as { type?: unknown }).type;
    if (type === "turn_ended") {
      if (current) {
        current.endedStatus =
          typeof (row as { status?: unknown }).status === "string"
            ? ((row as { status: string }).status as string)
            : "unknown";
        turns.push(current);
        current = undefined;
      }
      continue;
    }
    const role = rowRole(row);
    if (role === "user") {
      if (current) turns.push(current);
      const blocks = rowBlocks(row);
      const text = blocks
        .map((b) => (b.type === "text" ? ((b as { text?: string }).text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      const cleaned = cleanUserText(text);
      current = {
        userText: cleaned.text,
        ...(cleaned.timestamp ? { userTimestamp: cleaned.timestamp } : {}),
        assistantRows: [],
      };
      continue;
    }
    if (role === "assistant") {
      if (!current) {
        // Assistant row without a preceding user row (transcript truncated
        // or resumed): open a turn with an empty prompt so nothing is lost.
        current = { userText: "", assistantRows: [] };
      }
      current.assistantRows.push(toAssistantRow(rowBlocks(row)));
    }
  }
  if (current) turns.push(current);
  return turns;
}

export function readTranscriptTurns(file: string): TranscriptTurn[] | undefined {
  try {
    return splitTranscriptTurns(parseTranscriptRows(fs.readFileSync(file, "utf-8")));
  } catch {
    return undefined;
  }
}

/**
 * Read the transcript, waiting briefly for Cursor to flush the current turn.
 * Cursor fires `stop` before the transcript is guaranteed to be complete, so
 * we retry until the last turn carries `turn_ended` or the budget is spent.
 */
export async function readTranscriptTurnsSettled(
  file: string,
  options: { budgetMs?: number; intervalMs?: number } = {},
): Promise<TranscriptTurn[] | undefined> {
  const budgetMs = options.budgetMs ?? 1_500;
  const intervalMs = options.intervalMs ?? 150;
  const deadline = Date.now() + budgetMs;
  let turns = readTranscriptTurns(file);
  while (Date.now() < deadline) {
    const last = turns?.[turns.length - 1];
    if (last?.endedStatus !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    turns = readTranscriptTurns(file);
  }
  return turns;
}

/**
 * Pick the transcript turn that corresponds to the turn being exported.
 * Prefers a prompt match (the transcript may have started before the plugin
 * was installed), falls back to the turn number, then to the last turn.
 */
export function selectTranscriptTurn(
  turns: TranscriptTurn[],
  turnNumber: number,
  prompt: string | undefined,
): { turn: TranscriptTurn; index: number } | undefined {
  if (turns.length === 0) return undefined;
  if (prompt) {
    const wanted = prompt.trim();
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.userText.trim() === wanted) return { turn: turns[i]!, index: i };
    }
  }
  if (turnNumber >= 1 && turnNumber <= turns.length && turns.length >= turnNumber) {
    // Only trust the positional match when the transcript is at least as long
    // as our turn counter; otherwise the transcript started later than we did.
    const index = turnNumber - 1;
    if (!prompt) return { turn: turns[index]!, index };
  }
  const index = turns.length - 1;
  return { turn: turns[index]!, index };
}
