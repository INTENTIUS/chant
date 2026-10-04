/**
 * TerraformPinRolloutOp composite (#3189): roll a module version out as
 * pin-bump pull requests, one wave at a time.
 *
 * One phase, one `terraformPinRollout` step. Each run reads the rollout's
 * state from the forge and opens at most the next wave's PR, so the Op is
 * meant to run again: on a `schedule`, or from the pipeline that applies a
 * merged wave. Wave N+1 opens only on a run after wave N's PR merged and each
 * of its roots reported its apply check as passed on the merge commit. Until
 * then a run reports where the rollout stands and opens nothing. A failed
 * root fails the run, naming it.
 *
 * The run's `Rollout` outcome is the rollout's status: `opened`, `waiting`,
 * `complete`, or `would-open` in report mode.
 *
 * @example
 * ```typescript
 * import { TerraformPinRolloutOp } from "@intentius/chant-lexicon-terraform";
 *
 * export const { op } = TerraformPinRolloutOp({
 *   name: "vpc-1-4",
 *   module: "oci://registry.example.com/modules/vpc",
 *   from: "1.3.0",
 *   to: "1.4.0",
 *   canaries: ["live/dev/vpc"],
 *   mode: "pull-request",
 *   schedule: "*\/30 * * * *",
 * });
 * ```
 */

import { Op, phase, OpResource } from "@intentius/chant/op";
import { terraformPinRollout } from "../op/builders";
import type { TerraformPinRolloutArgs } from "../op/activities/pin-rollout";

export interface TerraformPinRolloutOpConfig extends TerraformPinRolloutArgs {
  /** Op name (kebab-case). */
  name: string;
  /** Cron expression, so the rollout re-reads the forge and moves on without anyone running it. */
  schedule?: string;
}

export interface TerraformPinRolloutOpResources {
  /** Op resource. One Rollout phase. */
  op: InstanceType<typeof OpResource>;
}

export function TerraformPinRolloutOp(config: TerraformPinRolloutOpConfig): TerraformPinRolloutOpResources {
  const { name, schedule, ...args } = config;
  const step = terraformPinRollout(args);
  step.outcomeAttribute = { name: "Rollout", from: "status" };
  const op = Op({
    name,
    overview: `Roll ${config.module} ${config.from} -> ${config.to} out as one pin-bump pull request per wave`,
    labels: { Surface: "terraform-pin-rollout" },
    ...(schedule ? { schedule: { cron: schedule, overlap: "skip" as const } } : {}),
    phases: [phase("Rollout", [step])],
  });
  return { op };
}
