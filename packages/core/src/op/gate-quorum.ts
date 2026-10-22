/**
 * Approval rules (#4290): a gate's quorum as a list of rules, each with the
 * targets it covers, how many approvers it needs, the roles that count, and
 * whether one of them must not be the change's author.
 *
 *   quorum: [
 *     { targets: ["prod-*"], count: 2, roles: ["platform"], notAuthor: true },
 *     { count: 1 },
 *   ]
 *
 * A gate takes every rule whose `targets` glob matches one of its targets
 * (a rule with no `targets` covers every target), and passes once each rule
 * it takes is met by distinct human approvers of its plan. A gate that takes
 * no rule needs one human approval, the rule every gate had before.
 *
 * Roles come from `.chant/trust.json` at base (`roles`: role name to the
 * principals that hold it), never from the approver's own claim. An
 * approver counts toward `roles`, and as someone who is not the author, only
 * when the approval proves who they are: a seal that verifies against the
 * signers file at base, or under `pr-review` the forge review of the merged
 * pull request. The judge of a gate decides that ({@link GateQuorumJudge});
 * with none, no approval proves anything, so a rule naming roles or
 * `notAuthor` is never met.
 *
 * This module is pure: no git, no file reads, no package, so
 * `@intentius/chant/gate-decision` bundles it. The judge is built by the
 * caller from the trust policy it read at base ({@link trustQuorumJudge}).
 */

import { gateSealRefusal, type GateSigners } from "../lifecycle/gate-seal";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

/** One approval rule. */
export interface GateQuorumRule {
  /** Globs over the gate's targets (an Op wave's run targets, an Op gate's environment). Absent, the rule covers every target. */
  targets?: string[];
  /** Distinct human approvers the rule needs. At least 1. */
  count: number;
  /** When set, only an approver `.chant/trust.json` at base gives one of these roles counts, and only with a proven approval. */
  roles?: string[];
  /** When true, at least one counted approver is proven and is not the change's author. */
  notAuthor?: boolean;
}

/** A gate's quorum: one rule (the form before #4290), or a list of them. */
export type GateQuorumSpec = GateQuorumRule | readonly GateQuorumRule[];

/** What a judge says about one approval. */
export interface QuorumJudgement {
  /** The approval proves who `resolvedBy` is: a verified seal, or the forge's review. */
  proven: boolean;
  /** The roles `.chant/trust.json` at base gives the approver. Empty unless `proven`. */
  roles: string[];
  /** Whether the approver is the change's author. Undefined when nobody knows who the author is. */
  author?: boolean;
}

/** Judges one approval for the rules. */
export type GateQuorumJudge = (approval: GateResolutionRecord) => QuorumJudgement;

/** The judge with nothing to judge by: no approval proves anyone, and nobody's author is known. */
export const UNPROVEN_JUDGE: GateQuorumJudge = () => ({ proven: false, roles: [] });

/** How far one rule is met. */
export interface GateQuorumRuleProgress {
  targets?: string[];
  count: number;
  roles?: string[];
  notAuthor?: boolean;
  /** The approvers it counts, oldest first. */
  approvers: string[];
  met: boolean;
  /** Why the author could not be told apart, when `notAuthor` is set and nobody knows the author. */
  authorUnknown?: boolean;
}

/** The rules of a quorum, as a list. Absent, none. */
export function quorumRules(quorum: GateQuorumSpec | undefined): GateQuorumRule[] {
  if (quorum === undefined) return [];
  return Array.isArray(quorum) ? [...(quorum as readonly GateQuorumRule[])] : [quorum as GateQuorumRule];
}

/**
 * Whether `target` matches `glob`: `*` within a `/` segment, `**` across
 * segments (and `a/**\/b` across none), `?` one character. The same reading
 * as the terraform lexicon's unit globs, so a Terragrunt root's glob means
 * one thing in both.
 */
export function targetGlobMatch(glob: string, target: string): boolean {
  const g = glob.replace(/\\/g, "/").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(target.replace(/\\/g, "/").replace(/\/+$/, ""));
}

/** The rules a gate whose targets are `targets` takes: those with no `targets`, and those a glob of matches one. */
export function quorumRulesFor(rules: readonly GateQuorumRule[], targets: readonly string[]): GateQuorumRule[] {
  return rules.filter((r) => r.targets === undefined || r.targets.some((g) => targets.some((t) => targetGlobMatch(g, t))));
}

/** The most approvers any rule needs, 1 with none. */
export function quorumNeed(rules: readonly GateQuorumRule[]): number {
  return rules.reduce((n, r) => Math.max(n, r.count), 1);
}

/**
 * Everything wrong with a quorum, one line each. `where` names it
 * (`approval.quorum`). With `notAuthor: false`, a rule naming `notAuthor` is
 * refused, since that caller has no author to judge by.
 */
