/**
 * Typed step-builder wrappers for this lexicon's activities (chant #1288
 * Stage 2). See `lexicons/k8s/src/op/builders.ts`'s module doc for why these
 * live beside their `*Args` interfaces rather than in core or the temporal
 * barrel. `opts`'s type in each wrapper below IS the activity's own `*Args`
 * interface (via `Omit`/`WithStepRefs`) — never restated. `core`'s own
 * `azApply`/`azDelete`/`azGroupEnsure`/`azGroupDelete`/`flociAzUp`/
 * `flociAzDown` are unchanged and produce byte-identical `ActivityStep`
 * output; these are purely additive.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { AzApplyArgs } from "./activities/az-apply";
import type { AzGroupEnsureArgs, AzGroupDeleteArgs } from "./activities/azure";
import type { FlociAzUpArgs, FlociAzDownArgs } from "./activities/floci-az";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Ensure an Azure resource group exists before an ARM apply — the fully
 * typed twin of core's `azGroupEnsure`. `opts` is {@link AzGroupEnsureArgs}
 * itself, minus the positional `resourceGroup`. Defaults to the
 * `fastIdempotent` profile.
 */
export const azGroupEnsure = (
  resourceGroup: string,
  opts?: WithStepRefs<Omit<AzGroupEnsureArgs, "resourceGroup">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("azGroupEnsure", { resourceGroup, ...args }, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};

/**
 * Delete an Azure resource group and its contents — the fully typed twin of
 * core's `azGroupDelete`. `opts` is {@link AzGroupDeleteArgs} itself, minus
 * the positional `resourceGroup`. Defaults to the `fastIdempotent` profile.
 */
export const azGroupDelete = (
  resourceGroup: string,
  opts?: WithStepRefs<Omit<AzGroupDeleteArgs, "resourceGroup">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("azGroupDelete", { resourceGroup, ...args }, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};

/**
 * Apply a built ARM template directly to the ARM resource API — the fully
 * typed twin of core's `azApply`. `opts` is {@link AzApplyArgs} itself,
 * minus the positional `templatePath` (`resourceGroup` remains required).
 * Defaults to the `longInfra` profile.
 */
export const azApply = (
  templatePath: string,
  opts: WithStepRefs<Omit<AzApplyArgs, "templatePath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("azApply", { templatePath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Delete the Azure (ARM) resources in a built template — the inverse of
 * {@link azApply}, fully typed twin of core's `azDelete`. `opts` is
 * {@link AzApplyArgs} itself (the activity reuses it), minus the positional
 * `templatePath`. Defaults to the `longInfra` profile.
 */
export const azDelete = (
  templatePath: string,
  opts: WithStepRefs<Omit<AzApplyArgs, "templatePath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("azDelete", { templatePath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Boot a local floci-az (Azure emulator) — the fully typed twin of core's
 * `flociAzUp`. `opts` is {@link FlociAzUpArgs} itself. Defaults to the
 * `longInfra` profile.
 */
export const flociAzUp = (opts?: WithStepRefs<FlociAzUpArgs> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("flociAzUp", args, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Stop and remove the local floci-az container — the fully typed twin of
 * core's `flociAzDown`. `opts` is {@link FlociAzDownArgs} itself. Defaults
 * to the `fastIdempotent` profile.
 */
export const flociAzDown = (opts?: WithStepRefs<FlociAzDownArgs> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("flociAzDown", args, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};
