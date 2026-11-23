/**
 * Who a person-attributed record or gate approval names (#3163, ws-080).
 *
 * chant never authenticates a person (ws-052): hud, studio or behold signs a
 * person in and maps the session to one of the identities below, then passes
 * it to chant's write commands (`--by`, `--actor`). chant records what it is
 * given and says which form it is:
 *
 * - `signer`: a principal `.chant/allowed_signers` lists at base, or one with
 *   a passkey in `.chant/trust.json` (#4646). A seal made with that
 *   principal's key (`--sign`) or passkey (`--signature`) attests it.
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
import { admitApprover, RELEASE_GATE, type GateAdmissionRule } from "./identity-gate-rule";
import { admitRejecter } from "./identity-reject-rule";
import type { GateRejectionRecord } from "../lifecycle/gate-rejection";
import { classesOf, coreClassRegistry, roleGrants, type ClassRegistry } from "./principal-classes";
import type { ReasonCode } from "./reason-codes";
import { normalisePrincipal } from "./records";
import type { TrustPolicy } from "./trust/policy";
import type { SealedGateApproval } from "../lifecycle/gate-seal";
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
  // #4646: a principal with a passkey at base signs like one with a key.
  const listed = (s: { principal: string }) => normalisePrincipal(s.principal) === name;
  if (policy.active && (policy.signers.some(listed) || (policy.passkeys ?? []).some(listed))) return { principal, form: "signer", forge };
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
  /** Why a rejection (#5354) doesn't count at the gate, or null when it does: the same rule, over the rejection's seal. */
  refusesRejection(rejection: GateRejectionRecord): string | null;
}

/** What {@link gateAdmissionFrom} reads: the declaration, policy and classes at base, as `scopeSource` gives them. */
export interface GateRuleSource extends IdentitySource {
  classes: ClassRegistry;
  /** Where `scopeSource` read the declaration. Absent, as in a source built by hand, it counts as base. */
  from?: "base" | "working-tree" | null;
  /** The base `scopeSource` looked at, absent when there was none to look at. */
  base?: string;
}

/**
 * The declaration a gate's rule is read from (#5508): the one at base. When a
 * base exists and has no readable declaration, the working tree's is the
 * change being judged, so it is not read and no rule applies. With no base at
 * all (no `origin/HEAD`, `main` or `master`, and none named), the working
 * tree's still is: there is nothing reviewed to compare it with, and the
 * signers at base are empty then too.
 */
function ruleDeclaration(source: GateRuleSource): Declaration | null {
  if (source.from === "working-tree" && source.base !== undefined) return null;
  return source.declaration;
}

/** The code of {@link GateRuleNotice}. */
export const GATE_RULE_NOT_AT_BASE = "identity-gates-not-at-base";

/**
 * Why a gate the change itself names in `identity.gates` is judged without
 * that entry (#5508): the base has no declaration, so the entry takes effect
 * once the change merges, and until then the gate runs under the default
 * policy.
 */
export interface GateRuleNotice {
  code: typeof GATE_RULE_NOT_AT_BASE;
  gate: string;
  message: string;
}

const shortBase = (base: string) => (/^[0-9a-f]{40,64}$/.test(base) ? base.slice(0, 12) : base);

/**
 * The notice for `gate` when the base has no declaration and this change's
 * declaration names the gate in `identity.gates`, else null. What a gated
 * run and `chant approve` print beside a gate whose rule reads as absent.
 */
export function gateRuleNoticeFrom(source: GateRuleSource, gate: string): GateRuleNotice | null {
  return noticeFor(source, gate, "this change is gated under the default policy");
}

/** {@link gateRuleNoticeFrom} for the `release` entry a cut is judged by: the cut takes the default rule, which checks a signature alone. */
export function releaseRuleNoticeFrom(source: GateRuleSource): GateRuleNotice | null {
  return noticeFor(source, RELEASE_GATE, "a cut from it is judged under the default rule, which checks a signature alone");
}

function noticeFor(source: GateRuleSource, gate: string, meanwhile: string): GateRuleNotice | null {
  if (source.from !== "working-tree" || source.base === undefined) return null;
  if (!source.declaration?.identity?.gates[gate]) return null;
  return {
    code: GATE_RULE_NOT_AT_BASE,
    gate,
    message: `identity.gates.${gate} in this change takes effect after it merges: base ${shortBase(source.base)} has no chant.workspace.json, so ${meanwhile}`,
  };
}

/** {@link gateRuleNoticeFrom} for the workspace holding `cwd`, at `base` as {@link gateAdmission} reads. */
export function gateRuleNotice(cwd: string, gate: string, base?: string): GateRuleNotice | null {
  return gateRuleNoticeFrom(scopeSource(cwd, base), gate);
}

/**
 * The rule for `gate`, or null when the declaration at base names none or
 * there is no declaration at base (#5508): a change that adds the file is
 * not judged by the entry it adds. An
 * approval counts only when its seal verifies for its approver against the
 * signers at base and, when the rule names a class, the approver's role
 * grants at base put it in that class. A class no pinned package supplies
 * lets nothing through. The judge is {@link admitApprover}, which
 * `@intentius/chant/gate-decision` also judges with (#3862). The policy is
 * the one at base, never a returned work's copy.
 */
export function gateAdmissionFrom(source: GateRuleSource, gate: string): GateAdmission | null {
  const requirement = ruleDeclaration(source)?.identity?.gates[gate];
  if (!requirement) return null;
  const { policy, classes } = source;
  const rule = { gate, class: requirement.class, signers: policy, roles: roleGrants(policy), classes: classes.all() };
  return { requirement, refuses: (a) => admitApprover(rule, a), refusesRejection: (r) => admitRejecter(rule, r) };
}

/**
 * The rule a release cut is judged by (#4031): the declaration's
 * `identity.gates.release` entry with its class, read at base, or, when the
 * declaration names no `release` gate, a rule with no class, which checks a
 * cut's signature alone. `requirement` is null in that case, and a cut may
 * then be made unsigned. A base with no declaration names no `release` gate
 * either (#5508), whatever the working tree's declaration says.
 */
export function releaseRuleFrom(source: GateRuleSource): { requirement: SignedGate | null; rule: GateAdmissionRule } {
  const requirement = ruleDeclaration(source)?.identity?.gates[RELEASE_GATE] ?? null;
  const { policy, classes } = source;
  return { requirement, rule: { gate: RELEASE_GATE, class: requirement?.class ?? null, signers: policy, roles: roleGrants(policy), classes: classes.all() } };
}

/**
 * The rule for `gate` in the workspace holding `cwd`, read at base (the
 * target branch tip), or null when there is no declaration at base or it
 * names none. The working tree's declaration counts only when there is no
 * base at all (#5508).
 * What a run, `chant approve` and `workspace status` ask before counting an
 * approval. `base` names the commit to read at instead, as an op wave reads
 * every rule at its `--base` (#3841).
 */
export function gateAdmission(cwd: string, gate: string, base?: string): GateAdmission | null {
  return gateAdmissionFrom(scopeSource(cwd, base), gate);
}
