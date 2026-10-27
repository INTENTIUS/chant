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
 */

import type { CapabilityTraceFacts } from "@intentius/chant/otlp";
import type { PulumiApplySummary } from "./engine-events";
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
    return {
      attributes: {
        stack: o.stack,
        member: o.member,
        engine: o.engine,
        "up.from_wave_plan": o.fromWavePlan,
        ...pulumiSummaryAttributes(o.summary),
      },
    };
  }
  const e = fromError("error" in outcome ? outcome.error : undefined);
  return {
    attributes: {
      ...(typeof input?.stack === "string" ? { stack: input.stack } : {}),
      ...(e.member ? { member: e.member } : {}),
      ...(input?.engine ? { engine: input.engine } : {}),
      ...pulumiSummaryAttributes(e.summary),
    },
  };
}
