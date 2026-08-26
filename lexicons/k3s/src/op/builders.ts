/**
 * Typed step-builder wrappers for this lexicon's activities (chant #1288
 * Stage 2). See `lexicons/k8s/src/op/builders.ts`'s module doc for why these
 * live beside their `*Args` interfaces rather than in core or the temporal
 * barrel. `opts`'s type in each wrapper below IS the activity's own `*Args`
 * interface (via `Omit`/`WithStepRefs`) — never restated. `core`'s own
 * `k3sInstall`/`k3sUninstall` are unchanged and produce byte-identical
 * `ActivityStep` output; these are purely additive.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { K3sInstallArgs, K3sUninstallArgs, K3sRole } from "./activities/k3s";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Run the pinned k3s installer against a reachable host — the fully typed
 * twin of core's `k3sInstall`. `opts` is {@link K3sInstallArgs} itself,
 * minus the positional `role` (`configFile` remains required). Defaults to
 * the `longInfra` profile.
 */
export const k3sInstall = (
  role: K3sRole,
  opts: WithStepRefs<Omit<K3sInstallArgs, "role">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("k3sInstall", { role, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Uninstall k3s from a reachable host — the fully typed twin of core's
 * `k3sUninstall`. `opts` is {@link K3sUninstallArgs} itself, minus the
 * positional `role`. Defaults to the `fastIdempotent` profile.
 */
export const k3sUninstall = (
  role: K3sRole,
  opts?: WithStepRefs<Omit<K3sUninstallArgs, "role">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("k3sUninstall", { role, ...args }, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};
