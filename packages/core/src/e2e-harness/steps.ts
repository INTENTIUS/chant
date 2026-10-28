/**
 * Per-step time limits of the harness's driver (chant#4587), from the fan-out
 * demo's steps.ts LIMITS. Past its limit a step stalls the run, and a stalled
 * run is neither a pass nor a caught break.
 */
import type { ScenarioStepKind } from "./schemas/index";

/** Seconds each kind of step may take by default. */
export const HARNESS_LIMITS: Record<ScenarioStepKind, number> = {
  /** The branch push and the pull request open. */
  open: 60,
  "open-concurrent": 60,
  /** pr-plan.json at the head, from the push. */
  plan: 600,
  /** The forge review and chant approve. */
  approve: 120,
  /** The merge and its merge commit. */
  merge: 60,
  /** pr-apply.json at the merge commit, from the merge. */
  apply: 900,
  /** A command run out of band. */
  "out-of-band": 600,
  /** Finding and killing a running job. */
  "kill-job": 120,
};

/** A scenario's limits over the defaults. */
export function limitsFor(over: Partial<Record<ScenarioStepKind, number>> = {}): Record<ScenarioStepKind, number> {
  return { ...HARNESS_LIMITS, ...over };
}
