/**
 * Typed step-builder wrappers for this lexicon's activities (chant #1288
 * Stage 2 — "regenerate the step builders as fully typed wrappers"). Core
 * cannot import a lexicon's `*Args` types (lexicons depend on core, not the
 * other way around — see `packages/core/src/op/activity-contract.ts`'s module
 * doc for the same layering constraint on Stage 1's contracts), so a fully
 * typed `kubectlApply`/`waitForReady`/`ensureSecret` has to live beside the
 * `*Args` interface it derives from: here, next to `./activities/kubectl.ts`
 * etc. `opts`'s type in each wrapper below IS the activity's own `*Args`
 * interface (via `Omit`/`WithStepRefs`) — never a hand-restated mirror — so
 * `kubectlApply`/`waitForReady`/`ensureSecret`'s full option surface (the
 * dozen-plus cross-field options on `kubectlApply` that Stage 1's zod
 * contracts deliberately skipped rather than duplicate) is authoring-time
 * typed for free, and stays in sync with the implementation by construction.
 *
 * Every field also accepts a {@link StepOutputRef} in its place
 * ({@link WithStepRefs}, chant #1950) — a later step's args can consume an
 * earlier step's declared output.
 *
 * `core`'s own `kubectlApply`/`waitForReady`/`ensureSecret` (in
 * `@intentius/chant/op`, re-exported from `@intentius/chant-lexicon-temporal`
 * for lexicon-agnostic single-import convenience) are UNCHANGED and produce
 * byte-identical `ActivityStep` output for the same inputs — these are purely
 * additive. Deliberately not swapped into the temporal barrel: that would
 * make `@intentius/chant-lexicon-temporal` depend on this package (and on
 * helm, for `helmInstall`) at runtime, which is exactly the "a worker image
 * needs no kubectl binary" / "temporal stays product-agnostic" property the
 * `op/activities/index.ts` module docs across this repo call out on purpose
 * (activities were moved OUT of temporal into per-product lexicons for this
 * reason; the step-builder layer shouldn't reintroduce the coupling from the
 * other direction). An author who wants the typed surface imports it from
 * here — `@intentius/chant-lexicon-k8s` — which a project using `kubectlApply`
 * already depends on; existing `@intentius/chant-lexicon-temporal` imports
 * keep working exactly as before, opting in only if the import is changed.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { KubectlApplyArgs } from "./activities/kubectl";
import type { WaitForReadyArgs } from "./activities/wait-for-ready";
import type { EnsureSecretActivityArgs } from "./activities/ensure-secret";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Run `kubectl apply -f <manifest>` — the fully typed twin of core's
 * `kubectlApply` step-builder shortcut (chant #1288 Stage 2). `opts` is
 * {@link KubectlApplyArgs} itself (minus the positional `manifest`) — every
 * field `applyManifest` accepts, including `deleteMode`, `force`,
 * `fieldManager`, `documents`, is authoring-time typed here, not just the
 * subset a hand-written zod mirror would bother restating. Defaults to the
 * `longInfra` profile (override via `opts.profile`).
 */
export const kubectlApply = (
  manifest: string,
  opts?: WithStepRefs<Omit<KubectlApplyArgs, "manifest">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("kubectlApply", { manifest, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Poll a Kubernetes resource until it reports ready, driven by a data-only
 * readiness spec (CRD-aware; #365) — the fully typed twin of core's
 * `waitForReady`. `opts` is {@link WaitForReadyArgs} itself, minus the
 * positional `kind`/`name`. Defaults to the `k8sWait` profile.
 */
export const waitForReady = (
  kind: string,
  name: string,
  opts?: WithStepRefs<Omit<WaitForReadyArgs, "kind" | "name">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("waitForReady", { kind, name, ...args }, { profile: profile ?? "k8sWait", ...(id ? { id } : {}) });
};

/**
 * Ensure a `generated-once` secret exists in the target store (#1829) — the
 * fully typed twin of core's `ensureSecret`. `opts` is
 * {@link EnsureSecretActivityArgs} itself, minus the positional `name`/`keys`.
 */
export const ensureSecret = (
  name: string,
  keys: string[],
  opts?: WithStepRefs<Omit<EnsureSecretActivityArgs, "name" | "keys">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("ensureSecret", { name, keys, ...args }, { profile, ...(id ? { id } : {}) });
};
