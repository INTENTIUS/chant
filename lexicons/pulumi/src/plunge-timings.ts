/**
 * plunge's per-resource timings (INTENTIUS/plunge#55) as trace spans and run
 * record facts (INTENTIUS/chant#4579).
 *
 * `pulumiStreamTimings` (./engine-events.ts) reads each resource's provider
 * calls and record writes from `plunge up --json`. Here each resource becomes
 * one span, from its first call's start to its last call's end, with a child
 * span per call. `pulumi-up`'s `traceFacts` hands them to core, which puts
 * them under the stack's span in the op-wave job's trace and under the
 * stack's entry in the run record's `wave.targets` (chant#4555, chant#4551).
 * The stack's span also gets the totals.
 *
 * A stock Pulumi `up` prints no timings: the spans are empty and the totals
 * absent, which is not an error.
 */

import type { CapabilityTraceFacts, CapabilityTraceSpan } from "@intentius/chant/otlp";
import type { PlungeTiming } from "./engine-events";

type Attrs = NonNullable<CapabilityTraceFacts["attributes"]>;

/** A URN's type and name: `urn:pulumi:<stack>::<project>::<parent$type>::<name>`. Undefined when it is not a URN. */
export function pulumiUrnParts(urn: string): { type: string; name: string } | undefined {
  const parts = urn.split("::");
  if (parts.length < 4 || !parts[0]!.startsWith("urn:pulumi:")) return undefined;
  const chain = parts[2]!;
  return { type: chain.slice(chain.lastIndexOf("$") + 1), name: parts.slice(3).join("::") };
}

/** Milliseconds rounded to the microsecond, so attributes stay readable. */
const ms = (n: number): number => Math.round(n * 1000) / 1000;

/** One resource's span, with a child per call. Undefined when no entry has a start that reads. */
export function plungeResourceSpan(urn: string, timings: readonly PlungeTiming[]): CapabilityTraceSpan | undefined {
  const timed = timings.filter((t) => Number.isFinite(Date.parse(t.startedAt)));
  if (timed.length === 0) return undefined;
  // Date.parse keeps milliseconds; the sub-millisecond digits of a start stay in its child's startedAt.
  const starts = timed.map((t) => Date.parse(t.startedAt));
  const first = Math.min(...starts);
  const last = Math.max(...timed.map((t, i) => starts[i]! + t.durationMs));
  const sum = (kind: PlungeTiming["kind"]) => ms(timed.filter((t) => t.kind === kind).reduce((n, t) => n + t.durationMs, 0));
  const parts = pulumiUrnParts(urn);
  const failed = timed.some((t) => t.failed === true);
  return {
    name: urn,
    startedAt: new Date(first).toISOString(),
    durationMs: ms(last - first),
    attributes: {
      urn,
      ...(parts ? { "resource.type": parts.type, "resource.name": parts.name } : {}),
      "plunge.calls": timed.length,
      "plunge.provider_ms": sum("provider"),
      "plunge.record_ms": sum("record"),
    },
    ...(failed ? { failed: true } : {}),
    children: timed.map((t) => ({
      name: `${t.kind} ${t.call}`,
      startedAt: t.startedAt,
      durationMs: t.durationMs,
      attributes: { "plunge.kind": t.kind, "plunge.call": t.call },
      ...(t.failed ? { failed: true } : {}),
    })),
  };
}

/** A span per timed resource, in the order the stream first timed each. */
export function plungeTimingSpans(timings: Readonly<Record<string, readonly PlungeTiming[]>> | undefined): CapabilityTraceSpan[] {
  return Object.entries(timings ?? {})
    .map(([urn, t]) => plungeResourceSpan(urn, t))
    .filter((s): s is CapabilityTraceSpan => s !== undefined);
}

/**
 * The stack's totals over every resource: the calls, the milliseconds in
 * provider calls and in record writes, the failed calls, and the slowest
 * call. Empty for a stack with no timings.
 */
export function plungeTimingTotals(timings: Readonly<Record<string, readonly PlungeTiming[]>> | undefined): Attrs {
  const all = Object.entries(timings ?? {}).flatMap(([urn, ts]) => ts.map((t) => ({ urn, t })));
  if (all.length === 0) return {};
  const sum = (kind: PlungeTiming["kind"]) => ms(all.filter((x) => x.t.kind === kind).reduce((n, x) => n + x.t.durationMs, 0));
  const slowest = all.reduce((a, b) => (b.t.durationMs > a.t.durationMs ? b : a));
  const failed = all.filter((x) => x.t.failed === true).length;
  return {
    "plunge.resources": Object.keys(timings ?? {}).length,
    "plunge.calls": all.length,
    "plunge.provider_ms": sum("provider"),
    "plunge.record_ms": sum("record"),
    ...(failed > 0 ? { "plunge.failed_calls": failed } : {}),
    "plunge.slowest.urn": slowest.urn,
    "plunge.slowest.call": `${slowest.t.kind} ${slowest.t.call}`,
    "plunge.slowest.ms": ms(slowest.t.durationMs),
  };
}
