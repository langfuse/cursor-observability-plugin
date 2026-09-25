import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cleanUserText,
  parseTranscriptRows,
  readTranscriptTurnsSettled,
  selectTranscriptTurn,
  splitTranscriptTurns,
} from "../src/transcript.js";
import { cleanTmpDirs, makeTmpDir, transcriptRows } from "./helpers.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/transcript-real-session.jsonl",
);

describe("cleanUserText", () => {
  it("strips the timestamp prefix and the user_query wrapper", () => {
    const { text, timestamp } = cleanUserText(
      "<timestamp>Monday, Aug 24, 2026, 3:01 PM (UTC-5)</timestamp>\n<user_query>\nls\n</user_query>",
    );
    expect(text).toBe("ls");
    expect(timestamp).toBe("Monday, Aug 24, 2026, 3:01 PM (UTC-5)");
  });

  it("leaves plain prompts and embedded tags alone", () => {
    expect(cleanUserText("hello world").text).toBe("hello world");
    expect(
      cleanUserText("<user_query>\nkeep <timestamp>x</timestamp> inside\n</user_query>").text,
    ).toBe("keep <timestamp>x</timestamp> inside");
  });
});

describe("splitTranscriptTurns on a real Cursor session", () => {
  const turns = splitTranscriptTurns(parseTranscriptRows(fs.readFileSync(fixture, "utf-8")));

  it("yields one turn ended by turn_ended", () => {
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe("ls");
    expect(turns[0]!.endedStatus).toBe("success");
  });

  it("keeps one assistant row per model response with its tool_use blocks", () => {
    const rows = turns[0]!.assistantRows;
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.toolUses.map((t) => t.name).join(","))).toEqual([
      "Shell",
      "Write",
      "Read",
      "StrReplace",
      "Glob",
      "Grep",
      "Shell",
    ]);
    expect(rows[1]!.toolUses[0]!.input).toMatchObject({ path: "/tmp/cursor-probe/notes.md" });
    expect(rows[0]!.text).toContain("Creating the scratch repo");
  });
});

describe("splitTranscriptTurns edge cases", () => {
  it("splits consecutive turns without turn_ended markers on the next user row", () => {
    const data = [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\\none\\n</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"1"}]}}',
      '{"role":"user","message":{"content":"two"}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"2"}]}}',
    ].join("\n");
    const turns = splitTranscriptTurns(parseTranscriptRows(data));
    expect(turns.map((t) => t.userText)).toEqual(["one", "two"]);
    expect(turns[0]!.endedStatus).toBeUndefined();
  });

  it("tolerates malformed lines and minimal {type,text} rows", () => {
    const data = [
      "not json",
      '{"type":"user","text":"hi"}',
      '{"type":"assistant","text":"hello"}',
    ].join("\n");
    const turns = splitTranscriptTurns(parseTranscriptRows(data));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistantRows[0]!.text).toBe("hello");
  });
});

describe("selectTranscriptTurn", () => {
  const turns = splitTranscriptTurns(
    parseTranscriptRows(
      transcriptRows("first", [{ text: "a" }]) + transcriptRows("second", [{ text: "b" }]),
    ),
  );

  it("prefers the prompt match", () => {
    expect(selectTranscriptTurn(turns, 5, "first")?.index).toBe(0);
  });
  it("falls back to the turn number, then the last turn", () => {
    expect(selectTranscriptTurn(turns, 1, undefined)?.index).toBe(0);
    expect(selectTranscriptTurn(turns, 9, "unknown prompt")?.index).toBe(1);
  });
});

describe("readTranscriptTurnsSettled", () => {
  it("waits for the turn_ended marker Cursor writes after stop fires", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      file,
      '{"role":"user","message":{"content":"x"}}\n{"role":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n',
    );
    setTimeout(() => {
      fs.appendFileSync(
        file,
        '{"role":"assistant","message":{"content":[{"type":"text","text":"final"}]}}\n{"type":"turn_ended","status":"success"}\n',
      );
    }, 120);
    const turns = await readTranscriptTurnsSettled(file, { budgetMs: 2_000, intervalMs: 30 });
    expect(turns?.[0]?.assistantRows.map((r) => r.text)).toEqual(["partial", "final"]);
    expect(turns?.[0]?.endedStatus).toBe("success");
    cleanTmpDirs();
  });

  it("gives up after the budget and returns what is there", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, '{"role":"user","message":{"content":"x"}}\n');
    const turns = await readTranscriptTurnsSettled(file, { budgetMs: 100, intervalMs: 20 });
    expect(turns).toHaveLength(1);
    expect(turns![0]!.endedStatus).toBeUndefined();
    cleanTmpDirs();
  });
});
