/**
 * Op type definitions — the data model for a named, phased Temporal workflow.
 *
 * These types are intentionally free of Temporal SDK imports so they can live
 * in core without pulling in @temporalio/* as a dependency.
 */

import type { EffectReceiptRef } from "./receipt-store";

export interface OpConfig {
  /** Kebab-case identifier. Used as the workflow function name (camelCase) and output directory name. */
  name: string;
  /** Human-readable description shown in `chant run list` and deployment reports. */
  overview: string;
  /** Temporal task queue. Defaults to `name`. */
  taskQueue?: string;
  /** Temporal namespace. Defaults to chant.config.ts defaultProfile's namespace. */
  namespace?: string;
  /** Ordered list of execution phases. */
  phases: PhaseDefinition[];
  /** Other Op names that must be complete before this Op can run. */
  depends?: string[];
  /** Compensation phases executed on terminal failure (run in reverse order). */
  onFailure?: PhaseDefinition[];
  /** Search attributes to upsert at workflow start. */
  searchAttributes?: Record<string, string>;
}

export interface PhaseDefinition {
  /** Display name shown in progress output and Temporal UI. */
  name: string;
  /** Ordered steps within the phase. */
  steps: StepDefinition[];
  /** Run all steps concurrently via Promise.all. Default: false. */
  parallel?: boolean;
}

export type StepDefinition = ActivityStep | GateStep | EffectStep;

export interface ActivityStep {
  kind: "activity";
  /**
   * Identifies this step so a later step can reference its output (#1290)
   * via `stepOutput(id, path?)` or, when built with `activity()`, the
   * `.out` proxy sugar. Only steps in an Op's main `phases` — not
   * `onFailure`, not one nested inside an `EffectStep` — can be referenced.
   */
  id?: string;
  /** Name of the exported activity function in the pre-built activity library. */
  fn: string;
  /**
   * Arguments passed to the activity function. A value may be a
   * {@link StepOutputRef} (anywhere in the structure, including nested
   * inside a plain object or array) — a reference to an earlier step's
   * declared return value, resolved at build time and compiled by the
   * serializer into a local variable holding that step's result. Never an
   * expression over one: `diff.out.count > 0` or a template literal
   * coerces the reference to a primitive, which throws (see
   * `step-output-ref.ts`'s module doc for why this is a runtime-on-load
   * guard, not a static lint rule).
   */
  args?: Record<string, unknown>;
  /**
   * Key from TEMPORAL_ACTIVITY_PROFILES controlling timeout + retry.
   * Default: "fastIdempotent"
   */
  profile?: "fastIdempotent" | "longInfra" | "k8sWait" | "humanGate" | "argoSync" | "policyCheck";
  /**
   * Surface this activity's return value as a workflow search attribute.
   *
   * The serializer captures the awaited result into a temporary, then emits
   * `upsertSearchAttributes({ <name>: [String(<from-path>)] })` immediately
   * after. Useful for filtering runs by outcome (e.g. `Drift: "true"/"false"`
   * from a lifecycleDiff activity).
   *
   * `from` is a dot-path into the return value (e.g. `"drifted"` for
   * `{ drifted: boolean }`); when omitted, the whole return value is
   * stringified.
   */
  outcomeAttribute?: { name: string; from?: string };
}

/**
 * Read-compare-run-write over an effect receipt (#1834, epic #1703). The
 * runtime reads the live receipt through the receipt store, compares it
 * against the resolved expectation, skips the nested steps on a match, and
 * otherwise runs them — writing the receipt only when every nested step
 * succeeded, last. A nested-step failure leaves the receipt untouched
 * (stale), so the next run re-proposes the effect.
 *
 * Authored via the `effect()` builder, which takes the typed EffectReceipt
 * declaration only — there is no string form.
 */
export interface EffectStep {
  kind: "effect";
  /** Receipt identity + declaration data (references in placeholder form). */
  receipt: EffectReceiptRef;
  /**
   * The expectation stamped at synthesis when the receipt is fully static;
   * absent when reference inputs resolve at run (#1703 decision 5).
   */
  expectation?: string;
  /**
   * Steps run when the live receipt does not match, in authored order. A gate
   * authored here pauses only when the effect will fire. Effect steps do not
   * nest.
   */
  steps: Array<ActivityStep | GateStep>;
  /** Annotation carried into the generated workflow as a comment. */
  description?: string;
}

export interface GateStep {
  kind: "gate";
  /** Signal name. The generated workflow waits for this signal before continuing. */
  signalName: string;
  /** Temporal duration string. Default: "48h". */
  timeout?: string;
  /** Human-readable description of the action required to unblock this gate. */
  description?: string;
}

