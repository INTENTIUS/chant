/**
 * What a resume would start again, decided from the ledger alone (#3858).
 *
 * `chant run resume` starts again the CI job behind a gate an approval now
 * answers (`./gate-resume.ts`). A product that resumes in its own job, such
 * as terragucci's GitHub and Forgejo resume job, which applies the waves
 * itself from wave 1 with a read-only token, needs the same decision without
 * the forge call. {@link planGateResumes} makes it, per gate:
 *
 * - A standing pending fact (the newest per gate and environment, not
 *   expired) is resumable when an approval answers it, or when the decision
 *   point it cites has an answer the gate passes on. One whose answering
 *   approval a wave already applied under (`approvals.spend`,
 *   `_gates/<op>/applied.jsonl`, #3784) is `spent`: that apply ran, so there
 *   is nothing to resume, and a resumed run would only wait again.
 * - An apply that stopped: the newest applied line of a gate carries a run
 *   locator (`resume`), no `finished` line says how it ended, and no pending
 *   fact of the gate is newer. It is resumable once the run that applied is
 *   gone, which only the forge can say: the caller checks that
 *   (`resumeGateRun` does, and `chant run resume --dry-run` asks it without
 *   starting anything). The resumed wave applies the rest under the same
 *   approval.
 *
 * Pure: no git, no forge, no clock, no Ajv. It imports the run locator's
 * check, the ledger's selection rules and `pointGateResumable`, all of which
 * bundle on their own, so a product can bundle
 * `@intentius/chant/op/gate-resume-plan` (`gate-resume-plan-bundle.test.ts`).
 */

import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { isPendingGateExpired, latestResolutionForPlan } from "../lifecycle/gate-ledger-select";
import { finishedApply, isApprovalSpent, type AppliedGateLine, type FinishedGateRecord } from "../lifecycle/gate-applied";
import { samePlanDigest } from "../lifecycle/plan-digest";
import { pointGateResumable, type PointQuestionState } from "../point-decision";
import { isGateRunLocator, type GateRunLocator } from "./gate-run-locator";

/**
 * Why a gate would or would not resume:
 *
 * - `approved`: an approval answers its standing pending fact, and no wave applied under it yet.
 * - `answered`: the decision point it waits on has an answer the gate passes on.
 * - `not-approved`: nothing answers it yet.
 * - `spent`: the approval that answers it is spent; a wave already applied under it.
 * - `stopped`: an apply under an approval stopped before it said how it ended.
 */
export type GateResumeReason = "approved" | "answered" | "not-approved" | "spent" | "stopped";

/** One gate a resume looks at, and what the ledger says about it. */
export interface GateResumeCandidate {
  /** A standing pending fact, or an apply under an approval that stopped. */
  source: "pending" | "stopped";
  op: string;
  gate: string;
  environment?: string;
  planDigest?: string;
  /**
   * The ledger says to resume it. For `stopped`, only once the run that
   * applied is gone, which the caller checks with the forge.
   */
  resumable: boolean;
  reason: GateResumeReason;
  message: string;
  approvedBy?: string;
  /** The answering approval's timestamp, or the answer's date. A Forgejo run created after it was already resumed. */
  approvedAt?: string;
  /** The job to start again: the pending fact's `resume`, or the stopped apply's. */
  run?: GateRunLocator;
  /** The wave applied under the answering approval at `appliedAt`. */
  spent?: { appliedAt: string; approvedAt: string; wave?: { number: number; name: string } };
  /** The apply that stopped: when it began, the approval it ran under, and its wave. */
  stopped?: { appliedAt: string; approvedAt: string; kind: AppliedGateLine["kind"]; wave?: { number: number; name: string } };
  /** The standing pending fact, for a product that reads its own fields (a commit, a description). */
  pending?: PendingGateRecord;
}

/** The resolution that answers `standing` under its approval block (`resolutionAnswering` in `./gate-resume.ts`). */
export type GateAnswering = (
  resolutions: readonly GateResolutionRecord[],
  standing: PendingGateRecord,
  pending: readonly PendingGateRecord[],
) => GateResolutionRecord | undefined;

