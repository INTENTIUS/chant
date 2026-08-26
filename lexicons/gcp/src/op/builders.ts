/**
 * Typed step-builder wrappers for this lexicon's activities (chant #1288
 * Stage 2). See `lexicons/k8s/src/op/builders.ts`'s module doc for why these
 * live beside their `*Args` interfaces rather than in core or the temporal
 * barrel. `opts`'s type in each wrapper below IS the activity's own `*Args`
 * interface (via `Omit`/`WithStepRefs`) — never restated. `core`'s own
 * `gcpApply`/`gcpDelete`/`flociGcpUp`/`flociGcpDown` are unchanged and
 * produce byte-identical `ActivityStep` output; these are purely additive.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { GcpApplyArgs } from "./activities/gcp-apply";
import type { FlociGcpUpArgs, FlociGcpDownArgs } from "./activities/floci-gcp";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Apply built GCP (CNRM) resources directly to their GCP REST APIs — the
 * fully typed twin of core's `gcpApply`. `opts` is {@link GcpApplyArgs}
 * itself, minus the positional `manifestPath`. Defaults to the `longInfra`
 * profile.
 */
export const gcpApply = (
  manifestPath: string,
  opts?: WithStepRefs<Omit<GcpApplyArgs, "manifestPath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("gcpApply", { manifestPath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Delete the GCP (CNRM) resources in a built manifest — the inverse of
 * {@link gcpApply}, fully typed twin of core's `gcpDelete`. `opts` is
 * {@link GcpApplyArgs} itself (the activity reuses it), minus the positional
 * `manifestPath`. Defaults to the `longInfra` profile.
 */
export const gcpDelete = (
  manifestPath: string,
  opts?: WithStepRefs<Omit<GcpApplyArgs, "manifestPath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("gcpDelete", { manifestPath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Boot a local floci-gcp (GCP emulator) — the fully typed twin of core's
 * `flociGcpUp`. `opts` is {@link FlociGcpUpArgs} itself. Defaults to the
 * `longInfra` profile.
 */
export const flociGcpUp = (opts?: WithStepRefs<FlociGcpUpArgs> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("flociGcpUp", args, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Stop and remove the local floci-gcp container — the fully typed twin of
 * core's `flociGcpDown`. `opts` is {@link FlociGcpDownArgs} itself. Defaults
 * to the `fastIdempotent` profile.
 */
export const flociGcpDown = (opts?: WithStepRefs<FlociGcpDownArgs> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("flociGcpDown", args, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};
