/**
 * The approvals a wave applied under, and the rule that spends them (#3784).
 *
 * terragucci's wave gate writes one line to `_gates/<op>/applied.jsonl` on
 * `chant/lifecycle` before a wave applies under an approval: the gate, the
 * digest, and the approval's own timestamp. From then on that approval is
 * spent. It does not let the same digest through again, and it no longer
 * stands as the approval of another digest either. Op waves write the same
 * line, in the same file, when their spec sets `approvals.spend`, and
 * `decideGateApproval` (`../gate-decision.ts`) and `evaluateGate`
 * (`../op/gate.ts`) take the lines to leave spent approvals out.
 *
 * The file sits in a directory under `_gates/`, so the readers of
 * `_gates/<op>.jsonl` never see its lines. {@link appliedGateApplies} hands
 * them to `gate-audit` as applies, each tied to the approval it ran under.
 *
 * Pure: no git, no clock, no file. It bundles into `@intentius/chant/gate-decision`.
 */

import { samePlanDigest } from "./plan-digest";
import type { GateAuditApply } from "./gate-audit";
import type { GateRunLocator } from "../op/gate-run-locator";

/** One approval a wave applied under: the approval of `planDigest` made at `approvedAt` was used. */
export interface AppliedGateRecord {
  version: 1;
  kind: "applied";
  op: string;
  gate: string;
  planDigest: string;
  /** The approval's own timestamp, as the ledger holds it. Every approval of this gate and digest at or before it is spent. */
  approvedAt: string;
  approvedBy: string;
  /** When the wave recorded it, just before it applied. */
  timestamp: string;
  /** The wave, by number and name, for an Op waves record. */
  wave?: { number: number; name: string };
  /** The pull request review the approval came from, under `pr-review`. */
  review?: { pr?: number; head?: string };
  runId?: string;
  commit?: string;
  /**
   * Where the run applying runs (#3858), as a pending fact's `resume` names
   * it. A line that carries one and has no {@link FinishedGateRecord} is an
   * apply that may have stopped: `chant run resume` starts that run again
   * once it is gone, and the wave applies the rest under the same approval.
   */
  resume?: GateRunLocator;
}

/**
 * A line of `applied.jsonl` that a wave applying under an approval writes
 * (#3858): chant's own `applied` line, or a product's `changes` line beside
 * it (terragucci's, which names the changes the approved plans make). Both
 * name the approval the apply ran under.
 */
export type AppliedGateLine = Omit<AppliedGateRecord, "kind"> & { kind: "applied" | "changes" };

/**
 * How the apply an applied line names ended, in the same file (#3858). A
 * product writes it when the apply finishes; an apply that was killed writes
 * none. `applied` is that line's `timestamp`.
 */
export interface FinishedGateRecord {
  version: 1;
  kind: "finished";
  op: string;
  gate: string;
  planDigest: string;
  applied: string;
  result: "applied" | "failed";
  timestamp: string;
}

/** Where the applied lines of `op` live on `chant/lifecycle`: the directory and the file, as `writeBlobToPath` takes them. */
export function appliedGatePath(op: string): { dir: string; file: string } {
  return { dir: `_gates/${op}`, file: "applied.jsonl" };
}

/** The applied lines of an `applied.jsonl` file, oldest first. A line that is not one is skipped. */
export function parseAppliedGateLines(text: string): AppliedGateRecord[] {
  const out: AppliedGateRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      r?.version === 1 && r.kind === "applied" && typeof r.op === "string" && typeof r.gate === "string" &&
      typeof r.planDigest === "string" && typeof r.approvedAt === "string" && typeof r.timestamp === "string"
    ) {
      out.push({ approvedBy: "", ...r } as unknown as AppliedGateRecord);
    }
  }
  return out;
}

const time = (iso: string): number => new Date(iso).getTime();

/**
 * Every line of an `applied.jsonl` file a resume reads (#3858): the
 * `applied` and `changes` lines, and the `finished` lines that say how an
 * apply ended. Oldest first; a line that is none of them is skipped.
 */
export function parseAppliedGateFile(text: string): { applied: AppliedGateLine[]; finished: FinishedGateRecord[] } {
  const applied: AppliedGateLine[] = [];
  const finished: FinishedGateRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r?.version !== 1 || typeof r.gate !== "string" || typeof r.planDigest !== "string" || typeof r.timestamp !== "string") continue;
    if ((r.kind === "applied" || r.kind === "changes") && typeof r.approvedAt === "string") {
      applied.push({ op: "", approvedBy: "", ...r } as unknown as AppliedGateLine);
    } else if (r.kind === "finished" && typeof r.applied === "string" && (r.result === "applied" || r.result === "failed")) {
      finished.push({ op: "", ...r } as unknown as FinishedGateRecord);
    }
  }
  return { applied, finished };
}

/** The finished line for the apply `line` names, or undefined while it has none. */
export function finishedApply(finished: readonly FinishedGateRecord[], line: Pick<AppliedGateLine, "gate" | "planDigest" | "timestamp">): FinishedGateRecord | undefined {
  return finished.find((f) => f.gate === line.gate && samePlanDigest(f.planDigest, line.planDigest) && time(f.applied) === time(line.timestamp));
}

/**
 * Whether an approval is spent: a wave applied under an approval of the same
 * gate and digest made at or after it. One that names no digest is never
 * spent. With `review`, an approval that came from a pull request's review
 * is spent too when a wave applied this digest under a review of the same
 * head, so the review cannot be recorded again to pass the digest twice. A
 * review not yet recorded has no `timestamp`.
 */
export function isApprovalSpent(
  applied: readonly Pick<AppliedGateRecord, "gate" | "planDigest" | "approvedAt" | "review">[],
  approval: { gate: string; planDigest?: string; timestamp?: string; review?: { pr?: number; head?: string } },
): boolean {
  const digest = approval.planDigest;
  if (digest === undefined) return false;
  return applied.some(
    (a) =>
      a.gate === approval.gate &&
      samePlanDigest(a.planDigest, digest) &&
      ((approval.timestamp !== undefined && time(a.approvedAt) >= time(approval.timestamp)) ||
        (approval.review?.head !== undefined && a.review?.head === approval.review.head)),
  );
}

/**
 * The applied lines as `gate-audit` applies: each an `applied` entry tied to
 * the approval it ran under. `ref` names the file, `_gates/<op>/applied.jsonl`
 * by default; each line's index is appended so ids stay stable.
 */
export function appliedGateApplies(records: readonly AppliedGateRecord[], ref?: string): GateAuditApply[] {
  return records.map((r, i) => ({
    ref: `${ref ?? `_gates/${r.op}/applied.jsonl`}#${i + 1}`,
    at: r.timestamp,
    gate: r.gate,
    op: r.op,
    digest: r.planDigest,
    approval: "required" as const,
    detail: {
      approvedAt: r.approvedAt,
      approvedBy: r.approvedBy,
      ...(r.wave ? { wave: r.wave } : {}),
      ...(r.review ? { review: r.review } : {}),
      ...(r.runId ? { runId: r.runId } : {}),
      ...(r.commit ? { commit: r.commit } : {}),
    },
  }));
}
