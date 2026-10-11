/**
 * The override gate (#3760, decision #3756): a person's recorded, reasoned
 * decision to apply one plan a policy denied, spent once a run applies it.
 *
 * The policy engines stay in the products (OPA and conftest in terragucci,
 * config rules in SQL Yodeler). They say a plan is denied and by which rules.
 * This module records and decides the overrides of those denials, so a
 * product keeps a thin layer over it:
 *
 * - A denial is a pending fact on `_gates/policy-override.jsonl` on
 *   `chant/lifecycle`, gate the subject (a root, an environment, whatever the
 *   product applies one plan to), with the rules that denied it
 *   ({@link overridePending}). Its `planDigest` is the override digest
 *   ({@link overrideDigest}), which binds the subject, the plan digest and
 *   the rule ids, so `chant approve` copies it by default.
 * - An override is an approval of that gate and digest, written with
 *   `chant approve policy-override <subject> --rule <id> --reason <text>`
 *   (`--sign` under `sealed`). The reason is its `note`.
 * - It counts ({@link decideOverride}) when it is newer than the subject's
 *   newest pending fact, names this digest, was written by a person the
 *   overriders at base list ({@link overridersAt}), gives a reason, and under
 *   `sealed` carries a seal that verifies for its approver against the
 *   signers file at base. A line a job wrote (one that carries `via` or a
 *   forge `review`) or an agent wrote never counts.
 * - Before a run applies under an override it appends an applied record
 *   ({@link appliedOverride}) to `_gates/policy-override/applied.jsonl`. An
 *   override with an applied record is spent: it counts for nothing again, so
 *   a plan that is denied again waits for its own override, and a spent
 *   override of an older plan is not reported as a moved plan.
 *
 * Like `./gate-decision.ts` it reads the lines it is handed and writes
 * nothing; `override-gate-bundle.test.ts` holds its import graph to the
 * same bundle. chant's own writers are in `./lifecycle/override-ledger.ts`.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { OVERRIDE_GATE_OP } from "./op/gate-name";
import { latestPendingGate } from "./lifecycle/gate-ledger-select";
import { samePlanDigest } from "./lifecycle/plan-digest";
import { gateSealRefusal, type GateSigners } from "./workspace/trust/gate-seal";
import { DEFAULT_SIGNERS_PATH } from "./workspace/trust/trust-files";
import type { GateResolutionRecord, PendingGateRecord } from "./lifecycle/gate-ledger";
import type { GateApprovalSource } from "./op/op-waves";
import type { GateAuditApply } from "./lifecycle/gate-audit";

export type { GateResolutionRecord, PendingGateRecord } from "./lifecycle/gate-ledger";
export type { GateSigners } from "./workspace/trust/gate-seal";

/** The op every override and denial is recorded under. `./lifecycle/gate-audit.ts` reads this op as overrides by default. */
export const OVERRIDE_OP = OVERRIDE_GATE_OP;
/** The ledger file on `chant/lifecycle` that holds denials and overrides. */
export const OVERRIDE_LEDGER = `_gates/${OVERRIDE_OP}.jsonl`;
/** The file beside it that holds the overrides a run applied under. chant reads only the `.jsonl` files directly under `_gates/` as gate ledgers, so it never reads these lines as gate records. */
export const OVERRIDE_APPLIED = `_gates/${OVERRIDE_OP}/applied.jsonl`;
/** Where the overriders are read at base when the caller names no other file: one principal per line, `#` starts a comment. */
export const OVERRIDERS_PATH = ".chant/overriders";

// ── the digest ───────────────────────────────────────────────────────────

/** The rules as an override names them: trimmed, each once, sorted. */
export function sortedRules(rules: readonly string[]): string[] {
  return [...new Set(rules.map((r) => r.trim()).filter(Boolean))].sort();
}

/**
 * The digest an override binds: the subject, its plan digest and the rules
 * that denied it, as `sha256:<hex>` over their LF-joined lines after the op
 * name. A plan that moved, or a different set of rules, gives another digest,
 * so an override of one denial never lets another through.
 */
