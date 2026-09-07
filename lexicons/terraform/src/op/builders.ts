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
  ChoudoufuLivePlanArgs,
  ChoudoufuLiveLsArgs,
  ChoudoufuLiveCheckArgs,
  ChoudoufuAdoptArgs,
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
 * `terraform apply <planFile>` in the named root, the fully typed twin of the
 * `terraformApply` activity. `opts` is {@link TerraformApplyArgs} itself,
 * minus the positional `root`. `planFile` is optional in the type and
 * required in practice, on a live root as much as a stock one: the activity
 * refuses a missing one, and on a live root the file is the approval artifact
 * choudoufu v0.13.0 re-plans against and refuses on a mismatch (choudoufu
 * #878). Defaults to the `longInfra` profile.
 */
export const terraformApply = (
  root: string,
  opts?: WithStepRefs<Omit<TerraformApplyArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("terraformApply", { root, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * `choudoufu live-plan -detailed-exitcode -json` in the named root, plus the
 * human render. The fully typed twin of the `choudoufuLivePlan` activity
 * (#2103). `opts` is {@link ChoudoufuLivePlanArgs} itself, minus the
 * positional `root`; `estate` is optional, auto-detected from the root's
 * `live` block or `estate.chdf.hcl` sidecar when omitted, and a root that
 * declares one is run with no `-estate` at all, which is the only form
 * choudoufu admits there (choudoufu #894, fixed in v0.14.0).
 * Defaults to the `longInfra` profile: like `terraformPlan`, this reads the
 * live system in full (the estate-wide sweep).
 *
 * Give this step an `id` to read `.out.drift`, `.out.unowned`,
 * `.out.adoptable` or `.out.documentPath` from a later step.
 */
export const choudoufuLivePlan = (
  root: string,
  opts?: WithStepRefs<Omit<ChoudoufuLivePlanArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity(
    "choudoufuLivePlan",
    { root, ...args },
    { profile: profile ?? "longInfra", ...(id ? { id } : {}) },
  );
};

/**
 * `choudoufu live-ls -estate=<estate> -json [-consistent]` in the named root,
 * the fully typed twin of the `choudoufuLiveLs` activity (#2103). `opts` is
 * {@link ChoudoufuLiveLsArgs} itself, minus the positional `root`. Defaults to
 * the `fastIdempotent` profile: `live-ls` reads a tagging-API listing and
 * calls no other provider.
 */
export const choudoufuLiveLs = (
  root: string,
  opts?: WithStepRefs<Omit<ChoudoufuLiveLsArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity(
    "choudoufuLiveLs",
    { root, ...args },
    { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) },
  );
};

/**
 * `choudoufu live-check -json` in the named root, the fully typed twin of the
 * `choudoufuLiveCheck` activity (#2103). `opts` is {@link ChoudoufuLiveCheckArgs}
 * itself, minus the positional `root`. Defaults to the `fastIdempotent`
 * profile: no cloud calls, no state.
 */
export const choudoufuLiveCheck = (
  root: string,
  opts?: WithStepRefs<Omit<ChoudoufuLiveCheckArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity(
    "choudoufuLiveCheck",
    { root, ...args },
    { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) },
  );
};

/**
 * Write the ownership markers that claim an adoption ledger's matches, in the
 * named root. The fully typed twin of the `choudoufuAdopt` activity (#2105).
 * `opts` is {@link ChoudoufuAdoptArgs} itself, minus the positional `root`, so
 * `adoptions` is required at the call site — an adopt step with nothing to
 * adopt is an authoring mistake, not a no-op worth defaulting to. Defaults to
 * the `longInfra` profile: one tagging round trip per resource, against the
 * cloud.
 */
export const choudoufuAdopt = (
  root: string,
  opts: WithStepRefs<Omit<ChoudoufuAdoptArgs, "root">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity(
    "choudoufuAdopt",
    { root, ...args },
    { profile: profile ?? "longInfra", ...(id ? { id } : {}) },
  );
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
