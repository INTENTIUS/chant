/**
 * The `identity.gates` rule as data and one pure function (#3862).
 *
 * A gate the declaration names under `identity.gates` passes only on an
 * approval sealed by a signer at base, from the class the gate names when it
 * names one (#3163, ws-080). chant's `gateAdmissionFrom` (`./identity.ts`)
 * builds a {@link GateAdmissionRule} from what `scopeSource` reads and judges
 * every approval with {@link admitApprover}. `@intentius/chant/gate-decision`
 * builds the same rule from a bare clone at a base commit
 * (`identityGateAdmissionAt`) and judges with the same function, so a tool
 * counts approvals as chant's wave gate does.
 *
 * The module imports node:crypto through `./trust/gate-seal.ts` and nothing
 * else: no zod, no ajv, no package loading, so it bundles small.
 */

import { GATE_SEAL_NAMESPACE, gateSealPayload, namespaceAllowed, verifySshSignatureWith, type SealedGateApproval } from "./trust/gate-seal";
import type { Signer } from "./trust/trust-files";

/** The core classes, in the order a principal's roles are tried; `human` holds no role and is the rest. */
export const CORE_PRINCIPAL_CLASSES = ["human", "agent", "runner", "service"] as const;
export type CorePrincipalClass = (typeof CORE_PRINCIPAL_CLASSES)[number];

export interface PrincipalClass {
  name: string;
  /** One line saying who is in the class. */
  description: string;
  /** The role whose grant at base puts a principal in the class, or null for `human`, the rest. */
  role: string | null;
  /** `core`, or the pin (package name or path) that supplies the class. */
  source: string;
}

export const CORE_CLASSES: readonly PrincipalClass[] = [
  { name: "human", description: "a principal holding none of the roles of another class", role: null, source: "core" },
  { name: "agent", description: "a principal holding the agent role, or a write naming an agent session", role: "agent", source: "core" },
  { name: "runner", description: "a principal holding the runner role, such as a CI job's signing identity", role: "runner", source: "core" },
  { name: "service", description: "a principal holding the service role", role: "service", source: "core" },
];

/** A class as the rule reads it: its name, and the role whose grant puts a principal in it (null for `human`). */
export type ClassGrant = Pick<PrincipalClass, "name" | "role">;

/** What an `identity.gates` gate is judged by, all read at base. */
export interface GateAdmissionRule {
  gate: string;
  /** The class the approver must be in, or null for any signer. */
  class: string | null;
  /** The signers file at base: its path, whether it exists, and its signers. */
  signers: { signersPath: string; active: boolean; signers: readonly Signer[] };
  /** The role grants at base (`.chant/trust.json` `roles`). */
  roles: Readonly<Record<string, readonly string[]>>;
  /** Every class the rule knows, core first, then domain classes in pin order. */
  classes: readonly ClassGrant[];
  /**
   * Why a class the rule does not know is unknown, for the refusal. Default
   * "no pinned package supplies", which is what chant says once it has read
   * every pin.
   */
  unknownClass?: string;
}

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();

/** Every class `principal`'s role grants put it in, in `classes` order: what `classesOf` in `./principal-classes.ts` answers. */
export function grantedClasses(classes: readonly ClassGrant[], roles: Readonly<Record<string, readonly string[]>>, principal: string | null): string[] {
  if (principal === null) return [];
  const name = normalise(principal);
  return classes.filter((c) => c.role !== null && (roles[c.role] ?? []).some((p) => normalise(p) === name)).map((c) => c.name);
}

/**
 * Why `a` does not count toward the gate, or null when it does. An approval
 * counts only when its seal verifies for its approver against the signers at
 * base and, when the rule names a class, the role grants at base put the
 * approver in it (`human`: in no other class). A class the rule does not
 * know lets nothing through.
 */
export function admitApprover(rule: GateAdmissionRule, a: SealedGateApproval): string | null {
  const { gate, signers } = rule;
  const want = rule.class;
  if (want !== null && !rule.classes.some((c) => c.name === want)) {
    return `identity.gates.${gate} names the class ${want}, which ${rule.unknownClass ?? "no pinned package supplies"}, so no approval can show it is in that class (known classes: ${rule.classes.map((c) => c.name).join(", ")})`;
  }
  if (!signers.active) return `gate ${gate} needs a signed approval, and there is no signers file (${signers.signersPath}) at base to check one against`;
  const seal = sealRefusal(gate, signers, a);
  if (seal !== null) return seal;
  if (want === null) return null;
  const granted = grantedClasses(rule.classes, rule.roles, a.resolvedBy);
  const inClass = want === "human" ? granted.length === 0 : granted.includes(want);
  return inClass ? null : `${a.resolvedBy} is not in the class ${want} that gate ${gate} needs: no role grant at base puts them there`;
}

/** The seal step, worded as `checkGateSeal` (`./trust/seal.ts`) words it against an active signers file at base. */
function sealRefusal(gate: string, signers: GateAdmissionRule["signers"], a: SealedGateApproval): string | null {
  const what = `the approval of gate ${a.gate} by ${a.resolvedBy}`;
  if (a.seal === undefined || a.seal === null) return `the approval by ${a.resolvedBy} is not signed; gate ${gate} needs chant approve --sign`;
  const seal = a.seal as { signer?: unknown; signature?: unknown };
  if (typeof seal !== "object" || Array.isArray(seal) || typeof seal.signer !== "string" || typeof seal.signature !== "string") {
    return `the seal on ${what} is malformed: it needs signer and signature`;
  }
  if (normalise(seal.signer) !== normalise(a.resolvedBy)) return `the seal on ${what} is by ${seal.signer}, and its approver is ${a.resolvedBy || "empty"}`;
  const where = `${signers.signersPath} at base`;
  const listed = signers.signers.filter((s) => normalise(s.principal) === normalise(a.resolvedBy));
  if (listed.length === 0) return `${a.resolvedBy} has no key in ${where}, so the seal can't count`;
  const keys = listed.filter((s) => namespaceAllowed(s.namespaces, GATE_SEAL_NAMESPACE)).map((s) => Buffer.from(s.key.split(" ")[1] ?? "", "base64"));
  const r = verifySshSignatureWith(seal.signature, gateSealPayload(a), GATE_SEAL_NAMESPACE, keys);
  return r.ok ? null : `the seal does not verify for ${a.resolvedBy} against ${where}: ${r.reason}`;
}
