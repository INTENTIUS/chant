/**
 * Who a person-attributed record or gate approval names (#3163, ws-080).
 *
 * chant never authenticates a person (ws-052): hud, studio or behold signs a
 * person in and maps the session to one of the identities below, then passes
 * it to chant's write commands (`--by`, `--actor`). chant records what it is
 * given and says which form it is:
 *
 * - `signer`: a principal `.chant/allowed_signers` lists at base. A seal made
 *   with that principal's key (`--sign`) attests it.
 * - `forge`: a forge identity, `github:<login>`, `gitlab:<login>`, or
 *   `<forge>@<host>:<login>` (forgejo, gitea, or a self-hosted github or
 *   gitlab). The surface that signed the person in vouches for it; nothing
 *   here checks it, and only a seal verified against the signers at base
 *   attests it. The signers file and the role grants name people this way, so
 *   one string is the person in the record, the key list and the classes.
 * - `role`: a principal holding the agent, runner or service role at base, or
 *   listed by a declared agent session: not a person, and named by a grant an
 *   admin controls.
 * - `name`: anything else, such as a hud roster name or `$USER`.
 *
 * The declaration's `identity` block, read at base, turns this into rules:
 * `attribution: "identified"` refuses a `name` on every person-attributed
 * write, and `gates.<gate>` lets a gate of that name pass only on an approval
 * sealed by a signer, from a class when it names one.
 */

import type { Declaration, SignedGate } from "./declaration";
import { classesOf, coreClassRegistry, principalClass, type ClassRegistry } from "./principal-classes";
import type { ReasonCode } from "./reason-codes";
import { normalisePrincipal } from "./records";
import type { TrustPolicy } from "./trust/policy";
import { checkGateSeal, type SealedGateApproval } from "./trust/seal";
import { scopeSource } from "./write-scope";

/** The forges a forge identity can name. */
export const FORGES = ["github", "gitlab", "forgejo", "gitea"] as const;
export type Forge = (typeof FORGES)[number];

/** The host a forge identity means when it names none. Forgejo and gitea have no default: name the host. */
const DEFAULT_HOST: Record<Forge, string | null> = { github: "github.com", gitlab: "gitlab.com", forgejo: null, gitea: null };

