/**
 * Which rejections stop a gate (#5354).
 *
 * `chant reject <op> <gate>` records a rejection of the digest a gate waits
 * on (`../lifecycle/gate-rejection.ts`). At a stage's gate that digest is a
 * release's, so a rejection turns that release down at that stage. A
 * rejection that counts stops the gate before any approval is read: more
 * approvals never clear it. Only a new release, with a new digest, goes
 * through again.
 *
 * A rejection counts by the proof rules an approval of the same gate counts
 * by:
 *
 * - it is a person's, as only a person's approval counts toward a quorum;
 * - a gate whose `approval` mode is `sealed` counts only a rejection whose
 *   seal verifies against the signers at base, as it counts only sealed
 *   approvals. `ledger`, `pr-review` and `pull-request` take a plain
 *   `chant approve` line, so they take a plain `chant reject` line too;
 * - a gate the workspace's `identity.gates` names counts only a rejection
 *   that rule admits (signed, from its class);
 * - a gate with approval rules counts a rejection only from someone one of
 *   its rules would count as an approver: a rule with `proven` or `roles`
 *   counts only a proven approver, one holding a role it names.
 *
 * A rejection that does not count is listed with why, so the run says so.
 * Pure: no git, no clock.
 */

import { NEXT_RELEASE } from "../release-floors";
import { isModelAuthored } from "../lifecycle/gate-origin";
import { samePlanDigest } from "../lifecycle/plan-digest";
import { rejectionSealRefusal, type GateRejectionRecord } from "../lifecycle/gate-rejection";
import type { GateSigners } from "../lifecycle/gate-seal";
import { quorumRules, rolesOf, ruleAdmits, type GateQuorumSpec } from "./gate-quorum";
import type { GateApprovalSource } from "./op-waves";

/**
 * The first chant with `chant reject` (#5354): a rejection of the digest a
 * gate waits on, which stops a release at a pipeline stage's gate by the
 * proof rules the gate's approvals count by, and with approval rules that
 * combine in `all` and `any` groups, nested up to three deep, each rule and
 * group with a `name` the progress lines, the plan note and the ledger
 * show, a stage hold's `description`, and a `reject` comment command a
 * comment job records under the author's forge identity (`../ci-comment-reject.ts`).
 */
export const GATE_REJECTION_FLOOR = NEXT_RELEASE;

/** What a gate's rejections are judged by. */
export interface GateRejectionInput {
  gate: string;
  /** The digest the gate waits on: a release's at a stage's gate. */
  planDigest: string;
  /** The gate's environment: a stage's name. A rejection that names another environment is for another gate. */
  environment?: string;
  /** The release the gate binds. A rejection that names another release is for another release. */
  releaseDigest?: string;
  /** The gate's approval mode. Default `ledger`. */
  mode?: GateApprovalSource;
  /** The rules the gate takes, after its targets are applied. */
  quorum?: GateQuorumSpec;
  /** The signers and passkeys at base, which prove who signed a rejection. */
  signers: GateSigners;
  /** `.chant/trust.json`'s role grants at base. */
  roles: Readonly<Record<string, readonly string[]>>;
  /** The workspace's `identity.gates` rule for the gate, when one applies. */
  identity?: ((r: GateRejectionRecord) => string | null) | null;
}

/** What {@link gateRejections} found. */
export interface GateRejections {
  /** The rejections that stop the gate, oldest first. */
  standing: GateRejectionRecord[];
  /** Rejections of this digest that do not count, with why, oldest first. */
  ignored: { rejection: GateRejectionRecord; why: string }[];
}

/** Whether `r` rejects this gate's digest: its gate, digest, environment and release. */
export function rejectsDigest(r: GateRejectionRecord, input: Pick<GateRejectionInput, "gate" | "planDigest" | "environment" | "releaseDigest">): boolean {
  if (r.gate !== input.gate || !samePlanDigest(r.planDigest, input.planDigest)) return false;
  if (r.environment !== undefined && input.environment !== undefined && r.environment !== input.environment) return false;
  if (r.releaseDigest !== undefined && r.releaseDigest !== input.releaseDigest) return false;
  return true;
}

/** Why `r` does not count at the gate, or null when it does. */
export function rejectionRefusal(r: GateRejectionRecord, input: GateRejectionInput): string | null {
  if (r.approver?.kind === "agent" || (r.approver === undefined && isModelAuthored(r.origin))) {
    return `${r.rejectedBy} is an agent, and only a person's rejection counts, as only a person's approval counts`;
  }
  const sealWhy = r.seal !== undefined ? rejectionSealRefusal(input.signers, r) : "it is not signed";
  const proven = sealWhy === null;
  if (input.identity) {
    const why = input.identity(r);
    if (why !== null) return why;
  }
  if (input.mode === "sealed" && !proven) return `gate ${input.gate} counts only sealed approvals, so it counts only a sealed rejection (chant reject --sign), and ${sealWhy}`;
  const rules = quorumRules(input.quorum);
  if (rules.length === 0) return null;
  const judged = { proven, roles: proven ? rolesOf(r.rejectedBy, input.roles) : [] };
  if (rules.some((rule) => ruleAdmits(rule, judged))) return null;
  const roles = [...new Set(rules.flatMap((rule) => rule.roles ?? []))];
  return proven
    ? `no approval rule of gate ${input.gate} counts ${r.rejectedBy}: .chant/trust.json at base gives them none of ${roles.join(", ")}`
    : `every approval rule of gate ${input.gate} counts only a proven approver, so it counts only a sealed rejection (chant reject --sign), and ${sealWhy}`;
}

/** The rejections of the gate's digest, split into those that stop it and those that do not count. */
export function gateRejections(records: readonly GateRejectionRecord[], input: GateRejectionInput): GateRejections {
  const at = (r: GateRejectionRecord) => Date.parse(r.timestamp);
  const standing: GateRejectionRecord[] = [];
  const ignored: { rejection: GateRejectionRecord; why: string }[] = [];
  for (const r of [...records].sort((a, b) => at(a) - at(b))) {
    if (!rejectsDigest(r, input)) continue;
    const why = rejectionRefusal(r, input);
    if (why === null) standing.push(r);
    else ignored.push({ rejection: r, why });
  }
  return { standing, ignored };
}

/** The line a stopped gate prints for one rejection: who, when and why. */
export function rejectionLine(r: GateRejectionRecord): string {
  return `rejected by ${r.rejectedBy} at ${r.timestamp}${r.seal ? " (signed)" : ""}: ${r.reason}`;
}
