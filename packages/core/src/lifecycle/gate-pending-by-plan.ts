/**
 * Pending gates by plan digest (#4607): the standing pending facts on the
 * gate ledgers whose plan, or change set, is the digest a person was shown.
 *
 * A product prints a digest in its note and asks people to approve it. To
 * record that approval, chant needs the op and gate the digest waits at; for
 * a pull request's gate the op is `pr-<n>` or `pr-<n>-<member>`
 * (`prOp`, ../pr-loop.ts), so the digest alone names the pull request. This
 * is what lets `plywood approve up --plan <digest>` drop its `--pr`.
 *
 * A fact stands when it is the newest pending fact of its gate (per
 * environment), has not expired, and no resolution of that gate is newer
 * than it: the rule `chant operator status` reads gates by
 * (`pendingGatesFor`, ../cli/handlers/operator.ts). The match is
 * `samePlanDigest`, so either digest prefix finds the fact.
 *
 * {@link standingPendingByPlan} reads no git, so a product can run it over
 * ledger text it fetched itself; {@link pendingGatesByPlan} reads every
 * `_gates/<op>.jsonl` file of the ledger at `cwd` (the member's own, in a
 * workspace member's checkout).
 */

import { isPendingGateExpired, latestResolutionSince } from "./gate-ledger-select";
import { samePlanDigest } from "./plan-digest";
import type { GateResolutionRecord, PendingGateRecord } from "./gate-ledger";
import type { LedgerLocation } from "./git";

/** A pull request gate's op: `pr-<n>`, or `pr-<n>-<member>` (#3465). */
const PR_OP = /^pr-(\d+)(?:-(.+))?$/;

/** The pull request and member a gate's op names, or undefined for an op that is not a pull request's. */
export function pullRequestOfOp(op: string): { pr: number; member?: string } | undefined {
  const m = PR_OP.exec(op);
  if (!m) return undefined;
  return { pr: Number(m[1]), ...(m[2] ? { member: m[2] } : {}) };
}

/** One standing pending fact a digest matched. */
export interface PendingGateByPlan {
  op: string;
  gate: string;
  /** The pull request, when the op is a pull request's (`pr-<n>[-<member>]`). */
  pr?: number;
  /** The workspace member the pull request's op names. */
  member?: string;
  /** Which of the fact's digests matched: its plan, or the change set it cites (#4551). */
  matched: "planDigest" | "changeSet";
  planDigest?: string;
  changeSet?: string;
  environment?: string;
  /** The op wave the fact was written by (#3887), when it was. */
  wave?: PendingGateRecord["wave"];
  url?: string;
  gitSha?: string;
  runId?: string;
  timestamp: string;
  expiresAt: string;
}

/**
 * The standing facts of one op's ledger lines whose plan or change set is
 * `digest`, newest first. A gate is read per environment, so a component
 * gate's staging and prod facts stand side by side.
 */
export function standingPendingByPlan(
  lines: { pending: readonly PendingGateRecord[]; resolutions: readonly GateResolutionRecord[] },
  digest: string,
  now: string,
): PendingGateByPlan[] {
  const newest = new Map<string, PendingGateRecord>();
  for (const p of lines.pending) {
    const key = `${p.gate}\0${p.environment ?? ""}`;
    const was = newest.get(key);
    if (!was || new Date(p.timestamp).getTime() >= new Date(was.timestamp).getTime()) newest.set(key, p);
  }
  const out: PendingGateByPlan[] = [];
  for (const p of newest.values()) {
    if (isPendingGateExpired(p, now)) continue;
    // A resolution for another environment answers that environment's fact, not this one.
    const sameEnv = lines.resolutions.filter((r) => r.environment === undefined || r.environment === p.environment);
    const answered = latestResolutionSince(sameEnv, p.gate, p.timestamp);
    if (answered) continue;
    const matched = samePlanDigest(p.planDigest, digest) ? "planDigest" : samePlanDigest(p.changeSet, digest) ? "changeSet" : undefined;
    if (!matched) continue;
    const pr = pullRequestOfOp(p.op);
    out.push({
      op: p.op,
      gate: p.gate,
      ...(pr ? { pr: pr.pr, ...(pr.member ? { member: pr.member } : {}) } : {}),
      matched,
      ...(p.planDigest ? { planDigest: p.planDigest } : {}),
      ...(p.changeSet ? { changeSet: p.changeSet } : {}),
      ...(p.environment ? { environment: p.environment } : {}),
      ...(p.wave ? { wave: p.wave } : {}),
      ...(p.url ? { url: p.url } : {}),
      ...(p.gitSha ? { gitSha: p.gitSha } : {}),
      ...(p.runId ? { runId: p.runId } : {}),
      timestamp: p.timestamp,
      expiresAt: p.expiresAt,
    });
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** What {@link pendingGatesByPlan} reads. */
export interface PendingGatesByPlanOptions extends LedgerLocation {
  /** One op's ledger; absent, every op's. */
  op?: string;
  /** Only pull request gates (`pr-<n>[-<member>]`). */
  pullRequestsOnly?: boolean;
  /** The time a fact's expiry is measured at. Default now. */
  now?: string;
}

/**
 * Every standing pending fact on the gate ledgers whose plan or change set is
 * `digest` (#4607), newest first. Reads the local `chant/lifecycle`; a caller
 * in CI fetches it first (`fetchLifecycle`). Returns `[]` when nothing waits
 * on the digest, and never throws for a missing ledger.
 */
export async function pendingGatesByPlan(digest: string, opts: PendingGatesByPlanOptions = {}): Promise<PendingGateByPlan[]> {
  const { op, pullRequestsOnly, now: at, ...where } = opts;
  const now = at ?? new Date().toISOString();
  const { GATES_DIR, readGateLedger } = await import("./gate-ledger");
  const { listFilesInDir } = await import("./git");
  const ops = op ? [op] : (await listFilesInDir(GATES_DIR, where)).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
  const out: PendingGateByPlan[] = [];
  for (const name of ops) {
    if (pullRequestsOnly && !pullRequestOfOp(name)) continue;
    out.push(...standingPendingByPlan(await readGateLedger(name, where), digest, now));
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
