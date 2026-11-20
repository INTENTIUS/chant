/**
 * The `identity.gates` rule for a rejection (#5354), apart from
 * `./identity-gate-rule.ts` so the gate-decision bundle, which judges
 * approvals only, stays small.
 */

import { rejectionSealRefusal, type GateRejectionRecord } from "../lifecycle/gate-rejection";
import { classRefusal, unknownClassRefusal, type GateAdmissionRule } from "./identity-gate-rule";

/**
 * Why a rejection (#5354) does not count at the gate, or null when it does:
 * the rule {@link admitApprover} applies to an approval, with the seal
 * checked over the rejection's own bytes. A gate that counts only sealed
 * approvals from a class counts only sealed rejections from it.
 */
export function admitRejecter(rule: GateAdmissionRule, r: GateRejectionRecord): string | null {
  const unknown = unknownClassRefusal(rule, "rejection");
  if (unknown !== null) return unknown;
  if (!rule.signers.active) return `gate ${rule.gate} needs a signed rejection, and there is no signers file (${rule.signers.signersPath}) at base to check one against`;
  const seal = rejectionSealRefusal(rule.signers, r);
  if (seal !== null) return seal;
  return classRefusal(rule, r.rejectedBy);
}