export function quorumProblems(value: unknown, where: string, opts: { notAuthor: boolean }): string[] {
  const list = Array.isArray(value) ? value : [value];
  const problems: string[] = [];
  if (Array.isArray(value) && value.length === 0) problems.push(`\`${where}\` must name at least one rule`);
  list.forEach((rule, i) => {
    const at = Array.isArray(value) ? `${where}[${i}]` : where;
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      problems.push(`\`${at}\` must be an object`);
      return;
    }
    const q = rule as Record<string, unknown>;
    if (typeof q.count !== "number" || !Number.isInteger(q.count) || q.count < 1) problems.push(`\`${at}.count\` must be an integer of at least 1`);
    if (q.roles !== undefined && (!Array.isArray(q.roles) || q.roles.length === 0 || q.roles.some((r) => typeof r !== "string" || r === ""))) {
      problems.push(`\`${at}.roles\` must be a non-empty list of role names`);
    }
    if (q.targets !== undefined && (!Array.isArray(q.targets) || q.targets.length === 0 || q.targets.some((t) => typeof t !== "string" || t === ""))) {
      problems.push(`\`${at}.targets\` must be a non-empty list of globs`);
    }
    if (q.notAuthor !== undefined && typeof q.notAuthor !== "boolean") problems.push(`\`${at}.notAuthor\` must be true or false`);
    if (q.notAuthor === true && !opts.notAuthor) {
      problems.push(`\`${at}.notAuthor\` is not read here: an Op gate has no author to judge by. An Op waves spec's \`approvals.quorum\` reads it from the merged pull request`);
    }
    const known = new Set(["targets", "count", "roles", "notAuthor"]);
    for (const key of Object.keys(q)) if (!known.has(key)) problems.push(`\`${at}.${key}\` is not a quorum field; use targets, count, roles or notAuthor`);
  });
  return problems;
}

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/** Whether two principals name the same person, compared trimmed and lower-cased. */
export const samePrincipal = (a: string, b: string): boolean => norm(a) === norm(b);

/** The roles `roles` (`.chant/trust.json`'s role grants) gives `who`, sorted. */
export function rolesOf(who: string, roles: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(roles)
    .filter(([, principals]) => principals.some((p) => samePrincipal(p, who)))
    .map(([role]) => role)
    .sort();
}

/** One approver as a rule counts them. */
export interface QuorumApprover {
  who: string;
  at: string;
  judged: QuorumJudgement;
}

/** How far `rule` is met by `approvers`: each counted once, by name, oldest first. */
export function quorumRuleProgress(rule: GateQuorumRule, approvers: readonly QuorumApprover[]): GateQuorumRuleProgress {
  const seen = new Set<string>();
  const counted: QuorumApprover[] = [];
  for (const a of [...approvers].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
    if (seen.has(norm(a.who))) continue;
    if (rule.roles?.length && !(a.judged.proven && a.judged.roles.some((r) => rule.roles!.includes(r)))) continue;
    seen.add(norm(a.who));
    counted.push(a);
  }
  const notAuthor = !rule.notAuthor || counted.some((a) => a.judged.proven && a.judged.author === false);
  const authorUnknown = rule.notAuthor === true && !notAuthor && counted.some((a) => a.judged.proven && a.judged.author === undefined);
  return {
    ...(rule.targets ? { targets: [...rule.targets] } : {}),
    count: rule.count,
    ...(rule.roles?.length ? { roles: [...rule.roles] } : {}),
    ...(rule.notAuthor ? { notAuthor: true } : {}),
    approvers: counted.map((a) => a.who),
    met: counted.length >= rule.count && notAuthor,
    ...(authorUnknown ? { authorUnknown: true } : {}),
  };
}

/**
 * Where a rule stands, in one line: `prod-*: 1 of 2 approvals (github:alice),
 * needs 1 more from platform`.
 */
export function quorumRuleLine(p: GateQuorumRuleProgress): string {
  const scope = p.targets ? p.targets.join(", ") : "every target";
  const have = `${p.approvers.length} of ${p.count} approval${p.count === 1 ? "" : "s"}${p.approvers.length ? ` (${p.approvers.join(", ")})` : ""}`;
  if (p.met) return `${scope}: ${have}, met`;
  const more = p.count - p.approvers.length;
  const needs: string[] = [];
  if (more > 0) needs.push(`${more} more${p.roles?.length ? ` from ${p.roles.join(" or ")}` : ""}`);
  if (p.notAuthor) needs.push(more > 0 ? "one of them not the author" : "an approver who is not the author");
  const unknown = p.authorUnknown ? " (the change's author is not known, so no approver can show they are someone else)" : "";
  return `${scope}: ${have}, needs ${needs.join(", ")}${unknown}`;
}

/** The rules that are not met, one line each joined by `; `. */
export function quorumWaiting(progress: readonly GateQuorumRuleProgress[]): string {
  return progress.filter((p) => !p.met).map(quorumRuleLine).join("; ");
}

/** Whether a rule needs a proven approver: it names roles, or `notAuthor`. */
export const ruleNeedsProof = (rule: GateQuorumRule): boolean => (rule.roles?.length ?? 0) > 0 || rule.notAuthor === true;

/** What {@link trustQuorumJudge} judges by. */
export interface TrustQuorumInput {
  /** The signers at base: an approval whose seal verifies for its approver against them is proven. */
  signers: GateSigners;
  /** `.chant/trust.json`'s role grants at base. */
  roles: Readonly<Record<string, readonly string[]>>;
  /** The change's authors, as principals. Absent, nobody knows who they are. */
  authors?: readonly string[];
  /**
   * Under `pr-review`, the merged pull request's review, read from the forge
   * in this run: a resolution that names this review's head and one of its
   * approvers as `resolvedBy` is proven.
   */
  review?: { head: string; approvers: readonly string[] };
}

/** The judge a gate's rules are met by: proof from a seal or the live review, roles from trust.json at base. */
export function trustQuorumJudge(input: TrustQuorumInput): GateQuorumJudge {
  return (r) => {
    const sealed = r.seal !== undefined && r.seal !== null && gateSealRefusal(input.signers, r) === null;
    const reviewed =
      input.review !== undefined && r.review?.head === input.review.head && input.review.approvers.some((a) => samePrincipal(a, r.resolvedBy));
    const proven = sealed || reviewed;
    return {
      proven,
      roles: proven ? rolesOf(r.resolvedBy, input.roles) : [],
      ...(input.authors !== undefined ? { author: input.authors.some((a) => samePrincipal(a, r.resolvedBy)) } : {}),
    };
  };
}