export function overrideDigest(subject: string, planDigest: string, rules: readonly string[]): string {
  const text = [OVERRIDE_OP, subject, planDigest, ...sortedRules(rules)].join("\n");
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The command that overrides a denial. */
export function overrideCommand(subject: string, rules: readonly string[], sealed = false): string {
  return `chant approve ${OVERRIDE_OP} ${subject} ${sortedRules(rules).map((r) => `--rule ${r}`).join(" ")} --reason "<why>"${sealed ? " --sign" : ""}`;
}

// ── the denial ───────────────────────────────────────────────────────────

/** A denial's pending fact: the gate's record, with the plan it denied and the rules that denied it. `planDigest` is the override digest. */
export interface OverridePendingRecord extends PendingGateRecord {
  /** The plan digest the policy denied. */
  plan: string;
  /** The ids of the rules that denied it, sorted. */
  rules: string[];
}

export interface OverridePendingInput {
  subject: string;
  planDigest: string;
  rules: readonly string[];
  /** ISO-8601. */
  timestamp: string;
  /** ISO-8601; past it a run that is still denied records a fresh fact. */
  expiresAt: string;
  description?: string;
  runId?: string;
  url?: string;
}

/** The pending fact a run records when the policy denies a plan and no override counts for it ({@link decideOverride} returns no `standing` fact). Appending it is the caller's. */
export function overridePending(input: OverridePendingInput): OverridePendingRecord {
  const rules = sortedRules(input.rules);
  return {
    version: 1,
    kind: "pending",
    op: OVERRIDE_OP,
    gate: input.subject,
    timestamp: input.timestamp,
    expiresAt: input.expiresAt,
    planDigest: overrideDigest(input.subject, input.planDigest, rules),
    plan: input.planDigest,
    rules,
    description: input.description ?? `the policy denied this plan (${rules.join(", ")})`,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.url ? { url: input.url } : {}),
  };
}

const time = (iso: string): number => new Date(iso).getTime();

/** The denials on the ledger: each subject's newest pending fact of the override op that names a plan. Sorted by subject. */
export function recordedDenials(pending: readonly PendingGateRecord[]): OverridePendingRecord[] {
  const newest = new Map<string, PendingGateRecord>();
  for (const p of pending) {
    if (p.op !== OVERRIDE_OP || !p.planDigest) continue;
    const before = newest.get(p.gate);
    if (!before || time(p.timestamp) >= time(before.timestamp)) newest.set(p.gate, p);
  }
  return [...newest.values()]
    .map((p) => {
      const r = p as Partial<OverridePendingRecord>;
      return { ...p, plan: typeof r.plan === "string" ? r.plan : "", rules: Array.isArray(r.rules) ? sortedRules(r.rules.filter((x): x is string => typeof x === "string")) : [] };
    })
    .sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : 0));
}

// ── who may override, at base ────────────────────────────────────────────

/** The overriders file at base. */
export interface Overriders {
  /** The commit it was read at. */
  base: string | null;
  path: string;
  /** Whether the file exists at base. Without it nobody may override. */
  active: boolean;
  principals: string[];
}

