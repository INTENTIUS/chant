/**
 * `pulumi-up`'s engine facts for its span and op-wave run record
 * (INTENTIUS/chant#4555): the stack, the member, the engine that ran it, and
 * what `up --json`'s summary counted. Core writes every key under the CI
 * product's prefix (`plywood.stack`, `plywood.up.create`).
 *
 * The keys:
 *
 *   stack, member, engine     the stack, `<project>/<stack>`, `pulumi` or `plunge`
 *   up.<op>                   the summary's count for each op (`create`, `update`, `same`, ...)
 *   up.duration_s, up.result  the summary's duration and result, when it gives them
 *   up.maybe_corrupt          set when the engine said the update may have left state corrupt
 *   up.from_wave_plan         whether `run` applied the plan the wave decided
 *   plunge.*                  on plunge, the totals of its per-resource timings (./plunge-timings.ts)
 *
 * On plunge the facts also carry a span per resource it timed, with a child
 * per provider call and record write (INTENTIUS/plunge#55, chant#4579), and
 * a progress line per resource, which core puts on the stack's `step-settle`
 * event and prints in the job's log (chant#4615).
 */

import type { CapabilityTraceFacts } from "@intentius/chant/otlp";
import type { PulumiApplySummary } from "./engine-events";
import { plungeResourceProgress, plungeTimingSpans, plungeTimingTotals } from "./plunge-timings";
import type { PulumiUpStepInput, PulumiUpStepOutput } from "./pulumi-up";

type Attrs = NonNullable<CapabilityTraceFacts["attributes"]>;

/** A summary's counts and verdict as attributes. */
export function pulumiSummaryAttributes(summary: PulumiApplySummary | undefined): Attrs {
  if (!summary) return {};
  const out: Attrs = {};
  for (const [op, n] of Object.entries(summary.resourceChanges)) if (typeof n === "number" && Number.isFinite(n)) out[`up.${op}`] = n;
  if (summary.durationSeconds !== undefined) out["up.duration_s"] = summary.durationSeconds;
  if (summary.result) out["up.result"] = summary.result;
  if (summary.maybeCorrupt) out["up.maybe_corrupt"] = true;
  return out;
}

/** What an error `run` threw says about the update: its member and summary, when it carries them. */
function fromError(error: unknown): { member?: string; summary?: PulumiApplySummary } {
  if (typeof error !== "object" || error === null) return {};
  const e = error as { member?: unknown; summary?: unknown };
  return {
    ...(typeof e.member === "string" ? { member: e.member } : {}),
    ...(typeof e.summary === "object" && e.summary !== null ? { summary: e.summary as PulumiApplySummary } : {}),
  };
}

/** `traceFacts` for `pulumi-up` (#4555). */
export function pulumiTraceFacts(input: PulumiUpStepInput, outcome: { output: PulumiUpStepOutput } | { error: unknown }): CapabilityTraceFacts {
  if ("output" in outcome && outcome.output) {
    const o = outcome.output;
    const spans = plungeTimingSpans(o.summary?.timings);
    const resources = plungeResourceProgress(o.summary?.timings);
    return {
      attributes: {
        stack: o.stack,
        member: o.member,
        engine: o.engine,
        "up.from_wave_plan": o.fromWavePlan,
        ...pulumiSummaryAttributes(o.summary),
        ...plungeTimingTotals(o.summary?.timings),
      },
      ...(spans.length > 0 ? { spans } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    };
  }
  const e = fromError("error" in outcome ? outcome.error : undefined);
  const spans = plungeTimingSpans(e.summary?.timings);
  const resources = plungeResourceProgress(e.summary?.timings);
  return {
    attributes: {
      ...(typeof input?.stack === "string" ? { stack: input.stack } : {}),
      ...(e.member ? { member: e.member } : {}),
      ...(input?.engine ? { engine: input.engine } : {}),
      ...pulumiSummaryAttributes(e.summary),
      ...plungeTimingTotals(e.summary?.timings),
    },
    ...(spans.length > 0 ? { spans } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  };
}
