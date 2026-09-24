/**
 * The warning a release ahead of environment- and plan-bound component gate
 * approvals (chant #2574).
 *
 * A component gate approval is keyed by the component and the gate name only,
 * so an approval given for one environment, or for one deploy, can pass the
 * same gate later on another environment or on a promote or rollback. The
 * next release binds each approval to the environment and the plan digest it
 * was given for, the way Op gates bind a plan since #2300, and refuses an
 * approval that records neither.
 *
 * This release only says so. When a component gate passes on an approval that
 * records no plan, the driver prints one warning per component and gate, per
 * process. The decision itself is unchanged.
 */

import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { approveCommand } from "../op/gate";

/** `component\0gate` pairs already warned about in this process. */
const warned = new Set<string>();

/** Forget which gates were warned about. For tests. */
export function resetUnboundGateApprovalWarnings(): void {
  warned.clear();
}

/**
 * Warn once for `component`'s `gate` when the approval that just passed it in
 * `env` records no plan. Returns whether a warning was printed.
 */
export function warnOnUnboundComponentApproval(
  component: string,
  gate: string,
  env: string,
  resolution: GateResolutionRecord,
): boolean {
  if (resolution.planDigest !== undefined) return false;
  const key = `${component}\0${gate}`;
  if (warned.has(key)) return false;
  warned.add(key);
  console.warn(
    `[chant] warning: gate "${gate}" on component "${component}" passed in "${env}" on an approval by ` +
      `${resolution.resolvedBy} at ${resolution.timestamp} that records no environment and no plan. ` +
      "From the next chant release, a component gate approval counts only for the environment and plan " +
      "digest it was given for, and approvals recorded before then are refused. After upgrading, run the " +
      `deploy again and approve the gate it stops at with \`${approveCommand(component, gate)}\`. ` +
      "See https://github.com/INTENTIUS/chant/issues/2574",
  );
  return true;
}
