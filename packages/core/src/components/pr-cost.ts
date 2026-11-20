/**
 * The cost estimate on the pull-request path (#5334): `ci.cost` in the
 * workspace declaration, read at the base the job measures the change from,
 * run by `chant components pr-plan` and `pr-apply` over each planned
 * member's plan document (`artifact.planJson` of `terraform-apply` and
 * `pulumi-up`). The record is `../cost-estimate.ts`'s: the report and the
 * note carry it as `cost`, and the policy reads it as `input.cost`.
 *
 * Reading it at base means a change cannot raise its own `approveAbove` or
 * drop the estimate that would ask for an approval. Like the policy, a base
 * that cannot be read while the checkout names `ci.cost` stops the job.
 */

import { readDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { locateWorkspace } from "../workspace/which-chant";
import { estimateCosts, type CostEstimate, type CostEstimateExec, type CostEstimateSettings, type CostRun } from "../cost-estimate";
import type { PrPlanSet } from "./pr-run";

/** `ci.cost` as read at base. */
export interface PrLoopCost {
  /** Absent when the declaration at base sets none. */
  settings?: CostEstimateSettings;
  base: string;
  /** A line for the log when no estimate runs because the base has no declaration. */
  note?: string;
}

function checkoutNamesCost(cwd: string): boolean {
  try {
    return readDeclaration(locateWorkspace(cwd).tree).ci?.cost !== undefined;
  } catch {
    return false;
  }
}

/** The estimate a pull-request job in `cwd` runs, from the declaration at `base`. Throws when the base cannot be read and the checkout names one. */
export function prLoopCostAt(cwd: string, base: string): PrLoopCost {
  try {
    const settings = readDeclaration(locateWorkspace(cwd, base).tree).ci?.cost;
    return settings ? { base, settings } : { base };
  } catch (err) {
    const missing = err instanceof WorkspaceReadError && (err.code === "declaration-missing" || err.code === "not-a-git-repository");
    const why = err instanceof Error ? err.message : String(err);
    if (checkoutNamesCost(cwd)) {
      if (missing) return { base, note: `ci.cost: the base ${base.slice(0, 12)} has no workspace declaration, so the estimate this change declares runs once it merges` };
      throw new Error(`ci.cost is read from the workspace declaration at ${base.slice(0, 12)}, and it could not be read (${why}), so the plan cannot be priced`);
    }
    return { base };
  }
}

/** The members of a planned set as the estimator takes them: each planned member with its capability's artifact, empty when its plan changes nothing. */
export function prCostRuns(set: Pick<PrPlanSet, "doc" | "members" | "plans">): CostRun[] {
  const changes = new Set(set.doc.entries.map((e) => e.member));
  return set.members
    .filter((m) => m.status === "planned" || m.status === "applied")
    .map((m) => ({ member: m.member, artifact: set.plans[m.component]?.[m.member], empty: !changes.has(m.member) }));
}

/** Price a planned set under `ci.cost` at base. Undefined when the base sets none. */
export function estimatePrSet(read: PrLoopCost, set: Pick<PrPlanSet, "doc" | "members" | "plans">, cwd: string, exec?: CostEstimateExec): CostEstimate | undefined {
  if (!read.settings) return undefined;
  return estimateCosts(read.settings, prCostRuns(set), cwd, exec);
}