export interface PlanGateResumesInput {
  /** The op whose ledger these are. */
  op: string;
  pending: readonly PendingGateRecord[];
  resolutions: readonly GateResolutionRecord[];
  /** The `applied` and `changes` lines of `_gates/<op>/applied.jsonl` (`parseAppliedGateFile`). */
  applied?: readonly AppliedGateLine[];
  /** Its `finished` lines. */
  finished?: readonly FinishedGateRecord[];
  now: string;
  /** Only this gate. */
  gate?: string;
  /** The workspace's questions by id, for a fact that cites a decision point. */
  questions?: ReadonlyMap<string, PointQuestionState>;
  /**
   * Which resolution answers a fact. Default: the newest approval of its plan
   * since the fact. A fact with an `approval` block (a quorum, a policy)
   * needs chant's tally: pass `resolutionAnswering` from
   * `@intentius/chant/op/gate-resume`, which `chant run resume` uses.
   */
  answering?: GateAnswering;
}

const time = (iso: string): number => new Date(iso).getTime();

/** The newest pending fact per gate and environment: the facts a run still waits on. */
export function standingGateFacts(pending: readonly PendingGateRecord[], gate?: string): PendingGateRecord[] {
  const newest = new Map<string, PendingGateRecord>();
  for (const p of pending) {
    if (gate !== undefined && p.gate !== gate) continue;
    const key = `${p.gate}\u0000${p.environment ?? ""}`;
    const prior = newest.get(key);
    if (!prior || time(p.timestamp) >= time(prior.timestamp)) newest.set(key, p);
  }
  return [...newest.values()];
}

/** The newest approval of the fact's plan since the fact, when it has no approval block. */
const defaultAnswering: GateAnswering = (resolutions, standing) => {
  if (standing.approval) return undefined;
  const mine = resolutions.filter((r) => standing.environment === undefined || r.environment === standing.environment);
  return latestResolutionForPlan(mine, standing.gate, standing.timestamp, standing.planDigest).resolution;
};

/** The applied line that spent an approval of `gate` and `digest` made at `approvedAt`, if one did. */
function spentBy(applied: readonly AppliedGateLine[], gate: string, digest: string | undefined, approval: GateResolutionRecord): AppliedGateLine | undefined {
  if (digest === undefined) return undefined;
  const probe = { gate, planDigest: digest, timestamp: approval.timestamp, ...(approval.review ? { review: { pr: approval.review.pr, head: approval.review.head } } : {}) };
  if (!isApprovalSpent(applied, probe)) return undefined;
  return applied.find((a) => isApprovalSpent([a], probe));
}

