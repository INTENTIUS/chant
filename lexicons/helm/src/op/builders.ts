/**
 * Typed step-builder wrappers for this lexicon's `helmInstall` activity
 * (chant #1288 Stage 2 — "regenerate the step builders as fully typed
 * wrappers"). Core cannot import a lexicon's `*Args` types (lexicons depend
 * on core, not the other way around), so a fully typed `helmInstall` /
 * `helmInstallPinned` has to live beside {@link HelmInstallArgs} — here,
 * next to `./activities/helm.ts`. `opts`'s type in each wrapper below IS
 * `HelmInstallArgs` itself (via `Omit`/`WithStepRefs`) — never a
 * hand-restated mirror — so the option surface Stage 1's zod contracts
 * deliberately skipped (`capabilityProfile`, `set`, `deleteMode`-adjacent
 * cross-field options) is authoring-time typed for free.
 *
 * Every field also accepts a {@link StepOutputRef} in its place
 * ({@link WithStepRefs}, chant #1950).
 *
 * `core`'s own `helmInstall`/`helmInstallPinned` (in `@intentius/chant/op`,
 * re-exported from `@intentius/chant-lexicon-temporal`) are UNCHANGED and
 * produce byte-identical `ActivityStep` output for the same inputs — these
 * are purely additive. Deliberately not swapped into the temporal barrel
 * (see `lexicons/k8s/src/op/builders.ts`'s module doc for why: it would make
 * temporal depend on this package at runtime, undoing the product-agnostic
 * split #809 did). An author who wants the typed surface imports it from
 * here — `@intentius/chant-lexicon-helm` — which a project using
 * `helmInstall` already depends on.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { HelmInstallArgs } from "./activities/helm";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Deploy a helm release — the fully typed twin of core's `helmInstall`.
 * `opts` is {@link HelmInstallArgs} itself, minus the positional `name`/
 * `chart`. Defaults to the `longInfra` profile.
 */
export const helmInstall = (
  name: string,
  chart: string,
  opts?: WithStepRefs<Omit<HelmInstallArgs, "name" | "chart">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("helmInstall", { name, chart, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Deploy a recorded pinned render by its `sha256:` content digest (#1242) —
 * the fully typed twin of core's `helmInstallPinned`. `opts` is
 * {@link HelmInstallArgs} itself, minus the positional `name`/
 * `contentDigest`. Defaults to the `longInfra` profile.
 */
export const helmInstallPinned = (
  name: string,
  contentDigest: string,
  opts?: WithStepRefs<Omit<HelmInstallArgs, "name" | "contentDigest">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("helmInstall", { name, contentDigest, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};
