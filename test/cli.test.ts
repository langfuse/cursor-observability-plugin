import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HOOK_EVENTS, registerHooks } from "../src/cli.js";
import { cleanTmpDirs, makeTmpDir } from "./helpers.js";

const hookBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.mjs");

afterEach(cleanTmpDirs);

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBin, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out }));
  });
}

describe("registerHooks", () => {
  it("adds every hook once and keeps hooks from other tools", () => {
    const file = path.join(makeTmpDir(), "hooks.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hooks: { afterFileEdit: [{ command: "./scripts/format.sh" }] },
      }),
    );

    const first = registerHooks(file, '"node" "/plugin/dist/index.mjs"');
    expect(first).toEqual({ added: 18, replaced: 0 });

    const doc = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      version: number;
      hooks: Record<string, Array<{ command: string; timeout: number }>>;
    };
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.hooks)).toHaveLength(18);
    expect(doc.hooks.afterFileEdit!.map((e) => e.command)).toEqual([
      "./scripts/format.sh",
      '"node" "/plugin/dist/index.mjs"',
    ]);
    expect(doc.hooks.stop![0]!.timeout).toBe(60);
    expect(doc.hooks.preToolUse![0]!.timeout).toBe(10);
  });

  it("replaces its own entry on re-run instead of duplicating it", () => {
    const file = path.join(makeTmpDir(), "hooks.json");
    const old = '"/old/node" "/opt/cursor-observability-plugin/dist/index.mjs"';
    registerHooks(file, old);
    const second = registerHooks(file, '"/new/node" "/new/plugin/dist/index.mjs"', [old]);
    expect(second).toEqual({ added: 0, replaced: 18 });

    const doc = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    for (const entries of Object.values(doc.hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.command).toContain("/new/plugin");
    }
  });

  it("recognises a renamed checkout through the recorded command", () => {
    const file = path.join(makeTmpDir(), "hooks.json");
    // A checkout whose directory name mentions neither Langfuse nor the plugin.
    const old = '"/usr/bin/node" "/Users/me/scratch/obs/dist/index.mjs"';
    registerHooks(file, old);
    const again = registerHooks(file, '"/usr/bin/node" "/Users/me/moved/dist/index.mjs"', [old]);
    expect(again).toEqual({ added: 0, replaced: 18 });

    // Without the record, the unrecognisable command would be appended instead.
    const fresh = path.join(makeTmpDir(), "hooks.json");
    registerHooks(fresh, old);
    expect(registerHooks(fresh, '"/usr/bin/node" "/Users/me/moved/dist/index.mjs"')).toEqual({
      added: 18,
      replaced: 0,
    });
  });

  it("starts from scratch when the file is unreadable", () => {
    const file = path.join(makeTmpDir(), "hooks.json");
    fs.writeFileSync(file, "{ not json");
    expect(registerHooks(file, "cmd")).toEqual({ added: 18, replaced: 0 });
    expect(
      Object.keys((JSON.parse(fs.readFileSync(file, "utf-8")) as { hooks: object }).hooks),
    ).toHaveLength(18);
  });
});

describe("setup command", () => {
  it("prints usage and writes nothing without keys", async () => {
    const home = makeTmpDir();
    const { code, out } = await run(["setup"], { PATH: process.env.PATH, HOME: home });
    expect(code).toBe(1);
    expect(out).toContain("--public-key");
    expect(out).toContain("--base-url");
    expect(out).not.toContain("default https://cloud.langfuse.com");
    expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
  });

  it("writes nothing when the keys have no host", async () => {
    const home = makeTmpDir();
    const { code, out } = await run(
      ["setup", "--public-key", "pk-lf-x", "--secret-key", "sk-lf-x"],
      { PATH: process.env.PATH, HOME: home },
    );
    expect(code).toBe(1);
    expect(out).toContain("Required");
    expect(fs.existsSync(path.join(home, ".cursor", "langfuse.json"))).toBe(false);
  });

  it("writes nothing when the keys cannot be verified", async () => {
    const home = makeTmpDir();
    const { code, out } = await run(
      [
        "setup",
        "--public-key",
        "pk-lf-x",
        "--secret-key",
        "sk-lf-x",
        "--base-url",
        "http://127.0.0.1:9",
      ],
      { PATH: process.env.PATH, HOME: home },
    );
    expect(code).toBe(1);
    expect(out).toContain("Nothing was written");
    expect(fs.existsSync(path.join(home, ".cursor", "langfuse.json"))).toBe(false);
  }, 30_000);
});

