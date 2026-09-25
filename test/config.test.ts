import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { disabledReason, getConfig } from "../src/config.js";
import { cleanTmpDirs, makeTmpDir } from "./helpers.js";

afterEach(cleanTmpDirs);

function writeJson(dir: string, rel: string, value: unknown): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

describe("getConfig", () => {
  it("is disabled without keys and defaults to the EU cloud", () => {
    const home = makeTmpDir();
    const config = getConfig({ home, workspaceRoot: makeTmpDir(), env: {} });
    expect(config.enabled).toBe(false);
    expect(config.base_url).toBe("https://cloud.langfuse.com");
    expect(config.max_chars).toBe(20_000);
    expect(config.capture_tool_output).toBe(true);
    expect(config.capture_file_content).toBe(false);
    expect(config.state_dir).toBe(path.join(home, ".cursor", "langfuse"));
    expect(disabledReason(config, {})).toContain(
      "missing LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY",
    );
  });

  it("enables tracing when both keys are present in the environment", () => {
    const config = getConfig({
      home: makeTmpDir(),
      workspaceRoot: makeTmpDir(),
      env: { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-1" },
    });
    expect(config.enabled).toBe(true);
    expect(config.public_key).toBe("pk-lf-1");
  });

  it("resolves global file < project file < environment, with LANGFUSE_CURSOR_* winning", () => {
    const home = makeTmpDir();
    const project = makeTmpDir();
    writeJson(home, ".cursor/langfuse.json", {
      publicKey: "pk-global",
      secretKey: "sk-global",
      baseUrl: "https://us.cloud.langfuse.com/",
      userId: "global-user",
      tags: "a,b",
    });
    writeJson(project, ".cursor/langfuse.json", {
      public_key: "pk-project",
      environment: "staging",
      max_chars: 500,
    });
    const config = getConfig({
      home,
      workspaceRoot: project,
      env: {
        LANGFUSE_SECRET_KEY: "sk-env",
        LANGFUSE_CURSOR_SECRET_KEY: "sk-cursor-env",
        LANGFUSE_CURSOR_METADATA: '{"team":"platform","n":1}',
        LANGFUSE_CURSOR_TAGS: '["c"]',
      },
    });
    expect(config.public_key).toBe("pk-project");
    expect(config.secret_key).toBe("sk-cursor-env");
    expect(config.base_url).toBe("https://us.cloud.langfuse.com");
    expect(config.user_id).toBe("global-user");
    expect(config.environment).toBe("staging");
    expect(config.max_chars).toBe(500);
    expect(config.tags).toEqual(["c"]);
    expect(config.metadata).toEqual({ team: "platform", n: "1" });
  });

  it("honours the kill switch over present keys", () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-1",
      LANGFUSE_SECRET_KEY: "sk-lf-1",
      LANGFUSE_TRACING_ENABLED: "false",
    };
    const config = getConfig({ home: makeTmpDir(), workspaceRoot: makeTmpDir(), env });
    expect(config.enabled).toBe(false);
    expect(disabledReason(config, env)).toContain("kill switch");
  });

  it("expands ~ in the state directory and ignores malformed config files", () => {
    const home = makeTmpDir();
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cursor", "langfuse.json"), "{ not json");
    const config = getConfig({
      home,
      workspaceRoot: makeTmpDir(),
      env: { LANGFUSE_CURSOR_STATE_DIR: "~/state/here" },
    });
    expect(config.state_dir).toBe(path.join(home, "state", "here"));
    expect(config.enabled).toBe(false);
  });
});
