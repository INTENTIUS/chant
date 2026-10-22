/**
 * Resume the job that waits at a gate (#3683). The forge calls,
 * {@link resumeGateRun} and {@link resumeTokenFromEnv}, live in
 * `../gate-resume-run.ts`, which bundles without the workspace code (#3854),
 * and are re-exported here so `@intentius/chant/op/gate-resume` keeps working.
 * This module adds {@link resolutionAnswering}, which decides whether an
 * approval answers a pending fact the way a run decides the gate, and so reads
 * `./gate`'s quorum rules.
 */

import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { latestResolutionForPlan } from "../lifecycle/gate-ledger";
import { humanQuorumSince, tallyGateApprovals } from "./gate";
import type { GateQuorumJudge } from "./gate-quorum";

export {
  isGateRunLocator,
  resolveGateRunLocator,
  resumeGateRun,
  resumeTokenFromEnv,
  type GateResumeOutcome,
  type GateRunLocator,
  type ResumeGateRunOptions,
} from "../gate-resume-run";

/**
 * The resolution that answers `standing`, read the way a run decides the gate
 * (the plan, the environment, the quorum), or undefined. `pending` is the
 * gate ledger's pending facts, which place the human quorum's anchor (#3206);
 * without them it is `standing` itself. A workspace's
 * `identity.gates` rule is not applied here: the resumed job applies it, and
 * waits again when the approval does not count. `judge` proves approvers
 * for approval rules that name roles (#4290); absent, none is proven.
 */
export function resolutionAnswering(
  resolutions: readonly GateResolutionRecord[],
  standing: PendingGateRecord,
  pending: readonly PendingGateRecord[] = [standing],
  judge?: GateQuorumJudge,
): GateResolutionRecord | undefined {
  const env = standing.environment;
  const mine = resolutions.filter((r) => env === undefined || r.environment === env);
  if (standing.approval) {
    const tally = tallyGateApprovals(mine, standing.gate, standing.timestamp, standing.planDigest, standing.approval, humanQuorumSince(pending, standing), judge);
    if (tally.permit) return tally.permit;
    return tally.met ? tally.counted[tally.counted.length - 1] : undefined;
  }
  return latestResolutionForPlan(mine, standing.gate, standing.timestamp, standing.planDigest).resolution;
}
