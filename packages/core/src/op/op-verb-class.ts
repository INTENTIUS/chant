/**
 * Op verb classification (#1484) — generalizes `delete: "never" | "owned-only"
 * | "gated"` (`../lifecycle` teardown/apply's `DeleteMode`) up one level, to
 * the whole Op: read-only, mutating, or destructive. `ConvergeOp`'s
 * dial × verb-class matrix (the issue's "Autonomy" table) needs to answer
 * "what kind of thing is this dispatched Op, from the outside" for an
 * arbitrary declared Op — including one this project's authors wrote, not
 * just the pre-built composites — so classification walks `OpConfig`'s
 * steps rather than trusting a self-reported tag.
 *
 * There is no existing per-Op verb-class field (`labels` is a free
 * `Record<string,string>` an author may or may not set — `ApplyOp` tags
 * `{ Apply: "true" }` but nothing requires it, and it carries no verb-class
 * semantics on its own) and no existing "which activity names are
 * destructive" registry (`../lint/pipeline-change-gate.ts`'s classifier is
 * shaped for a `Component` composition's capability-verb steps, not an
 * `OpConfig`'s activity steps — a genuinely different graph). This module is
 * that registry's Op-shaped sibling: a small, explicit set of known
 * mutating/destructive activity function names, plus the one piece of
 * structured signal that already exists (`nativeApply`'s `deleteMode` arg).
 *
 * Fail-closed by construction: an activity `fn` this module doesn't
 * recognize is classified `mutating`, never `read-only` — an unknown step
 * might do anything, and "unknown never remediates" (the issue's own honesty
 * requirement for symptoms) applies here too: this module never silently
 * clears an Op to free-run just because its steps aren't in the known-safe
 * list.
 */

import type { ActivityStep, EffectStep, GateStep, OpConfig, StepDefinition } from "./types";

export type OpVerbClass = "read-only" | "mutating" | "destructive";

/** Activity function names known to be read-only — verification, observation, audit. Anything not in this set is treated as at least `mutating` (fail-closed). */
const READ_ONLY_ACTIVITY_FNS: ReadonlySet<string> = new Set([
  "lifecycleSnapshot",
  "lifecycleDiff",
  "httpCheck",
  "policyGate",
  "workflowSupplyChainAudit",
  "pipelineSupplyChainAudit",
  "receiptStaleness",
  "waitForStack",
  "waitForReady",
  "waitForArgoSync",
  "spriteReadFile",
  "spriteListDir",
  "listCheckpoints",
  "convergeTick",
]);

/** Activity function names that always delete/destroy, regardless of args. */
const ALWAYS_DESTRUCTIVE_ACTIVITY_FNS: ReadonlySet<string> = new Set([
  "envTeardown",
  "chantTeardown",
  "azDelete",
  "awsDelete",
  "gcpDelete",
  "spriteDestroy",
  "k3dDown",
  "k3sUninstall",
]);

function stepsOf(config: Pick<OpConfig, "phases" | "onFailure">): ActivityStep[] {
  const all: StepDefinition[] = [...config.phases, ...(config.onFailure ?? [])].flatMap((p) => p.steps);
  const flat: ActivityStep[] = [];
  for (const step of all) {
    if (step.kind === "activity") flat.push(step);
    else if (step.kind === "effect") flat.push(...(step as EffectStep).steps.filter((s): s is ActivityStep => s.kind === "activity"));
  }
  return flat;
}

/**
 * Classify an Op's own composition. Pure — reads only the passed config, no
 * I/O. `nativeApply`'s `deleteMode` (`"never" | "owned-only" | "gated"`) is
 * read straight off the step's `args` — `"owned-only"`/`"gated"` are
 * destructive (both can delete a live resource), `"never"`/absent is merely
 * mutating (creates/updates only). A step whose `fn` matches neither the
 * read-only nor the destructive set is `mutating` by default (fail-closed).
 */
export function classifyOpVerbClass(config: Pick<OpConfig, "phases" | "onFailure">): OpVerbClass {
  let sawMutating = false;

  for (const step of stepsOf(config)) {
    if (ALWAYS_DESTRUCTIVE_ACTIVITY_FNS.has(step.fn)) return "destructive";

    if (step.fn === "nativeApply") {
      const deleteMode = step.args?.deleteMode;
      if (deleteMode === "owned-only" || deleteMode === "gated") return "destructive";
      sawMutating = true;
      continue;
    }

    if (step.fn === "compensateApply") {
      // Rollback compensation — mutating (it re-applies a prior state), not
      // itself a fresh destructive act.
      sawMutating = true;
      continue;
    }

    if (READ_ONLY_ACTIVITY_FNS.has(step.fn)) continue;

    // Unknown or known-mutating fn: fail-closed to mutating.
    sawMutating = true;
  }

  return sawMutating ? "mutating" : "read-only";
}

/**
 * Does this Op have its own approval gate anywhere in its phases (main or
 * `onFailure`), including one nested inside an effect step?
 *
 * A declaration-time question, not a run-time one: a gate is a fact the
 * executor decides against the ledger when it reaches one (#2119,
 * `./gate.ts`), so this says "this op can stop for a human", never "this op
 * will stop". `TMP014`'s dispatch refusals are the caller that needs it.
 */
export function isGated(config: Pick<OpConfig, "phases" | "onFailure">): boolean {
  const isGate = (s: StepDefinition): s is GateStep => s.kind === "gate";
  for (const phase of [...config.phases, ...(config.onFailure ?? [])]) {
    for (const step of phase.steps) {
      if (isGate(step)) return true;
      if (step.kind === "effect" && step.steps.some(isGate)) return true;
    }
  }
  return false;
}
