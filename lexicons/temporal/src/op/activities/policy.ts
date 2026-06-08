import { ApplicationFailure } from "@temporalio/common";
import { evaluateProjectPolicies } from "@intentius/chant/lint/policy";

export interface PolicyGateArgs {
  /** Project/source directory to build and evaluate. Default ".". */
  path?: string;
  /** Environment for policy evaluation (falls back to `ownership.env`). */
  env?: string;
}

/**
 * Gate an apply on organizational policy: build the project, run its
 * `lint.policies` over the resolved resources, and **block** on any violation.
 * Place it as a step before the apply phase — a violation fails the workflow
 * (non-retryable; the `policyCheck` profile is single-attempt) so nothing is
 * applied. A clean evaluation passes through.
 *
 * Runs in both executors — it is a plain activity, not a Temporal gate.
 */
export async function policyGate(args: PolicyGateArgs, _signal?: AbortSignal): Promise<void> {
  const { violations, env } = await evaluateProjectPolicies({ path: args.path ?? ".", env: args.env });
  if (violations.length > 0) {
    const summary = violations
      .map((v) => `[${v.checkId}]${v.entity ? ` ${v.entity}:` : ""} ${v.message}`)
      .join("; ");
    throw ApplicationFailure.nonRetryable(
      `Organizational policy blocked the apply — ${violations.length} violation(s): ${summary}`,
      "PolicyViolation",
    );
  }
  console.log(`[policy] ${env ? `env=${env}: ` : ""}no violations — apply may proceed`);
}
