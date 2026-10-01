import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Config } from "./config.js";
import { DeterministicIdGenerator } from "./ids.js";
import { createSecretMask } from "./privacy.js";
import { PLUGIN_VERSION } from "./version.js";

export type Instrumentation = {
  ids: DeterministicIdGenerator;
  shutdown: () => Promise<void>;
};

/**
 * Resource attributes for the exported spans.
 *
 * Without an explicit resource, OpenTelemetry derives `service.name` from
 * argv0, which yields `unknown_service:/path/to/node` — noise on every span,
 * and it leaks a local filesystem path. `OTEL_SERVICE_NAME` and
 * `OTEL_RESOURCE_ATTRIBUTES` keep working: the default resource reads the
 * environment, and only `service.name` is overridden, with the environment
 * value preferred over ours.
 */
function buildResource(env: Record<string, string | undefined>) {
  return defaultResource().merge(
    resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME?.trim() || "cursor",
      "service.version": PLUGIN_VERSION,
    }),
  );
}

/**
 * Isolated tracer provider wired to Langfuse.
 *
 * A dedicated `NodeTracerProvider` keeps the bundle free of auto-instrumentation
 * loaders and lets us plug in the deterministic id generator. Registering it
 * also installs the AsyncLocalStorage context manager `propagateAttributes`
 * needs. Spans are batched and flushed once at the end of the hook run.
 */
export function setupInstrumentation(config: Config): Instrumentation {
  const ids = new DeterministicIdGenerator();
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    release: config.release,
    exportMode: "batched",
    mask: createSecretMask(config),
    // The hook only ever creates Langfuse spans, so export all of them.
    shouldExportSpan: () => true,
  });

  const provider = new NodeTracerProvider({
    spanProcessors: [spanProcessor],
    idGenerator: ids,
    resource: buildResource(process.env),
  });
  provider.register();
  // Bind explicitly as well: some hosts register a global provider of their own.
  setLangfuseTracerProvider(provider);

  return {
    ids,
    shutdown: async () => {
      await spanProcessor.forceFlush();
      await provider.shutdown();
    },
  };
}
