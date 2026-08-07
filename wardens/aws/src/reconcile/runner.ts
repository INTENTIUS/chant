/**
 * AWS reconcile runner. No provider-specific loop logic — a thin adapter over
 * `@intentius/chant/reconcile` wiring the AWS diff and guardrails. One scope:
 * the organization itself (scope id "organization").
 *
 * Guardrails: the shared removal-delta cap plus the cloud-specific set —
 * root-SCP floor (never drop the last SCP guarding the root) and the OU
 * deletion cap. The break-glass-admin guardrail lands with the
 * identity-assignment cycle (#792 follow-up).
 */

import {
  runReconcile as coreRunReconcile,
  runGuardrailChecks,
  removalDeltaCap,
  type Cycle as CoreCycle,
  type DiffOptions,
  type GuardrailResult,
  type ReconcileResult,
} from "@intentius/chant/reconcile";
import type { AwsClient } from "../auth/client.js";
import type { AwsGovernanceConfig } from "../config/types.js";
import { diff } from "./diff.js";
import { runAwsGuardrails } from "./guardrails.js";
import type { LiveOrgState } from "./live.js";

export { BudgetExhaustedError } from "@intentius/chant/reconcile";
export type {
  RateBudget,
  CycleResult,
  CycleError,
  DeferredWork,
  ReconcileResult,
} from "@intentius/chant/reconcile";

/** An AWS governance cycle — the shared `Cycle` specialized to warden's types. */
export type Cycle<TScope = unknown> = CoreCycle<AwsClient, AwsGovernanceConfig, LiveOrgState, TScope>;

export const ORGANIZATION_SCOPE = "organization";

export interface RunReconcileOptions<TScope = unknown> {
  config: AwsGovernanceConfig;
  client: AwsClient;
  cycles: Cycle<TScope>[];
  scope?: TScope;
  mode?: "dry-run" | "apply";
  diffOptions?: DiffOptions;
  allowGuardrailOverride?: boolean;
  requestBudget?: number;
  /** Max fraction of pre-existing entries deletable in one apply. Default 0.25. */
  removalDeltaCapFraction?: number;
}

export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  const maxFraction = opts.removalDeltaCapFraction ?? 0.25;

  return coreRunReconcile<AwsClient, AwsGovernanceConfig, LiveOrgState, TScope>({
    client: opts.client,
    scopes: { [ORGANIZATION_SCOPE]: opts.config },
    cycles: opts.cycles,
    scope: opts.scope,
    mode: opts.mode,
    diff: (scopeId, desired, live) => diff(scopeId, desired, live),
    guardrails: (changeSet, live): GuardrailResult => {
      const aws = runAwsGuardrails(changeSet, live);
      const shared = runGuardrailChecks(changeSet, [(resolved) => removalDeltaCap(resolved, { maxFraction })]);
      if (aws.ok && shared.ok) return { ok: true };
      return {
        ok: false,
        diagnostics: [...(aws.ok ? [] : aws.diagnostics), ...(shared.ok ? [] : shared.diagnostics)],
      };
    },
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });
}
