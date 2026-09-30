import { defineConfig } from "tsdown";

// The hook runs as `node dist/index.mjs` straight from the plugin checkout or
// the npm tarball, with no install step, so every runtime dependency (Langfuse
// SDK, OpenTelemetry) is bundled. Only Node.js built-ins stay external.
//
// Two chunks on purpose: `index.mjs` is the per-event fast path that every
// Cursor hook (including the blocking `before*` gates) runs, and it must not
// pay for loading the SDK. The Langfuse export code is a dynamic import that
// only the `stop` / `sessionEnd` paths resolve.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@langfuse\//, /^@opentelemetry\//],
  dts: false,
  clean: true,
  minify: false,
  outExtensions: () => ({ js: ".mjs" }),
});