/** A person's account on a forge. */
export interface ForgeIdentity {
  forge: Forge;
  /** Lower-cased, such as `github.com` or `codeberg.org`. */
  host: string;
  /** Lower-cased: the forges compare logins without case. */
  login: string;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const FORGE_PRINCIPAL = new RegExp(`^(${FORGES.join("|")})(?:@(${LABEL}(?:\\.${LABEL})+))?:([a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9_])?)$`);

/**
 * Read `principal` as a forge identity, or null when it is not one. Case and
 * surrounding space are folded as {@link normalisePrincipal} folds them.
 */
export function parseForgeIdentity(principal: string): ForgeIdentity | null {
  const m = FORGE_PRINCIPAL.exec(normalisePrincipal(principal));
  if (!m) return null;
  const forge = m[1] as Forge;
  const host = m[2] ?? DEFAULT_HOST[forge];
  if (host === null) return null;
  return { forge, host, login: m[3] };
}

/** The principal string of a forge identity: `<forge>:<login>` on the forge's default host, else `<forge>@<host>:<login>`. */
export function forgePrincipal(id: ForgeIdentity): string {
  return id.host === DEFAULT_HOST[id.forge] ? `${id.forge}:${id.login}` : `${id.forge}@${id.host}:${id.login}`;
}

export type IdentityForm = "signer" | "forge" | "role" | "name";

export interface Identified {
  principal: string;
  form: IdentityForm;
  /** Set whenever the principal reads as a forge identity, whatever its form. */
  forge: ForgeIdentity | null;
}

const NON_PERSON_CLASSES = new Set(["agent", "runner", "service"]);

/**
 * What `principal` is, under the policy and declaration read at base. A
 * principal the signers file lists is a `signer` even when it is also a
 * forge identity, since a seal can attest it.
 */
export function identify(principal: string, policy: TrustPolicy, declaration: Declaration | null = null): Identified {
  const name = normalisePrincipal(principal);
  const forge = parseForgeIdentity(principal);
  if (policy.active && policy.signers.some((s) => normalisePrincipal(s.principal) === name)) return { principal, form: "signer", forge };
  if (forge) return { principal, form: "forge", forge };
  const session = (declaration?.agents ?? []).some((a) => a.principals.some((p) => normalisePrincipal(p) === name));
  if (session || classesOf(coreClassRegistry(), policy, principal).some((c) => NON_PERSON_CLASSES.has(c))) return { principal, form: "role", forge: null };
  return { principal, form: "name", forge: null };
}

/** Why a write naming a person was refused. Closed. */
export const IDENTITY_CODES = ["principal-unidentified"] as const satisfies readonly ReasonCode[];
export type IdentityCode = (typeof IDENTITY_CODES)[number];

export class IdentityError extends Error {
  readonly code: IdentityCode = "principal-unidentified";
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** What {@link refuseUnidentified} reads: the declaration and policy at base, as `scopeSource` gives them. */
export interface IdentitySource {
  declaration: Declaration | null;
  policy: TrustPolicy;
}

/**
 * Refuse a person-attributed write that names someone by a bare name, when
 * the declaration at base sets `identity.attribution` to `identified`.
 * `flag` names where the name came from (`--by`, `--actor`). A write in a
 * declared agent session (`CHANT_AGENT`) names the session, not a person,
 * and is not judged here. Throws an {@link IdentityError}.
 */
export function refuseUnidentified(source: IdentitySource, names: readonly string[], flag: string, opts: { agent?: string | null } = {}): void {
  if (source.declaration?.identity?.attribution !== "identified") return;
  if (opts.agent !== undefined && opts.agent !== null && source.declaration.agents.some((a) => a.name === opts.agent)) return;
  for (const name of names) {
    if (identify(name, source.policy, source.declaration).form !== "name") continue;
    throw new IdentityError(
      `${flag} ${JSON.stringify(name)} names no identity the workspace can check: chant.workspace.json at base sets identity.attribution to identified, so a person is named by a forge identity (github:<login>, gitlab:<login>, or <forge>@<host>:<login>) or by a principal ${source.policy.signersPath} lists at base`,
    );
  }
}

/** A gate approval as the rule judges it: the resolution line's own fields. */
export type GateApprovalLike = SealedGateApproval;

/** A gate the declaration names in `identity.gates`, and the judge for its approvals. */
export interface GateAdmission {
  requirement: SignedGate;
  /** Why `approval` doesn't count toward the gate, or null when it does. */
  refuses(approval: GateApprovalLike): string | null;
}

/** What {@link gateAdmissionFrom} reads: the declaration, policy and classes at base, as `scopeSource` gives them. */
export interface GateRuleSource extends IdentitySource {
  classes: ClassRegistry;
}

/**
 * The rule for `gate`, or null when the declaration at base names none. An
 * approval counts only when its seal verifies for its approver against the
 * signers at base and, when the rule names a class, the approver's role
 * grants at base put it in that class. A class no pinned package supplies
 * lets nothing through.
 */
export function gateAdmissionFrom(source: GateRuleSource, gate: string): GateAdmission | null {
  const requirement = source.declaration?.identity?.gates[gate];
  if (!requirement) return null;
  const { policy, classes } = source;
  return {
    requirement,
    refuses(a) {
      const want = requirement.class;
      if (want !== null && classes.get(want) === undefined) {
        return `identity.gates.${gate} names the class ${want}, which no pinned package supplies, so no approval can show it is in that class (known classes: ${classes.names().join(", ")})`;
      }
      if (!policy.active) return `gate ${gate} needs a signed approval, and there is no signers file (${policy.signersPath}) at base to check one against`;
      const seal = checkGateSeal(policy, a);
      if (seal.attested !== true) return a.seal === undefined || a.seal === null ? `the approval by ${a.resolvedBy} is not signed; gate ${gate} needs chant approve --sign` : seal.message;
      if (want === null) return null;
      const inClass = want === "human" ? principalClass(policy, a.resolvedBy, classes) === "human" : classesOf(classes, policy, a.resolvedBy).includes(want);
      return inClass ? null : `${a.resolvedBy} is not in the class ${want} that gate ${gate} needs: no role grant at base puts them there`;
    },
  };
}

/**
 * The rule for `gate` in the workspace holding `cwd`, read at base (the
 * target branch tip), or null when there is no declaration or it names none.
 * What a run, `chant approve` and `workspace status` ask before counting an
 * approval.
 */
export function gateAdmission(cwd: string, gate: string): GateAdmission | null {
  return gateAdmissionFrom(scopeSource(cwd), gate);
}