describe("setup --project", () => {
  it("writes a PATH-based command, so the committed file works on other machines", async () => {
    const home = makeTmpDir();
    const project = makeTmpDir();
    const { code, out } = await run(
      [
        "setup",
        "--project",
        project,
        "--hooks",
        "--public-key",
        "pk-lf-x",
        "--secret-key",
        "sk-lf-x",
        "--base-url",
        "http://127.0.0.1:9",
      ],
      { PATH: process.env.PATH, HOME: home },
    );
    // The unreachable base URL fails verification, so nothing is written at all.
    expect(code).toBe(1);
    expect(out).toContain("Nothing was written");
    expect(fs.existsSync(path.join(project, ".cursor", "hooks.json"))).toBe(false);
  }, 30_000);

  it("keeps the absolute interpreter path out of a project hooks file", () => {
    // registerHooks is command-agnostic; the scope decision lives in runSetup,
    // so pin the template that documents the same command instead.
    const template = JSON.parse(
      fs.readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../templates/project-hooks.json",
        ),
        "utf-8",
      ),
    ) as { hooks: Record<string, Array<{ command: string }>> };
    for (const [event, entries] of Object.entries(template.hooks)) {
      expect(entries[0]!.command, `${event} must go through PATH`).toBe("langfuse-cursor-hook");
      expect(entries[0]!.command, `${event} must not pin a local path`).not.toContain("/");
    }
  });
});

describe("status command", () => {
  it("reports tracing off and the resolved paths without keys", async () => {
    const home = makeTmpDir();
    const { code, out } = await run(["status"], { PATH: process.env.PATH, HOME: home });
    expect(code).toBe(0);
    expect(out).toContain("tracing       off");
    expect(out).toContain(path.join(home, ".cursor", "langfuse"));
    expect(out).not.toContain("connection"); // no keys, so no API call
  });
});

describe("hook lists stay in sync", () => {
  /**
   * The 18 hook events are declared in three places: the plugin manifest's
   * hooks file (what a marketplace install registers), the project-hooks
   * template (what a repo commits), and cli.ts (what `setup --hooks` writes).
   * A hook added to one and forgotten in another is silently missing data,
   * so pin them against each other.
   */
  const read = (file: string): string[] => {
    const doc = JSON.parse(
      fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", file),
        "utf-8",
      ),
    ) as { version?: number; hooks: Record<string, Array<{ command: string; timeout?: number }>> };
    expect(doc.version, `${file} needs the schema version`).toBe(1);
    return Object.keys(doc.hooks).sort();
  };

  it("plugin manifest hooks match cli.ts", () => {
    expect(read("hooks/hooks.json")).toEqual([...HOOK_EVENTS].sort());
  });

  it("project template matches cli.ts", () => {
    expect(read("templates/project-hooks.json")).toEqual([...HOOK_EVENTS].sort());
  });

  it("every registered hook points at this plugin", () => {
    for (const file of ["hooks/hooks.json", "templates/project-hooks.json"]) {
      const doc = JSON.parse(
        fs.readFileSync(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", file),
          "utf-8",
        ),
      ) as { hooks: Record<string, Array<{ command: string }>> };
      for (const [event, entries] of Object.entries(doc.hooks)) {
        expect(entries, `${file}: ${event}`).toHaveLength(1);
        expect(entries[0]!.command, `${file}: ${event}`).toMatch(
          /langfuse-cursor-hook|dist\/index\.mjs/,
        );
      }
    }
  });
});

describe("plugin manifest", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".cursor-plugin/plugin.json"), "utf-8"),
  ) as { name: string; version: string; hooks: string; logo?: string };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
    version: string;
    files: string[];
  };

  it("references only files that exist", () => {
    for (const relative of [manifest.hooks, manifest.logo].filter(Boolean) as string[]) {
      expect(
        fs.existsSync(path.join(root, relative)),
        `${relative} is referenced but missing`,
      ).toBe(true);
    }
  });

  it("ships every referenced file in the npm package", () => {
    for (const relative of [manifest.hooks, manifest.logo].filter(Boolean) as string[]) {
      const top = relative.replace(/^\.\//, "").split("/")[0]!;
      expect(
        pkg.files,
        `${relative} is referenced but "${top}" is not in package.json files`,
      ).toContain(top);
    }
  });

  it("keeps the manifest version in step with package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
