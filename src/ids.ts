import type { IdGenerator } from "@opentelemetry/sdk-trace-base";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";

import { spanIdFromSeed } from "./utils.js";

/**
 * OpenTelemetry id generator that hands out ids we chose in advance.
 *
 * Every observation of a turn gets a span id derived from the trace id and a
 * stable label, so re-exporting the same turn (a re-fired `stop`, a follow-up
 * loop, a crash retry) upserts the existing observations in Langfuse instead
 * of duplicating them. Ids are queued right before the SDK call that consumes
 * them; anything not queued falls back to random ids.
 */
export class DeterministicIdGenerator implements IdGenerator {
  private readonly fallback = new RandomIdGenerator();
  private readonly traceIds: string[] = [];
  private readonly spanIds: string[] = [];

  queueTraceId(traceId: string): void {
    this.traceIds.push(traceId);
  }

  queueSpanId(spanId: string): void {
    this.spanIds.push(spanId);
  }

  generateTraceId(): string {
    return this.traceIds.shift() ?? this.fallback.generateTraceId();
  }

  generateSpanId(): string {
    return this.spanIds.shift() ?? this.fallback.generateSpanId();
  }
}

export function spanIdFor(traceId: string, label: string): string {
  return spanIdFromSeed(`${traceId}:${label}`);
}