/** The principals in an overriders file: one per line, blank lines and `#` comments skipped. */
export function parseOverriders(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * The overriders at `base` (a commit the repository holds, such as
 * `baseCommit(repo)` from `@intentius/chant/gate-decision`), from `path`
 * (default {@link OVERRIDERS_PATH}). Read at base, so the change being
 * applied cannot add the person who overrides its own denial. A product that
 * keeps its list in its own config at base reads it there and passes the
 * principals to {@link decideOverride} instead.
 */
export function overridersAt(repo: string, base: string, path = OVERRIDERS_PATH): Overriders {
  const r = spawnSync("git", ["cat-file", "blob", `${base}:${path}`], { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) return { base, path, active: false, principals: [] };
  return { base, path, active: true, principals: parseOverriders(r.stdout) };
}

// ── the decision ─────────────────────────────────────────────────────────

/** A line of `_gates/policy-override/applied.jsonl`: a run applied under the override of `planDigest` made at `approvedAt`. */
export interface AppliedOverrideRecord {
  version: 1;
  kind: "applied";
  op: string;
  /** The subject. */
  gate: string;
  /** The override digest. */
  planDigest: string;
  /** The override's own timestamp: every override of this digest at or before it is spent. */
  approvedAt: string;
  approvedBy: string;
  /** When the run recorded it. */
  timestamp: string;
  runId?: string;
  commit?: string;
}

/** The applied records in the text of an applied file. Malformed lines, and lines of another kind, are skipped. */
export function parseAppliedOverrides(text: string): AppliedOverrideRecord[] {
  const out: AppliedOverrideRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.version === 1 && r.kind === "applied" && typeof r.op === "string" && typeof r.gate === "string" && typeof r.planDigest === "string" && typeof r.approvedAt === "string") {
        out.push(r as unknown as AppliedOverrideRecord);
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** What judges an override line: who may write one, the approval mode, and under `sealed` the signers at base. */
export interface OverrideRule {
  /** The principals who may override (an overriders file's, or a product's own list at base). */
  overriders: readonly string[];
  /** Where they were read, for the refusals. Default {@link OVERRIDERS_PATH}. */
  overridersPath?: string;
  /** `sealed` counts only a seal that verifies; `ledger` and `pr-review` count an unsealed override (an override is a person's line on the ledger, never a review). Default `ledger`. */
  mode?: GateApprovalSource;
  /** The signers at base (`gateSignersAt`). Under `sealed`, absent means nothing counts. */
  signers?: GateSigners;
}

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/** Why this ledger line does not count as an override, or null when it does. */
export function overrideRefusal(rule: OverrideRule, r: GateResolutionRecord): string | null {
  const line = r as GateResolutionRecord & { via?: unknown };
  if (line.via !== undefined) return `the override line was written by a job (via ${String(line.via)}), and an override is a person's`;
  if (r.review !== undefined) return `the override line came from the review of #${r.review.pr}, and an override is a person's own line`;
  if (r.approver?.kind === "agent") return `the override by ${r.resolvedBy} was recorded by an agent, and an override is a person's`;
  const where = `${rule.overridersPath ?? OVERRIDERS_PATH} at base`;
  if (!rule.overriders.map(norm).includes(norm(r.resolvedBy))) {
    return `${r.resolvedBy} is not listed in ${where}${rule.overriders.length ? ` (${rule.overriders.join(", ")})` : ", which lists nobody"}`;
  }
  if (!r.note?.trim()) return `the override by ${r.resolvedBy} gives no reason`;
  if (rule.mode === "sealed") {
    const signers = rule.signers ?? { base: null, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], problems: ["no signers were read for this sealed override"] };
    return gateSealRefusal(signers, r);
  }
  return null;
}

export interface OverrideInput extends OverrideRule {
  /** The lines of `_gates/policy-override.jsonl`. Lines of other ops are ignored. */
  ledger: { resolutions: readonly GateResolutionRecord[]; pending: readonly PendingGateRecord[] };
  /** The lines of `_gates/policy-override/applied.jsonl`. Absent reads as none. */
  applied?: readonly AppliedOverrideRecord[];
  subject: string;
  /** The plan digest the policy denied. */
  planDigest: string;
  /** The ids of the rules that denied it. */
  rules: readonly string[];
  /** ISO-8601 now, for whether the standing pending fact has expired. */
  now?: string;
}

/** An override that counts. */
export interface StandingOverride {
  subject: string;
  by: string;
  at: string;
  reason: string;
  rules: string[];
  /** The plan digest it lets through. */
  planDigest: string;
  /** The override digest. */
  digest: string;
  sealed: boolean;
  resolution: GateResolutionRecord;
}

export type OverrideDecision =
  /** An override of this digest counts: the run may apply this plan, after recording {@link appliedOverride}. */
  | { status: "overridden"; digest: string; override: StandingOverride }
  /**
   * No override counts. `refusals` says why each override of this digest
   * does not. `standing` is the unexpired pending fact for this digest, so a
   * run that finds one records no other. `spent` is the newest override of
   * another digest a run already applied under.
   */
  | { status: "none"; digest: string; refusals: string[]; standing?: OverridePendingRecord; spent?: { digest: string; by: string; at: string } }
  /** An override counts for another digest and was never applied: the plan or its rules changed after it was written. */
  | { status: "moved"; digest: string; by: string; was: string | undefined; refusals: string[]; standing?: OverridePendingRecord };

/**
 * Decide one denied plan against the override ledger, as `decideGateApproval`
 * decides a gate: a line counts only when it is an override of this subject
 * newer than the subject's newest pending fact, names this digest, passes
 * {@link overrideRefusal}, and is not spent (an applied record of its digest
 * made at or after it). The newest counting line wins.
 *
 * Decide before recording a denial: an override written after an expired
 * pending fact still counts, and a run that records a fresh fact first would
 * make it older than the anchor.
 */
export function decideOverride(input: OverrideInput): OverrideDecision {
  const rules = sortedRules(input.rules);
  const digest = overrideDigest(input.subject, input.planDigest, rules);
  const pending = input.ledger.pending.filter((p) => p.op === OVERRIDE_OP);
  const latest = latestPendingGate(pending as PendingGateRecord[], input.subject);
  const since = latest ? time(latest.timestamp) : 0;
  const applied = (input.applied ?? []).filter((a) => a.op === OVERRIDE_OP && a.gate === input.subject);
  const spentBy = (r: GateResolutionRecord): AppliedOverrideRecord | undefined =>
    r.planDigest === undefined ? undefined : applied.find((a) => samePlanDigest(a.planDigest, r.planDigest) && time(a.approvedAt) >= time(r.timestamp));
  const newer = (r: GateResolutionRecord, best: GateResolutionRecord | undefined) => !best || time(r.timestamp) >= time(best.timestamp);

  let matched: GateResolutionRecord | undefined;
  let mismatched: GateResolutionRecord | undefined;
  let used: GateResolutionRecord | undefined;
  const refusals: string[] = [];
  for (const r of input.ledger.resolutions) {
    if (r.op !== OVERRIDE_OP || r.gate !== input.subject || time(r.timestamp) < since) continue;
    const why = overrideRefusal(input, r);
    const spent = spentBy(r);
    if (samePlanDigest(r.planDigest, digest)) {
      if (why !== null) refusals.push(why);
      else if (spent) refusals.push(`the override by ${r.resolvedBy} at ${r.timestamp} is spent: a run applied under it at ${spent.timestamp}`);
      else if (newer(r, matched)) matched = r;
    } else if (why !== null) {
      continue;
    } else if (spent) {
      if (newer(r, used)) used = r;
    } else if (newer(r, mismatched)) {
      mismatched = r;
    }
  }

  if (matched) {
    return {
      status: "overridden",
      digest,
      override: {
        subject: input.subject,
        by: matched.resolvedBy,
        at: matched.timestamp,
        reason: matched.note!.trim(),
        rules,
        planDigest: input.planDigest,
        digest,
        sealed: input.mode === "sealed",
        resolution: matched,
      },
    };
  }
  const now = input.now ?? new Date().toISOString();
  const standing = latest && time(latest.expiresAt) > time(now) && samePlanDigest(latest.planDigest, digest)
    ? recordedDenials([latest])[0]
    : undefined;
  if (mismatched) return { status: "moved", digest, by: mismatched.resolvedBy, was: mismatched.planDigest, refusals, ...(standing ? { standing } : {}) };
  return {
    status: "none",
    digest,
    refusals,
    ...(standing ? { standing } : {}),
    ...(used ? { spent: { digest: used.planDigest!, by: used.resolvedBy, at: used.timestamp } } : {}),
  };
}

/**
 * The applied record a run appends before it applies under `override`, which
 * spends it. Appending it is the caller's. It reads only the subject, the
 * override digest and the override's time and approver, so a product that
 * carries those through its own record can pass them without the ledger line
 * (#3823); a whole {@link StandingOverride} still works.
 */
export function appliedOverride(override: Pick<StandingOverride, "subject" | "digest" | "at" | "by">, at: { timestamp: string; runId?: string; commit?: string }): AppliedOverrideRecord {
  return {
    version: 1,
    kind: "applied",
    op: OVERRIDE_OP,
    gate: override.subject,
    planDigest: override.digest,
    approvedAt: override.at,
    approvedBy: override.by,
    timestamp: at.timestamp,
    ...(at.runId ? { runId: at.runId } : {}),
    ...(at.commit ? { commit: at.commit } : {}),
  };
}

/**
 * The applied records as applies for the audit reader
 * (`@intentius/chant/lifecycle/gate-audit`), each citing the override it
 * spent, so the trail shows an `override-spent` entry for it and a gap when
 * the ledger holds no such override. A product that records its applies
 * elsewhere cites the override on its own apply instead.
 */
export function overrideAuditApplies(applied: readonly AppliedOverrideRecord[], path = OVERRIDE_APPLIED): GateAuditApply[] {
  return applied.map((a, i) => ({
    ref: `${path}:${i + 1}`,
    at: a.timestamp,
    gate: a.gate,
    op: a.op,
    approval: "not-required",
    overrides: [{ gate: a.gate, digest: a.planDigest }],
    detail: { approvedBy: a.approvedBy, approvedAt: a.approvedAt, ...(a.runId ? { runId: a.runId } : {}), ...(a.commit ? { commit: a.commit } : {}) },
  }));
}
