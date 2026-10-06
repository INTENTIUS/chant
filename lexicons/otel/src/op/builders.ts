/**
 * Typed step builders for this lexicon's Op activities (#3369), following
 * the helm and fly builders: each one's options ARE the activity's own
 * `*Args` interface (minus its `_`-prefixed test seams), so the builder and
 * the implementation cannot drift, and every field also takes a
 * `StepOutputRef`. `profile` and `id` go to the step, never into args, so
 * `.out` works once an id is given.
 */

import { activity, takeProfileAndId, type ActivityStep, type NamedActivityStep, type WithStepRefs } from "@intentius/chant/op";
import type { OtelcolValidateArgs, OtelcolComponentsArgs } from "./activities/otelcol";
import type { CollectorHealthObserveArgs } from "./activities/collector-health";
import type { CollectorAuditArgs } from "./activities/collector-audit";

type StepOpts = { profile?: ActivityStep["profile"]; id?: string };
/** An activity's args as an author writes them: without the test seams. */
type Authored<T> = Omit<T, `_${string}`>;

function step<Args>(fn: string, defaultProfile: NonNullable<ActivityStep["profile"]>) {
  return (args: WithStepRefs<Authored<Args>> & StepOpts): NamedActivityStep => {
    const { args: rest, profile, id } = takeProfileAndId(args as Record<string, unknown>);
    return activity(fn, rest, { profile: profile ?? defaultProfile, ...(id ? { id } : {}) });
  };
}

/**
 * Run `otelcol validate` over a collector config file. Refuses when the
 * binary is not `COLLECTOR_PIN`'s version, unless `version` names the one it
 * must be. Defaults to the `fastIdempotent` profile.
 */
export const otelcolValidate = step<OtelcolValidateArgs>("otelcolValidate", "fastIdempotent");

/**
 * Check a collector config uses only components the binary was built with,
 * from `otelcol components`. Defaults to the `fastIdempotent` profile.
 */
export const otelcolComponents = step<OtelcolComponentsArgs>("otelcolComponents", "fastIdempotent");

/**
 * Observe running collectors for a `ConvergeOp({ observe })`: one resource
 * per collector, from the health_check, zpages and internal-telemetry
 * endpoints its config declares. No `health_check` in `service.extensions`
 * is `unknown`. Defaults to the `fastIdempotent` profile.
 */
export const collectorHealthObserve = step<CollectorHealthObserveArgs>("collectorHealthObserve", "fastIdempotent");

/**
 * Audit the lexicon's pins against upstream releases (the step of
 * `CollectorAuditOp`). Defaults to the `fastIdempotent` profile.
 */
export const collectorAudit = (args: WithStepRefs<Authored<CollectorAuditArgs>> & StepOpts = {}): NamedActivityStep =>
  step<CollectorAuditArgs>("collectorAudit", "fastIdempotent")(args);
