/**
 * Typed step-builder wrappers for this lexicon's activities, copied from
 * `lexicons/k3s/src/op/builders.ts` (chant #1288 Stage 2). `opts`'s type in
 * each wrapper below IS the activity's own `*Args` interface, via
 * `Omit`/`WithStepRefs`, never restated: rename a field on the activity and
 * the builder's callers stop compiling.
 *
 * The `root` key is positional in every wrapper, because naming the root is
 * the one thing a terraform step cannot be authored without.
 *
 * `id` routes to the step's `id` field rather than into `args`. That matters
 * here more than anywhere else in the lexicon: `.out` throws without an id
 * (`packages/core/src/op/builders.ts`), and `.out` is how an Apply step names
 * the Plan step's `planFile` as a `StepOutputRef` instead of guessing the
 * path a second time.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type {
  TerraformInitArgs,
  TerraformPlanArgs,
  TerraformApplyArgs,
  TerraformShowArgs,
} from "./activities/terraform";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * `terraform init` in the named root — the fully typed twin of the
 * `terraformInit` activity. `opts` is {@link TerraformInitArgs} itself, minus
 * the positional `root`. Defaults to the `longInfra` profile: init downloads
 * providers.
 */
export const terraformInit = (
  root: string,
  opts?: WithStepRefs<Omit<TerraformInitArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("terraformInit", { root, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * `terraform plan` in the named root, writing a saved plan. `opts` is
 * {@link TerraformPlanArgs} itself, minus the positional `root`. Defaults to
 * the `longInfra` profile: plan refreshes every resource against its provider.
 *
 * Give this step an `id` when a later step applies its plan — `plan.out.planFile`
 * is the reference an Apply step takes.
 */
export const terraformPlan = (
  root: string,
  opts?: WithStepRefs<Omit<TerraformPlanArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("terraformPlan", { root, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * `terraform apply <planFile>` in the named root — the fully typed twin of the
 * `terraformApply` activity. `opts` is {@link TerraformApplyArgs} itself,
 * minus the positional `root`, so `planFile` stays required at the call site
 * and the activity's bare-apply refusal is a compile error rather than a
 * runtime one. Defaults to the `longInfra` profile.
 */
export const terraformApply = (
  root: string,
  opts: WithStepRefs<Omit<TerraformApplyArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("terraformApply", { root, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * `terraform show` in the named root, over state or over a saved plan. `opts`
 * is {@link TerraformShowArgs} itself, minus the positional `root`. Defaults
 * to the `fastIdempotent` profile: show reads an artifact and calls no
 * provider.
 */
export const terraformShow = (
  root: string,
  opts?: WithStepRefs<Omit<TerraformShowArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity(
    "terraformShow",
    { root, ...args },
    { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) },
  );
};
