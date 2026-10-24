/**
 * `workEvidence` (#2772): attach one piece of evidence to an acceptance
 * criterion of the work item the run holds the lease on.
 *
 * Meant for an Op that declares `workLease` (#2748), a steward's among them:
 * the builder passes the run's lease (`workLeaseOutput()`) as `lease`, and the
 * write goes through only while that lease is still the run's, under its
 * token. The rules are `attachWorkEvidence`'s (`../../workspace/work-evidence.ts`):
 * the criterion must be one the record lists, and a `manual` criterion is
 * refused, since the run holding the lease is the item's implementer.
 * A refusal fails the step with its code.
 */

import type { EvidenceResult, WorkAcceptance } from "../../workspace/work";
import type { OpsCitation } from "../../workspace/work-evidence-ops";

export interface WorkEvidenceArgs {
  /** The run's work lease: `workLeaseOutput()`, which the builder passes. */
  lease: { item: string; holder: string; token: string };
  /** The criterion the evidence is for, by id. */
  criterion: string;
  result: EvidenceResult;
  title: string;
  /** A public https:// link, or */
  url?: string;
  /** a workspace file, pinned by the hash of its bytes now, or */
  path?: string;
  /**
   * an ops result (#3171): a run, a deploy, a gate answer or a release plan
   * on the `chant/lifecycle` branch, verified against its ledger before the
   * entry is written. A cited run's outcome must agree with `result`.
   */
  ops?: OpsCitation;
  /** The work kind file, when the declaration names more than one with the item. */
  kind?: string;
  /** Where the workspace is found; the run's directory by default. */
  cwd?: string;
}

export interface WorkEvidenceResult {
  item: string;
  /** The work record, from the repository root. */
  path: string;
  evidence: Record<string, unknown>;
  acceptance: WorkAcceptance;
}

export async function workEvidence(args: WorkEvidenceArgs): Promise<WorkEvidenceResult> {
  const lease = args.lease;
  if (!lease || typeof lease.item !== "string" || typeof lease.holder !== "string" || typeof lease.token !== "string") {
    throw new Error("workEvidence runs under a work lease: pass the run's lease as `lease` (workLeaseOutput()) from an Op that declares workLease");
  }
  const { attachWorkEvidence } = await import("../../workspace/work-evidence");
  const out = await attachWorkEvidence({
    cwd: args.cwd ?? process.cwd(),
    item: lease.item,
    holder: lease.holder,
    token: lease.token,
    criterion: args.criterion,
    result: args.result,
    title: args.title,
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.ops !== undefined ? { ops: args.ops } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
  });
  if ("error" in out) throw new Error(`workEvidence refused for ${lease.item} ${args.criterion}: ${out.error.code}: ${out.error.message}`);
  console.log(`workEvidence: ${out.item} ${args.criterion} ${args.result} (${out.acceptance.met}/${out.acceptance.total} met)`);
  return { item: out.item, path: out.path, evidence: out.evidence, acceptance: out.acceptance };
}