/** Decide, for each standing pending fact and each stopped apply of an op, whether a resume would start its job again and why. */
export function planGateResumes(input: PlanGateResumesInput): GateResumeCandidate[] {
  const applied = input.applied ?? [];
  const finished = input.finished ?? [];
  const answering = input.answering ?? defaultAnswering;
  const out: GateResumeCandidate[] = [];

  const standing = standingGateFacts(input.pending, input.gate).filter((p) => !isPendingGateExpired(p, input.now));
  for (const p of standing) {
    const base = {
      source: "pending" as const,
      op: p.op || input.op,
      gate: p.gate,
      ...(p.environment !== undefined ? { environment: p.environment } : {}),
      ...(p.planDigest !== undefined ? { planDigest: p.planDigest } : {}),
      ...(isGateRunLocator(p.resume) ? { run: p.resume } : {}),
      pending: p,
    };
    if (p.answer) {
      const check = pointGateResumable(p, input.questions?.get(p.answer.id));
      if (!check.resumable) {
        out.push({ ...base, resumable: false, reason: "not-approved", message: check.message });
        continue;
      }
      // The resolution a wave recorded when it went through on this answer, if one did, is what an apply spends.
      const cited = input.resolutions.filter((r) => r.gate === p.gate && r.answer?.id === p.answer!.id && samePlanDigest(r.planDigest, p.planDigest));
      const used = cited.map((r) => ({ r, by: spentBy(applied, p.gate, p.planDigest, r) })).find((x) => x.by);
      if (used?.by) {
        out.push({ ...base, resumable: false, reason: "spent", approvedBy: check.answeredBy, approvedAt: used.r.timestamp, message: spentMessage(used.by), spent: spentOf(used.by) });
        continue;
      }
      out.push({ ...base, resumable: true, reason: "answered", approvedBy: check.answeredBy, ...(check.answeredOn ? { approvedAt: check.answeredOn } : {}), message: `question ${p.answer.id} has an answer the gate passes on` });
      continue;
    }
    const answer = answering(input.resolutions, p, input.pending);
    if (!answer) {
      out.push({ ...base, resumable: false, reason: "not-approved", message: p.approval && !input.answering ? "its gate has an approval block, which needs chant's tally (pass answering)" : "no approval answers it yet" });
      continue;
    }
    const by = spentBy(applied, p.gate, p.planDigest, answer);
    if (by) {
      out.push({ ...base, resumable: false, reason: "spent", approvedBy: answer.resolvedBy, approvedAt: answer.timestamp, message: spentMessage(by), spent: spentOf(by) });
      continue;
    }
    out.push({ ...base, resumable: true, reason: "approved", approvedBy: answer.resolvedBy, approvedAt: answer.timestamp, message: `approved by ${answer.resolvedBy} at ${answer.timestamp}` });
  }

  for (const line of stoppedApplies(applied, finished, input.pending, input.gate)) {
    out.push({
      source: "stopped",
      op: line.op || input.op,
      gate: line.gate,
      planDigest: line.planDigest,
      resumable: true,
      reason: "stopped",
      approvedBy: line.approvedBy,
      approvedAt: line.approvedAt,
      run: line.resume!,
      stopped: { appliedAt: line.timestamp, approvedAt: line.approvedAt, kind: line.kind, ...(line.wave ? { wave: line.wave } : {}) },
      message: `the apply of ${line.planDigest} under the approval by ${line.approvedBy || "?"} began at ${line.timestamp} and never recorded how it ended; it resumes once run ${line.resume!.run} is gone`,
    });
  }
  return out;
}

const spentOf = (a: AppliedGateLine): NonNullable<GateResumeCandidate["spent"]> => ({ appliedAt: a.timestamp, approvedAt: a.approvedAt, ...(a.wave ? { wave: a.wave } : {}) });
const spentMessage = (a: AppliedGateLine): string =>
  `the approval that answers it is spent: ${a.wave ? `wave ${a.wave.number} (${a.wave.name})` : "a wave"} applied under it at ${a.timestamp}`;

/**
 * Per gate, the apply that may have stopped: the gate's newest applied line,
 * or the line that names the same approval and carries a run locator, with
 * no finished line for it and no pending fact of the gate since.
 */
function stoppedApplies(applied: readonly AppliedGateLine[], finished: readonly FinishedGateRecord[], pending: readonly PendingGateRecord[], gate?: string): AppliedGateLine[] {
  const newest = new Map<string, AppliedGateLine>();
  for (const a of applied) {
    if (gate !== undefined && a.gate !== gate) continue;
    const prior = newest.get(a.gate);
    if (!prior || time(a.timestamp) >= time(prior.timestamp)) newest.set(a.gate, a);
  }
  const out: AppliedGateLine[] = [];
  for (const [g, last] of newest) {
    const sameApply = applied.filter(
      (a) => a.gate === g && samePlanDigest(a.planDigest, last.planDigest) && time(a.approvedAt) === time(last.approvedAt) && isGateRunLocator(a.resume),
    );
    const line = sameApply.reduce<AppliedGateLine | undefined>((n, a) => (!n || time(a.timestamp) >= time(n.timestamp) ? a : n), undefined);
    if (!line) continue;
    if (sameApply.some((a) => finishedApply(finished, a))) continue;
    if (pending.some((p) => p.gate === g && time(p.timestamp) > time(line.timestamp))) continue;
    out.push(line);
  }
  return out;
}
