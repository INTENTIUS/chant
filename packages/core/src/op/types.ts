/**
 * Op type definitions — the data model for a named, phased Op.
 *
 * These types are intentionally free of any runtime SDK's imports, so they can
 * live in core without core depending on a runtime.
 */

import type { EffectReceiptRef } from "./receipt-store";
import type { ActivityProfileName } from "./activity-profiles";

export interface OpConfig {
  /** Kebab-case identifier. Names the Op's output directory (`dist/ops/<name>/`), and is the name `chant run <name>` and another Op's `depends` refer to. */
  name: string;
  /** Human-readable description shown in `chant run list` and deployment reports. */
  overview: string;
  /** Ordered list of execution phases. */
  phases: PhaseDefinition[];
  /** Other Op names that must be complete before this Op can run. */
  depends?: string[];
  /** Compensation phases executed on terminal failure (run in reverse order). */
  onFailure?: PhaseDefinition[];
  /**
   * Discovery keys for this Op — free-form `name: value` pairs a reader
   * filters on. `ConvergeOp` sets `Converge: "true"` and `Env`, `WatchOp`
   * sets `Watch`, and `discoverConvergeOps` (`./operator.ts`) reads both;
   * `chant run list` prints whatever is here.
   *
   * These are the discovery half of what `searchAttributes` used to carry
   * (#2118). The other half — a run's own outcome (`Phase`, `Drift`,
   * `Approver`, `RollbackFailed`) — is not a property of the declaration at
   * all and now lands on the run ledger as a fact
   * (`../lifecycle/run-ledger.ts`), written per run rather than declared once.
   */
  labels?: Record<string, string>;
  /**
   * The cadence this Op runs on, when it has one (#2120). Runtime-neutral
   * data, not a scheduler: the github/gitlab/forgejo lexicons render it as a
   * CI cron ({@link ScheduledOpSpec}), `chant operator` reads it as this Op's
   * tick cadence, a hosting lexicon hands it to its own scheduler, and the
   * local one-shot executor ignores it.
   */
  schedule?: OpSchedule;
}

/**
 * An Op's cadence (#2120). The cron is validated at `Op()` construction by
 * the permissive 5-/6-field parser in `./cron.ts`, the same one a lexicon's
 * own post-synth cron check imports.
 */
export interface OpSchedule {
  /** 5- or 6-field cron expression, read in the running host's local time. */
  cron: string;
  /**
   * What a fire does while the previous run is still going. `"skip"` is the
   * only value — and the default — because that is what a level-triggered
   * tick wants: the next fire re-observes everything anyway, so queueing a
   * backlog buys nothing a single later tick does not.
   */
  overlap?: "skip";
}

export interface PhaseDefinition {
  /** Display name shown in progress output. */
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
   * Key from {@link ACTIVITY_PROFILES} controlling timeout + retry.
   * Default: "fastIdempotent"
   */
  profile?: ActivityProfileName;
  /**
   * Surface this activity's return value as a named run outcome.
   *
   * The local executor captures it into the step's record and folds it into
   * the run ledger's `outcomes` (`../lifecycle/run-ledger.ts`); a hosting
   * lexicon's serializer may additionally publish it to whatever index that
   * runtime queries by. Useful for reading back a run by outcome (e.g. `Drift:
   * "true"/"false"` from a lifecycleDiff activity).
   *
   * An array publishes several attributes off the same result in one upsert
   * (#2105): one activity can answer more than one question about a run, and
   * `choudoufuLivePlan`'s drift boolean plus its unowned and adoptable counts
   * are three attributes over a single live read that nothing would be gained
   * by splitting into three steps. A single object is the same thing with one
   * entry, and stays the authored form everywhere one attribute is enough.
   *
   * `from` is a dot-path into the return value (e.g. `"drifted"` for
   * `{ drifted: boolean }`); when omitted, the whole return value is
   * recorded.
   */
  outcomeAttribute?: OutcomeAttribute | OutcomeAttribute[];
}

/** One named run outcome published off a step's return value. */
export interface OutcomeAttribute {
  /** The outcome's name, as it appears in the run ledger's `outcomes`. */
  name: string;
  /** Dot-path into the activity's return value; the whole value when omitted. */
  from?: string;
}

/**
 * {@link ActivityStep.outcomeAttribute} as a list, whichever form it was
 * authored in. `[]` when the step publishes none, so every consumer can
 * iterate without first asking which of the two shapes it is holding.
 */
export function outcomeAttributesOf(step: { outcomeAttribute?: OutcomeAttribute | OutcomeAttribute[] }): OutcomeAttribute[] {
  const declared = step.outcomeAttribute;
  if (!declared) return [];
  return Array.isArray(declared) ? declared : [declared];
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
   * authored here is reached only when the effect will fire. Effect steps do not
   * nest.
   */
  steps: Array<ActivityStep | GateStep>;
  /** Annotation carried into the Op's build output as a comment. */
  description?: string;
}

/** Everything on a gate step except the key that names it. */
export interface GateStepBase {
  kind: "gate";
  /** How long a recorded pending gate stays valid, as a duration string. Default: "48h". */
  timeout?: string;
  /** Human-readable description of the action required to unblock this gate. */
  description?: string;
}

/**
 * A human approval decided against the gate ledger. The name lives on `gate`;
 * `signalName` is the key it carried through 0.58.0 and is still accepted
 * (#2202) — read both through `gateName()` in `./gate-name.ts` rather than
 * reaching for either key directly.
 */
export type GateStep = GateStepBase &
  (
    | {
        /** The gate's name — what `chant approve <op> <gate>` resolves. */
        gate: string;
        /** @deprecated Renamed to `gate` in #2202. Accepted through 0.59.0, removed in 0.60.0. */
        signalName?: string;
      }
    | {
        gate?: undefined;
        /** @deprecated Renamed to `gate` in #2202. Accepted through 0.59.0, removed in 0.60.0. */
        signalName: string;
      }
  );

