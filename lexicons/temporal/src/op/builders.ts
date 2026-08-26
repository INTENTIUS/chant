/**
 * Typed step-builder wrappers for this lexicon's own activities (chant #1288
 * Stage 2 — "regenerate the step builders as fully typed wrappers"). Unlike
 * `kubectlApply`/`helmInstall` (typed in the k8s/helm lexicons themselves —
 * see `lexicons/k8s/src/op/builders.ts`'s module doc for why), the activities
 * here — `chantBuild`, `shellCmd`, `waitForStack`, `lifecycleSnapshot`,
 * `chantTeardown`, `envTeardown`, `httpCheck`, `policyGate` — are genuinely
 * Temporal-native/product-agnostic, so this package already has both halves:
 * the activity's own `*Args` interface (`./activities/*.ts`) and the
 * step-builder machinery (`@intentius/chant/op`). `opts`'s type in each
 * wrapper below IS the activity's own `*Args` interface (via `Omit`/
 * `WithStepRefs`) — never a hand-restated mirror.
 *
 * Because there's no cross-package layering problem for these, this module
 * REPLACES (not adds alongside) the corresponding entries this lexicon's
 * `src/index.ts` used to re-export from `@intentius/chant/op` — same names,
 * same import path (`@intentius/chant-lexicon-temporal`), so an existing
 * `import { build, waitForStack } from "@intentius/chant-lexicon-temporal"`
 * call site gains authoring-time types with zero change. Each wrapper is
 * verified (`builders.test.ts`) to produce a byte-identical `ActivityStep`
 * to core's original builder for every input the original accepted —
 * `policyGate`'s fixed `policyCheck` profile and `teardown`'s fixed
 * `longInfra` profile (neither overridable in the original) are preserved
 * exactly, not loosened.
 *
 * Every field also accepts a {@link StepOutputRef} in its place
 * ({@link WithStepRefs}, chant #1950), and every wrapper takes an optional
 * `id` (routed to the step's `id`, not into `args`) so `.out` (chant #1290)
 * works even where the original builder had no way to name the step at all
 * (`lifecycleSnapshot`, `teardown`) — additive, since omitting `id` behaves
 * exactly as before.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { ChantBuildArgs } from "./activities/build";
import type { ShellCmdArgs } from "./activities/shell";
import type { WaitForStackArgs } from "./activities/wait";
import type { LifecycleSnapshotArgs } from "./activities/lifecycle";
import type { ChantTeardownArgs } from "./activities/teardown";
import type { EnvTeardownArgs } from "./activities/env-teardown";
import type { HttpCheckArgs } from "./activities/http-check";
import type { PolicyGateArgs } from "./activities/policy";

/** Extra opts every wrapper below accepts alongside its activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Run an npm build script in the given project directory — the fully typed
 * twin of core's `build`. `opts` is {@link ChantBuildArgs} itself, minus the
 * positional `path`.
 */
export const build = (
  path: string,
  opts?: WithStepRefs<Omit<ChantBuildArgs, "path">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("chantBuild", { path, ...args }, { ...(profile ? { profile } : {}), ...(id ? { id } : {}) });
};

/**
 * Run an arbitrary shell command — the fully typed twin of core's `shell`.
 * `opts` is {@link ShellCmdArgs} itself, minus the positional `cmd` — this
 * includes `cwd`, which core's untyped `shell` builder could never pass
 * through (its `opts` type only destructured `env`/`profile`); the extra
 * coverage is additive, verified identical to the original for the fields it
 * did support (`cmd`, `env`, `profile`).
 */
export const shell = (
  cmd: string,
  opts?: WithStepRefs<Omit<ShellCmdArgs, "cmd">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("shellCmd", { cmd, ...args }, { ...(profile ? { profile } : {}), ...(id ? { id } : {}) });
};

/**
 * Poll until a Kubernetes Deployment/StatefulSet is fully rolled out — the
 * fully typed twin of core's `waitForStack`. `opts` is {@link WaitForStackArgs}
 * itself, minus the positional `name`. Defaults to the `k8sWait` profile.
 */
export const waitForStack = (
  name: string,
  opts?: WithStepRefs<Omit<WaitForStackArgs, "name">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("waitForStack", { name, ...args }, { profile: profile ?? "k8sWait", ...(id ? { id } : {}) });
};

/**
 * Take a chant lifecycle snapshot for the given environment — the fully
 * typed twin of core's `lifecycleSnapshot`. {@link LifecycleSnapshotArgs} has
 * only `env`, which is positional here (as in the original), so there is
 * nothing left for an opts bag except `id` (for `.out` — the original had no
 * way to name this step at all).
 */
export const lifecycleSnapshot = (env: string, opts?: { id?: string }): NamedActivityStep =>
  activity("lifecycleSnapshot", { env }, opts?.id ? { id: opts.id } : undefined);

/**
 * Run `chant teardown` in the given project directory — the fully typed twin
 * of core's `teardown`. Uses the fixed `longInfra` profile, exactly as the
 * original (not overridable). {@link ChantTeardownArgs} has only `path`
 * (positional), so `opts` is just `id` (for `.out`).
 */
export const teardown = (path: string, opts?: { id?: string }): NamedActivityStep =>
  activity("chantTeardown", { path }, { profile: "longInfra", ...(opts?.id ? { id: opts.id } : {}) });

/**
 * Tear down one environment's marker-owned resources — the fully typed twin
 * of core's `envTeardown`. `opts` is {@link EnvTeardownArgs} itself, minus
 * the positional `env` (so `confirmProd`, `path` are typed, not just
 * reachable through an untyped bag). Defaults to the `longInfra` profile.
 */
export const envTeardown = (
  env: string,
  opts?: WithStepRefs<Omit<EnvTeardownArgs, "env">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("envTeardown", { env, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/**
 * Assert an HTTP endpoint responds as expected — the fully typed twin of
 * core's `httpCheck`. `opts` is {@link HttpCheckArgs} itself, minus the
 * positional `url`. Defaults to the `fastIdempotent` profile.
 */
export const httpCheck = (
  url: string,
  opts?: WithStepRefs<Omit<HttpCheckArgs, "url">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("httpCheck", { url, ...args }, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};

/**
 * Gate an apply on organizational policy — the fully typed twin of core's
 * `policyGate`. `opts` is {@link PolicyGateArgs} itself (both fields
 * optional, so there is no positional arg). Uses the fixed `policyCheck`
 * profile, exactly as the original (single-attempt, not overridable); `path`
 * defaults to `"."` exactly as the original.
 */
export const policyGate = (opts?: WithStepRefs<PolicyGateArgs> & { id?: string }): NamedActivityStep => {
  const path = (opts?.path as PolicyGateArgs["path"] | undefined) ?? ".";
  const env = opts?.env;
  return activity(
    "policyGate",
    { path, ...(env !== undefined ? { env } : {}) },
    { profile: "policyCheck", ...(opts?.id ? { id: opts.id } : {}) },
  );
};
