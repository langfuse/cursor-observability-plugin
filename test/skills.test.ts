import { describe, expect, it } from "vitest";

import { skillsForToolCall, traceTags } from "../src/skills.js";
import type { ToolCall, Turn } from "../src/types.js";

function call(name: string, input: unknown): ToolCall {
  return { name, input, startTime: 0, endTime: 1, sources: [], subagents: [] };
}

function turnWith(toolCalls: ToolCall[]): Turn {
  return {
    conversationId: "c",
    turnNumber: 1,
    startTime: 0,
    endTime: 1,
    status: "completed",
    closedBy: "stop",
    generations: [
      { startTime: 0, endTime: 1, thoughts: [], toolCalls, otherBlocks: [], source: "events" },
    ],
    orphanSubagents: [],
    compactions: [],
    history: [],
    transcriptUsed: false,
    eventCounts: {},
  };
}

describe("skillsForToolCall", () => {
  it("names a skill load from the directory that contains SKILL.md", () => {
    expect(
      skillsForToolCall(call("Read", { path: "/repo/.cursor/skills/shipping/land-it/SKILL.md" })),
    ).toEqual(["land-it"]);
    expect(
      skillsForToolCall(
        call("Read", { file_path: "/Users/dev/.cursor/skills-cursor/canvas/SKILL.md" }),
      ),
    ).toEqual(["canvas"]);
    expect(
      skillsForToolCall(
        call("Read", {
          path: "/Users/dev/.cursor/plugins/cache/acme/skills/create-page/SKILL.md",
        }),
      ),
    ).toEqual(["create-page"]);
  });

  it("names a skill load from a shell command that runs a skill script", () => {
    expect(
      skillsForToolCall(
        call("Shell", { command: "node .cursor/skills/langfuse/scripts/check.mjs" }),
      ),
    ).toEqual(["langfuse"]);
  });

  it("ignores writes, searches, and SKILL.md files outside a skills directory", () => {
    expect(
      skillsForToolCall(call("Write", { path: "/repo/.cursor/skills/langfuse/SKILL.md" })),
    ).toEqual([]);
    expect(
      skillsForToolCall(call("Grep", { path: "/repo/.cursor/skills/langfuse/SKILL.md" })),
    ).toEqual([]);
    expect(skillsForToolCall(call("Read", { path: "/repo/docs/SKILL.md" }))).toEqual([]);
  });
});

describe("traceTags", () => {
  const turn = turnWith([
    call("Read", { path: "/repo/.cursor/skills/langfuse/SKILL.md" }),
    call("Shell", { command: "cat .cursor/skills/langfuse/SKILL.md" }),
  ]);

  it("adds one skill tag per loaded skill, after cursor and operator tags", () => {
    expect(traceTags({ tags: ["team"], skill_tags: true }, turn)).toEqual([
      "cursor",
      "team",
      "skill:langfuse",
    ]);
  });

  it("drops skill tags when skill_tags is off and keeps operator tags", () => {
    expect(traceTags({ tags: ["team"], skill_tags: false }, turn)).toEqual(["cursor", "team"]);
  });
});
