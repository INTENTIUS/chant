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
 * pull request, or a review a product recorded on a ledger the spec at base
 * names (#4333). The judge of a gate decides that ({@link GateQuorumJudge});
 * with none, no approval proves anything, so a rule naming roles or
 * `notAuthor` is never met.
 *
 * With `proven` (#5349), only a proven approver counts toward the rule's
 * `count` at all. Without it a `count` counts every human approver of the
 * plan, proven or not, so under a mode that takes plain `chant approve`
 * lines (`ledger`, `pr-review`, `pull-request`) one person who can push to
 * `chant/lifecycle` can write two lines in two names and meet `count: 2`.
 * Off by default.
 *
 * Rules combine with `all` and `any` (#5354): a group `{ all: [...] }` is
 * met when every rule in it is, and `{ any: [...] }` when one is, so a gate
 * can take "two approvers, or one with the `release-manager` role". The list
 * a gate takes is an `all`. Groups nest up to {@link QUORUM_MAX_DEPTH} deep,
 * and every rule and group may carry a `name`, which the progress lines, the
 * plan note and the pending fact on the ledger show. A group whose rules a
 * gate's targets leave out is dropped, never met by nobody: an `any` is met
 * only by a rule that counts real approvers, so it opens no way past the
 * gate's approval. Only a caller that passes `combine: true` to
 * {@link quorumProblems} reads groups and names.
 *
 * `notAuthor` reads who was involved in the change (#4333): the pull
 * request's author, each login a `Requested-by:` trailer on its commits
 * names, and the accounts an agent acts as. With `excludeInvolved`, an
 * approval by any of them does not count at all.
 *
 * This module is pure: no git, no file reads, no package, so
 * `@intentius/chant/gate-decision` bundles it. The judge is built by the
 * caller from the trust policy it read at base ({@link trustQuorumJudge}).
 */

import { gateSealRefusal, type GateSigners } from "../lifecycle/gate-seal";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

/** One approval rule. */
export interface GateQuorumRule {
  /** The rule's name (#5354), shown in its progress line, the plan note and the pending fact. */
  name?: string;
  /** Globs over the gate's targets (an Op wave's run targets, an Op gate's environment). Absent, the rule covers every target. */
  targets?: string[];
  /** Distinct human approvers the rule needs. At least 1. */
  count: number;
  /** When set, only an approver `.chant/trust.json` at base gives one of these roles counts, and only with a proven approval. */
  roles?: string[];
  /** When true, at least one counted approver is proven and is not the change's author. */
  notAuthor?: boolean;
  /**
   * When true (#5349), only a proven approver counts toward `count`: a seal
   * that verifies against the signers at base, or a review the judge proves.
   * Default false: every human approver of the plan counts.
   */
  proven?: boolean;
}

/** A group met when every rule in it is met (#5354). */
export interface GateQuorumAll {
  name?: string;
  all: GateQuorumNode[];
}

/** A group met when one rule in it is met (#5354). */
export interface GateQuorumAny {
  name?: string;
  any: GateQuorumNode[];
}

/** A rule, or a group of rules (#5354). */
export type GateQuorumNode = GateQuorumRule | GateQuorumAll | GateQuorumAny;

/** A gate's quorum: one rule (the form before #4290), or a list of rules and groups, all of which must be met. */
export type GateQuorumSpec = GateQuorumRule | readonly GateQuorumNode[];

/** How deep `all` and `any` groups nest (#5354): a group in a group in a group, and no further. */
export const QUORUM_MAX_DEPTH = 3;

/** Whether `node` is an `all` group. */
export const isQuorumAll = (node: GateQuorumNode): node is GateQuorumAll => Array.isArray((node as GateQuorumAll).all);
/** Whether `node` is an `any` group. */
export const isQuorumAny = (node: GateQuorumNode): node is GateQuorumAny => Array.isArray((node as GateQuorumAny).any);
/** Whether `node` is a group, `all` or `any`. */
export const isQuorumGroup = (node: GateQuorumNode): node is GateQuorumAll | GateQuorumAny => isQuorumAll(node) || isQuorumAny(node);

/** The rules and groups a quorum lists, at the top. Absent, none. */
export function quorumNodes(quorum: GateQuorumSpec | undefined): GateQuorumNode[] {
  if (quorum === undefined) return [];
  return Array.isArray(quorum) ? [...(quorum as readonly GateQuorumNode[])] : [quorum as GateQuorumRule];
}

/** What a judge says about one approval. */
export interface QuorumJudgement {
  /** The approval proves who `resolvedBy` is: a verified seal, or the forge's review. */
  proven: boolean;
  /** The roles `.chant/trust.json` at base gives the approver. Empty unless `proven`. */
  roles: string[];
  /**
   * Whether the approver was involved in the change: its author, or anyone
   * else {@link TrustQuorumInput.involved} names. Undefined when nobody knows
   * who the author is and the approver is not named as involved otherwise.
   */
  author?: boolean;
  /** Why the approval does not count at all (#4333): the approver was involved and the judge excludes everyone involved. */
  excluded?: string;
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
  proven?: boolean;
  /** The approvers it counts, oldest first. */
  approvers: string[];
  met: boolean;
  /** Why the author could not be told apart, when `notAuthor` is set and nobody knows the author. */
  authorUnknown?: boolean;
  /** The rule's name (#5354). */
  name?: string;
}

/** How far a group of rules is met (#5354). */
export interface GateQuorumGroupProgress {
  kind: "all" | "any";
  name?: string;
  met: boolean;
  children: Array<GateQuorumRuleProgress | GateQuorumGroupProgress>;
}

/** Whether a progress entry is a group's. */
export const isGroupProgress = (p: GateQuorumRuleProgress | GateQuorumGroupProgress): p is GateQuorumGroupProgress => "children" in p;

/**
 * The rules of a quorum, as a flat list: every rule, inside groups too
 * (#5354). For a quorum with no groups, the list it is. Read it to ask what
 * any rule needs (proof, a count); judge whether the quorum is met with
 * {@link quorumTreeProgress}, which reads the groups.
 */
export function quorumRules(quorum: GateQuorumSpec | undefined): GateQuorumRule[] {
  const out: GateQuorumRule[] = [];
  const walk = (n: GateQuorumNode): void => {
    if (isQuorumAll(n)) n.all.forEach(walk);
    else if (isQuorumAny(n)) n.any.forEach(walk);
    else out.push(n);
  };
  quorumNodes(quorum).forEach(walk);
  return out;
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

/**
 * The rules a gate whose targets are `targets` takes: those with no
 * `targets`, and those a glob of matches one. A group keeps the rules in it
 * the gate takes, and is dropped when it keeps none (#5354), so an `any`
 * is never met by a rule left out.
 */
export function quorumRulesFor<T extends GateQuorumNode>(rules: readonly T[], targets: readonly string[]): T[] {
  const prune = (n: GateQuorumNode): GateQuorumNode | undefined => {
    if (isQuorumGroup(n)) {
      const kids = (isQuorumAll(n) ? n.all : n.any).map(prune).filter((k): k is GateQuorumNode => k !== undefined);
      if (kids.length === 0) return undefined;
      return isQuorumAll(n) ? { ...(n.name !== undefined ? { name: n.name } : {}), all: kids } : { ...(n.name !== undefined ? { name: n.name } : {}), any: kids };
    }
    return n.targets === undefined || n.targets.some((g) => targets.some((t) => targetGlobMatch(g, t))) ? n : undefined;
  };
  return rules.map(prune).filter((n): n is GateQuorumNode => n !== undefined) as T[];
}

/** The most approvers any rule needs, 1 with none. */
export function quorumNeed(rules: readonly GateQuorumRule[]): number {
  return rules.reduce((n, r) => Math.max(n, r.count), 1);
}

/** Every rule with where it is written (#5354): `approvals.quorum[1].any[0]`, under `where`. */
export function quorumRuleSites(quorum: GateQuorumSpec | undefined, where: string): Array<{ rule: GateQuorumRule; at: string }> {
  const out: Array<{ rule: GateQuorumRule; at: string }> = [];
  const walk = (n: GateQuorumNode, at: string): void => {
    if (isQuorumAll(n)) n.all.forEach((k, i) => walk(k, `${at}.all[${i}]`));
    else if (isQuorumAny(n)) n.any.forEach((k, i) => walk(k, `${at}.any[${i}]`));
    else out.push({ rule: n, at });
  };
  quorumNodes(quorum).forEach((n, i) => walk(n, Array.isArray(quorum) ? `${where}[${i}]` : where));
  return out;
}

/** A rule or group's name (#5354): lowercase letters, digits, `-` and `_`. */
export const QUORUM_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Everything wrong with a quorum, one line each. `where` names it
 * (`approval.quorum`). With `notAuthor: false`, a rule naming `notAuthor` is
 * refused, since that caller has no author to judge by. Without `proven:
 * true`, a rule naming `proven` is refused (#5349): an Op waves spec's
 * `approvals.quorum` reads it. Without `combine: true`, a group (`all`,
 * `any`) and a `name` are refused (#5354): an Op waves spec's
 * `approvals.quorum` and a pipeline stage's gate read them.
 */
export function quorumProblems(value: unknown, where: string, opts: { notAuthor: boolean; proven?: boolean; combine?: boolean }): string[] {
  const list = Array.isArray(value) ? value : [value];
  const problems: string[] = [];
  if (Array.isArray(value) && value.length === 0) problems.push(`\`${where}\` must name at least one rule`);
  const names = new Set<string>();
  const nameProblem = (q: Record<string, unknown>, at: string): void => {
    if (q.name === undefined) return;
    if (!opts.combine) return;
    if (typeof q.name !== "string" || !QUORUM_NAME.test(q.name)) problems.push(`\`${at}.name\` must be lowercase letters, digits, - and _`);
    else if (names.has(q.name)) problems.push(`\`${at}.name\` is ${JSON.stringify(q.name)}, which another rule of the gate already names`);
    else names.add(q.name);
  };
  const node = (rule: unknown, at: string, depth: number): void => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      problems.push(`\`${at}\` must be an object`);
      return;
    }
    const q = rule as Record<string, unknown>;
    if (opts.combine && ("all" in q || "any" in q)) {
      nameProblem(q, at);
      if ("all" in q && "any" in q) problems.push(`\`${at}\` names both all and any; a group is one of them`);
      const kind = "all" in q ? "all" : "any";
      const kids = q[kind];
      if (depth >= QUORUM_MAX_DEPTH) problems.push(`\`${at}\` nests groups deeper than ${QUORUM_MAX_DEPTH}; all and any nest up to ${QUORUM_MAX_DEPTH} groups deep`);
      else if (!Array.isArray(kids) || kids.length === 0) problems.push(`\`${at}.${kind}\` must list at least one rule`);
      else kids.forEach((k, i) => node(k, `${at}.${kind}[${i}]`, depth + 1));
      for (const key of Object.keys(q)) if (key !== "name" && key !== "all" && key !== "any") problems.push(`\`${at}.${key}\` is not read on a group; a group takes name and one of all or any`);
      return;
    }
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
    if (q.proven !== undefined && typeof q.proven !== "boolean") problems.push(`\`${at}.proven\` must be true or false`);
    if (q.proven !== undefined && opts.proven !== true) {
      problems.push(`\`${at}.proven\` is not read here. An Op waves spec's \`approvals.quorum\` reads it`);
    }
    nameProblem(q, at);
    const known = new Set(["targets", "count", "roles", "notAuthor", ...(opts.proven ? ["proven"] : []), ...(opts.combine ? ["name"] : [])]);
    const fields = [...known];
    const words = `${fields.slice(0, -1).join(", ")} or ${fields[fields.length - 1]}`;
    for (const key of Object.keys(q)) if (!known.has(key) && key !== "proven") problems.push(`\`${at}.${key}\` is not a quorum field; use ${words}${opts.combine ? ", or a group of all or any" : ""}`);
  };
  list.forEach((rule, i) => node(rule, Array.isArray(value) ? `${where}[${i}]` : where, 0));
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
    if (seen.has(norm(a.who)) || !ruleAdmits(rule, a.judged)) continue;
    seen.add(norm(a.who));
    counted.push(a);
  }
  const notAuthor = !rule.notAuthor || counted.some((a) => a.judged.proven && a.judged.author === false);
  const authorUnknown = rule.notAuthor === true && !notAuthor && counted.some((a) => a.judged.proven && a.judged.author === undefined);
  return {
    ...(rule.name !== undefined ? { name: rule.name } : {}),
    ...(rule.targets ? { targets: [...rule.targets] } : {}),
    count: rule.count,
    ...(rule.roles?.length ? { roles: [...rule.roles] } : {}),
    ...(rule.notAuthor ? { notAuthor: true } : {}),
    ...(rule.proven ? { proven: true } : {}),
    approvers: counted.map((a) => a.who),
    met: counted.length >= rule.count && notAuthor,
    ...(authorUnknown ? { authorUnknown: true } : {}),
  };
}

/** Whether `approver` counts toward `rule` on their own, before the count (#5354): not left out, proven when the rule needs it, holding a role it names. */
export function ruleAdmits(rule: GateQuorumRule, judged: QuorumJudgement): boolean {
  if (judged.excluded !== undefined) return false;
  if (rule.proven && !judged.proven) return false;
  if (rule.roles?.length && !(judged.proven && judged.roles.some((r) => rule.roles!.includes(r)))) return false;
  return true;
}

/** What {@link quorumTreeProgress} found. */
export interface GateQuorumTreeProgress {
  /** Every rule (#5354), groups' included, in the order written. */
  rules: GateQuorumRuleProgress[];
  /** The top-level rules and groups, with each group's. Absent when the quorum has no group. */
  groups?: Array<GateQuorumRuleProgress | GateQuorumGroupProgress>;
  /** Every top-level rule and group is met. False with none. */
  met: boolean;
}

/**
 * How far a list of rules and groups is met by `approvers` (#5354): each
 * rule as {@link quorumRuleProgress} counts it, an `all` group when every
 * rule in it is met, an `any` group when one is, and the list when every
 * entry is. A list with no entry is not met; a caller with no rules asks for
 * one human approval itself.
 */
export function quorumTreeProgress(nodes: readonly GateQuorumNode[], approvers: readonly QuorumApprover[]): GateQuorumTreeProgress {
  const rules: GateQuorumRuleProgress[] = [];
  let grouped = false;
  const walk = (n: GateQuorumNode): GateQuorumRuleProgress | GateQuorumGroupProgress => {
    if (isQuorumGroup(n)) {
      grouped = true;
      const kind = isQuorumAll(n) ? "all" : "any";
      const children = (isQuorumAll(n) ? n.all : n.any).map(walk);
      const met = children.length > 0 && (kind === "all" ? children.every((c) => c.met) : children.some((c) => c.met));
      return { kind, ...(n.name !== undefined ? { name: n.name } : {}), met, children };
    }
    const p = quorumRuleProgress(n, approvers);
    rules.push(p);
    return p;
  };
  const top = nodes.map(walk);
  return { rules, ...(grouped ? { groups: top } : {}), met: top.length > 0 && top.every((p) => p.met) };
}

/** A group's line (#5354): `any fast-path: met by release-manager`, or what it waits on. */
export function quorumGroupLine(g: GateQuorumGroupProgress): string {
  const label = (c: GateQuorumRuleProgress | GateQuorumGroupProgress, i: number) => c.name ?? `${isGroupProgress(c) ? c.kind : "rule"} ${i + 1}`;
  const head = `${g.kind}${g.name !== undefined ? ` ${g.name}` : ""}`;
  const met = g.children.map((c, i) => [c, i] as const).filter(([c]) => c.met).map(([c, i]) => label(c, i));
  if (g.met) return `${head}: met by ${met.join(", ")}`;
  const open = g.children.map((c, i) => [c, i] as const).filter(([c]) => !c.met).map(([c, i]) => label(c, i));
  return g.kind === "any" ? `${head}: waits for one of ${open.join(", ")}` : `${head}: waits for ${open.join(", ")}`;
}

/** Every group's line, outermost first (#5354). */
export function quorumGroupLines(groups: ReadonlyArray<GateQuorumRuleProgress | GateQuorumGroupProgress> | undefined): string[] {
  const out: string[] = [];
  const walk = (p: GateQuorumRuleProgress | GateQuorumGroupProgress): void => {
    if (!isGroupProgress(p)) return;
    out.push(quorumGroupLine(p));
    p.children.forEach(walk);
  };
  (groups ?? []).forEach(walk);
  return out;
}

/**
 * Where a rule stands, in one line: `prod-*: 1 of 2 approvals (github:alice),
 * needs 1 more from platform`. A named rule (#5354) leads with its name.
 */
export function quorumRuleLine(p: GateQuorumRuleProgress): string {
  const where = p.targets ? p.targets.join(", ") : "every target";
  const scope = p.name !== undefined ? `${p.name} (${where})` : where;
  const have = `${p.approvers.length} of ${p.count} approval${p.count === 1 ? "" : "s"}${p.approvers.length ? ` (${p.approvers.join(", ")})` : ""}`;
  if (p.met) return `${scope}: ${have}, met`;
  const more = p.count - p.approvers.length;
  const needs: string[] = [];
  if (more > 0) needs.push(`${more} more${p.proven && !p.roles?.length ? " proven" : ""}${p.roles?.length ? ` from ${p.roles.join(" or ")}` : ""}`);
  if (p.notAuthor) needs.push(more > 0 ? "one of them not the author" : "an approver who is not the author");
  const unknown = p.authorUnknown ? " (the change's author is not known, so no approver can show they are someone else)" : "";
  return `${scope}: ${have}, needs ${needs.join(", ")}${unknown}`;
}

/** The rules that are not met, one line each joined by `; `. */
export function quorumWaiting(progress: readonly GateQuorumRuleProgress[]): string {
  return progress.filter((p) => !p.met).map(quorumRuleLine).join("; ");
}

/** Whether a rule needs a proven approver: it names roles, `notAuthor` or `proven`. */
export const ruleNeedsProof = (rule: GateQuorumRule): boolean => (rule.roles?.length ?? 0) > 0 || rule.notAuthor === true || rule.proven === true;

/** Someone involved in a change (#4333), and why: `github:bob asked for abc1234`. */
export interface QuorumInvolvement {
  who: string;
  why: string;
}

/** A login as a forge allows it, and a GitHub App's `[bot]` suffix. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[bot\])?$/;

/**
 * The logins `Requested-by:` trailers on a commit message name, each once.
 * Any line of the message counts, since a squash merge keeps the trailers of
 * the commits it squashed in its body.
 */
export function requestedByTrailers(message: string): string[] {
  const out: string[] = [];
  for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^requested-by:\s*(\S+)\s*$/i.exec(line.trim());
    if (m && LOGIN.test(m[1]!) && !out.some((o) => samePrincipal(o, m[1]!))) out.push(m[1]!);
  }
  return out;
}

/**
 * The names a principal goes by: itself, and for a forge principal
 * (`github:alice`, `gitlab@gitlab.acme.com:bob`) the login after the colon,
 * so a trailer's bare login and an approval's principal name one person.
 */
export function principalNames(who: string): string[] {
  const m = /^(?:github|gitlab|forgejo|gitea|codeberg)(?:@[^:\s]+)?:(.+)$/i.exec(who.trim());
  return m ? [who, m[1]!] : [who];
}

/** Why `who` was involved in the change, or undefined when `involved` does not name them. */
export function involvedWhy(involved: readonly QuorumInvolvement[], who: string): string | undefined {
  const names = principalNames(who);
  return involved.find((p) => principalNames(p.who).some((a) => names.some((b) => samePrincipal(a, b))))?.why;
}

/**
 * Everyone involved in a change (#4333): the pull request's `author`, each
 * login a `Requested-by:` trailer on `commits` names, and the `agents`'
 * accounts. `principal` turns a trailer's login into the principal the
 * forge's approvals name (`github:<login>`); absent, the login stands.
 */
export function changeInvolvement(o: {
  author?: string;
  commits?: readonly { sha: string; message: string }[];
  agents?: readonly string[];
  principal?: (login: string) => string;
}): QuorumInvolvement[] {
  const out: QuorumInvolvement[] = [];
  const add = (who: string, why: string): void => {
    if (who.trim() && !out.some((p) => samePrincipal(p.who, who))) out.push({ who, why });
  };
  if (o.author) add(o.author, `${o.author} opened the change`);
  for (const c of o.commits ?? []) {
    for (const login of requestedByTrailers(c.message)) add(o.principal ? o.principal(login) : login, `${login} asked for ${c.sha.slice(0, 7)}`);
  }
  for (const a of o.agents ?? []) add(a, `${a} is an account an agent acts as`);
  return out;
}

/**
 * A review a product recorded on its own ledger (#4333), as terragucci does
 * under `pr-review`: a resolution with `via: "pr-review"`, the reviewed
 * `head`, and the `reviewers` who approved it, by forge login. One line
 * names every reviewer, so `resolvedBy` is not one person.
 */
export interface RecordedReview {
  pr?: number;
  head: string;
  reviewers: string[];
}

/** The review a ledger line records, when it is a product's review line; null otherwise. */
export function recordedReviewOf(r: GateResolutionRecord): RecordedReview | null {
  const x = r as unknown as { via?: unknown; head?: unknown; reviewers?: unknown; pr?: unknown };
  if (x.via !== "pr-review" || typeof x.head !== "string" || x.head === "") return null;
  if (!Array.isArray(x.reviewers) || x.reviewers.length === 0 || x.reviewers.some((v) => typeof v !== "string" || v === "")) return null;
  return { ...(typeof x.pr === "number" ? { pr: x.pr } : {}), head: x.head, reviewers: [...(x.reviewers as string[])] };
}

/**
 * The approvals a product's review lines stand for (#4333): each line
 * {@link recordedReviewOf} reads becomes one approval per reviewer, named by
 * `principal(login)` (the login itself when absent), a human's, with the
 * review on it. A seal on the line is dropped: it signs the line, not any
 * one reviewer. Every other line is kept as it is. `reviews` lists the
 * reviews read, for {@link TrustQuorumInput.recorded}.
 */
export function recordedReviewApprovals(
  records: readonly GateResolutionRecord[],
  principal: (login: string) => string = (login) => login,
): { records: GateResolutionRecord[]; reviews: { head: string; approvers: string[] }[] } {
  const out: GateResolutionRecord[] = [];
  const reviews: { head: string; approvers: string[] }[] = [];
  for (const r of records) {
    const review = recordedReviewOf(r);
    if (!review) {
      out.push(r);
      continue;
    }
    const approvers = review.reviewers.map(principal);
    reviews.push({ head: review.head, approvers });
    const { seal: _seal, ...rest } = r;
    const base = Object.fromEntries(Object.entries(rest).filter(([k]) => !["via", "reviewers", "head", "pr", "excluded"].includes(k))) as unknown as GateResolutionRecord;
    for (const who of approvers) out.push({ ...base, resolvedBy: who, approver: { kind: "human" }, review: { pr: review.pr ?? 0, head: review.head, approvers } });
  }
  return { records: out, reviews };
}

/** What {@link trustQuorumJudge} judges by. */
export interface TrustQuorumInput {
  /** The signers at base: an approval whose seal verifies for its approver against them is proven. */
  signers: GateSigners;
  /** `.chant/trust.json`'s role grants at base. */
  roles: Readonly<Record<string, readonly string[]>>;
  /** The change's authors, as principals. Absent, nobody knows who they are. */
  authors?: readonly string[];
  /**
   * Everyone else involved in the change (#4333), from {@link
   * changeInvolvement}: an approver named here is judged as an author, for
   * `notAuthor`, whether or not `authors` is known.
   */
  involved?: readonly QuorumInvolvement[];
  /** An approval by an author or anyone `involved` names does not count at all (#4333), toward any rule. */
  excludeInvolved?: boolean;
  /**
   * Reviews a product recorded on the ledger the spec at base names (#4333),
   * from {@link recordedReviewApprovals}: a resolution that names one's head
   * and one of its approvers as `resolvedBy` is proven, as for `review`. Pass
   * them only under `pr-review`, as the product proves its reviewers only
   * then.
   */
  recorded?: readonly { head: string; approvers: readonly string[] }[];
  /**
   * Under `pr-review`, the merged pull request's review, read from the forge
   * in this run: a resolution that names this review's head and one of its
   * approvers as `resolvedBy` is proven.
   */
  review?: { head: string; approvers: readonly string[] };
}

/**
 * The judge a gate's rules are met by: proof from a seal, the live review or
 * a review a product recorded, roles from trust.json at base, and the
 * change's authors and everyone else involved in it left out.
 */
export function trustQuorumJudge(input: TrustQuorumInput): GateQuorumJudge {
  const named = (list: readonly string[], who: string) => list.some((a) => samePrincipal(a, who));
  return (r) => {
    const sealed = r.seal !== undefined && r.seal !== null && gateSealRefusal(input.signers, r) === null;
    const reviewed = input.review !== undefined && r.review?.head === input.review.head && named(input.review.approvers, r.resolvedBy);
    const recorded = r.review !== undefined && (input.recorded ?? []).some((x) => x.head === r.review!.head && named(x.approvers, r.resolvedBy));
    const proven = sealed || reviewed || recorded;
    const authored = input.authors !== undefined && input.authors.some((a) => samePrincipal(a, r.resolvedBy));
    const why = authored ? `${r.resolvedBy} wrote the change` : involvedWhy(input.involved ?? [], r.resolvedBy);
    return {
      proven,
      roles: proven ? rolesOf(r.resolvedBy, input.roles) : [],
      ...(why !== undefined ? { author: true } : input.authors !== undefined ? { author: false } : {}),
      ...(why !== undefined && input.excludeInvolved ? { excluded: `${why}, so ${r.resolvedBy}'s approval does not count` } : {}),
    };
  };
}
