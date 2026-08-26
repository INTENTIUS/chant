/**
 * Typed step-builder wrappers for this lexicon's activities (chant #1288
 * Stage 2). See `lexicons/k8s/src/op/builders.ts`'s module doc for why these
 * live beside their `*Args` interfaces rather than in core or the temporal
 * barrel. `opts`'s type in each wrapper below IS the activity's own `*Args`
 * interface (via `Omit`/`WithStepRefs`) — never restated. `core`'s own
 * `k3dUp`/`k3dDown` are unchanged and produce byte-identical `ActivityStep`
 * output; these are purely additive.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { K3dUpArgs, K3dDownArgs } from "./activities/k3d";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Create a local k3d cluster — the fully typed twin of core's `k3dUp`.
 * `opts` is {@link K3dUpArgs} itself, minus the positional `name`. Defaults
 * to the `longInfra` profile.
 */
export const k3dUp = (
  name: string,
  opts?: WithStepRefs<Omit<K3dUpArgs, "name">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("k3dUp", { name, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Delete a local k3d cluster — the fully typed twin of core's `k3dDown`.
 * `opts` is {@link K3dDownArgs} itself, minus the positional `name`.
 * Defaults to the `fastIdempotent` profile.
 */
export const k3dDown = (
  name: string,
  opts?: WithStepRefs<Omit<K3dDownArgs, "name">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("k3dDown", { name, ...args }, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};
