/**
 * Forgejo reconcile runner.
 *
 * A thin adapter over the provider-agnostic `runReconcile` / `Cycle` harness in
 * `@intentius/chant/reconcile` — it wires Forgejo's `diff` and a Forgejo-
 * appropriate guardrail set into the shared loop, and re-exports the harness
 * types so cycles import them from here.
 *
 * Guardrails: the removal cap (don't let a typo mass-delete) + rename-without-
 * loss (a `previously` alias collapses a delete+create into an update). The
 * member-floor / self-lockout guardrails are GitHub-flavored and omitted; add a
 * Forgejo equivalent later only if meaningful.
 */

import {
  runReconcile as coreRunReconcile,
  runGuardrailChecks,
  removalDeltaCap,
} from "@intentius/chant/reconcile";
import type { Cycle as CoreCycle, ReconcileResult, DiffOptions } from "@intentius/chant/reconcile";
import type { ForgejoClient } from "../auth/client.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";
import type { LiveOrgState } from "./live.js";
import { diff } from "./diff.js";

export { BudgetExhaustedError } from "@intentius/chant/reconcile";
export type {
  RateBudget,
  CycleResult,
  CycleError,
  DeferredWork,
  ReconcileResult,
} from "@intentius/chant/reconcile";

/** A Forgejo governance cycle — the shared `Cycle` specialized to warden's types. */
export type Cycle<TScope = unknown> = CoreCycle<ForgejoClient, OrgConfig, LiveOrgState, TScope>;

/** Options for warden's `runReconcile` (config-based). */
export interface RunReconcileOptions<TScope = unknown> {
  config: GovernanceConfig;
  client: ForgejoClient;
  cycles: Cycle<TScope>[];
  scope?: TScope;
  mode?: "dry-run" | "apply";
  diffOptions?: DiffOptions;
  allowGuardrailOverride?: boolean;
  requestBudget?: number;
  /** Max fraction of pre-existing entries deletable in one apply. Default 0.25. */
  removalDeltaCapFraction?: number;
}

/**
 * Run the Forgejo governance reconcile loop, delegating to the shared runner
 * with warden's `diff` (org name as scope id) and guardrails wired in.
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  const maxFraction = opts.removalDeltaCapFraction ?? 0.25;
  return coreRunReconcile<ForgejoClient, OrgConfig, LiveOrgState, TScope>({
    client: opts.client,
    scopes: opts.config.orgs,
    cycles: opts.cycles,
    scope: opts.scope,
    mode: opts.mode,
    diff: (scopeId, desired, live, dopts) => diff(scopeId, desired, live, dopts),
    guardrails: (changeSet) =>
      runGuardrailChecks(changeSet, [(resolved) => removalDeltaCap(resolved, { maxFraction })]),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });
}
