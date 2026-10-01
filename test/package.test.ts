import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { cleanTmpDirs, makeTmpDir } from "./helpers.js";

afterEach(cleanTmpDirs);

it.skipIf(process.platform === "win32")(
  "ships an executable, self-contained npm package with dependency attribution",
  () => {
    const dir = makeTmpDir();
    const root = fileURLToPath(new URL("..", import.meta.url));
    const packed = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          dir,
          "--cache",
          path.join(dir, "cache"),
        ],
        { cwd: root, encoding: "utf8" },
      ),
    ) as Array<{ filename: string }>;
    execFileSync("tar", ["-xzf", path.join(dir, packed[0]!.filename), "-C", dir]);
    const pkg = path.join(dir, "package");
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    // npm uses an executable symlink on Unix. Execute that entry directly,
    // without supplying node (which would hide a missing shebang).
    const command = path.join(dir, "langfuse-cursor-hook");
    fs.symlinkSync(path.join(pkg, manifest.bin["langfuse-cursor-hook"]!), command);
    const result = spawnSync(command, [], {
      input: "{}",
      encoding: "utf8",
      cwd: dir,
      env: {
        PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        HOME: dir,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const notices = fs.readFileSync(path.join(pkg, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toContain("@opentelemetry/api@");
    expect(notices).toContain("Apache License");
    expect(notices).toContain("Copyright The OpenTelemetry Authors");
    expect(notices).toContain("Copyright (c) 2022 PostHog");
    expect(notices).toContain("Permission is hereby granted");
  },
  20_000,
);
