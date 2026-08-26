/**
 * Typed step-builder wrappers for this lexicon's activities (chant #1288
 * Stage 2). See `lexicons/k8s/src/op/builders.ts`'s module doc for why these
 * live beside their `*Args` interfaces rather than in core or the temporal
 * barrel: core cannot import a lexicon's types (lexicons depend on core, not
 * the reverse), and wiring them into the cloud-agnostic temporal barrel
 * would make it depend on every cloud lexicon at runtime. `opts`'s type in
 * each wrapper below IS the activity's own `*Args` interface (via
 * `Omit`/`WithStepRefs`) — never restated. `core`'s own
 * `awsApply`/`awsDelete`/`flociUp`/`flociDown` are unchanged and produce
 * byte-identical `ActivityStep` output; these are purely additive.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { AwsApplyArgs, AwsDeleteArgs } from "./activities/aws-apply";
import type { FlociUpArgs, FlociDownArgs } from "./activities/floci";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Deploy a built CloudFormation template directly against the CFN API — the
 * fully typed twin of core's `awsApply`. `opts` is {@link AwsApplyArgs}
 * itself, minus the positional `templatePath`. Defaults to the `longInfra`
 * profile.
 */
export const awsApply = (
  templatePath: string,
  opts: WithStepRefs<Omit<AwsApplyArgs, "templatePath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("awsApply", { templatePath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Delete a CloudFormation stack — the inverse of {@link awsApply}, fully
 * typed twin of core's `awsDelete`. `opts` is {@link AwsDeleteArgs} itself,
 * minus the positional `templatePath`. Defaults to the `longInfra` profile.
 */
export const awsDelete = (
  templatePath: string,
  opts: WithStepRefs<Omit<AwsDeleteArgs, "templatePath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("awsDelete", { templatePath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Boot the local Floci AWS emulator — the fully typed twin of core's
 * `flociUp`. `opts` is {@link FlociUpArgs} itself. Defaults to the
 * `longInfra` profile.
 */
export const flociUp = (opts?: WithStepRefs<FlociUpArgs> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("flociUp", args, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Stop and remove the local Floci emulator container — the fully typed twin
 * of core's `flociDown`. `opts` is {@link FlociDownArgs} itself. Defaults to
 * the `fastIdempotent` profile.
 */
export const flociDown = (opts?: WithStepRefs<FlociDownArgs> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("flociDown", args, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};
