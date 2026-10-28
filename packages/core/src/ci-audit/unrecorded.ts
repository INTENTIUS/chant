/**
 * The unrecorded writer audit (#4632, moved from terragucci's
 * report/unrecorded.ts and state-writers.ts): the audit log's writes
 * compared against the ledger's apply records, and every write no
 * recorded apply made reported with its writer.
 *
 * A write counts as recorded when it falls inside a recorded apply's run
 * (its record's start to its end, a second early since a log keeps times to
 * the second) and, when the apply names its principals, one of them made
 * it. A write a controller made (an AWS service) is a write by design, which
 * drift attribution covers, so it is reported apart and never as
 * unrecorded. A write younger than the settle time is left for a later run,
 * since a running apply has not ended its record yet.
 *
 * The apply records are the op run ledger's (`../lifecycle/run-ledger.ts`):
 * every op wave job that applied or tried to, and any run a caller names.
 * Only times and principals are read, never a state's contents.
 */

import type { OpRunRecord } from "../op/runtime";
import type { AuditLog, AuditWrite } from "./audit-log";

/** How long a write waits before it is judged. Default one hour. */
export const UNRECORDED_SETTLE_SECONDS = 3600;

/** One recorded apply's run. */
export interface ApplyWindow {
  run: string;
  op: string;
  started: string;
  ended: string;
  /** The principals the apply ran as, when the record names them. Absent: any writer inside the window counts. */
  principals?: string[];
}

/**
 * The applies among run records: an op wave job that applied or failed a
 * run, or any record `isApply` accepts. A record whose times do not parse
 * is left out.
 */
export function applyWindowsFromRuns(records: readonly OpRunRecord[], isApply: (r: OpRunRecord) => boolean = defaultIsApply): ApplyWindow[] {
  return records
    .filter((r) => isApply(r) && Number.isFinite(Date.parse(r.started)) && Number.isFinite(Date.parse(r.ended)))
    .map((r) => {
      const principal = r.labels?.Principal;
      return { run: r.id, op: r.op, started: r.started, ended: r.ended, ...(principal ? { principals: [principal] } : {}) };
    });
}

function defaultIsApply(r: OpRunRecord): boolean {
  const w = r.wave;
  if (w) return w.applied.length + w.failed.length > 0 || (w.targets !== undefined && Object.keys(w.targets).length > 0);
  return r.op.startsWith("pr-") || r.op.startsWith("green-");
}

export interface UnrecordedWrite extends AuditWrite {
  /** Why no recorded apply covers it. */
  why: string;
}

export interface UnrecordedReport {
  since: string;
  until: string;
  /** Writes no recorded apply made, oldest first. */
  unrecorded: UnrecordedWrite[];
  /** Writes a recorded apply covers. */
  recorded: number;
  /** Writes a controller made by design. */
  controller: AuditWrite[];
  /** Writes younger than the settle time, left for a later run. */
  pending: number;
  /** Why the log could not be read, when it could not. */
  unavailable?: string;
}

const t = (iso: string): number => Date.parse(iso);

/** Whether `who` is one of `principals`: the same string, or an assumed-role ARN whose session or role is it. */
function samePrincipal(who: string, principals: readonly string[]): boolean {
  const low = who.toLowerCase();
  return principals.some((p) => {
    const q = p.toLowerCase();
    return low === q || low.endsWith(`/${q}`) || low.includes(`:assumed-role/${q}/`);
  });
}

/** Judge each write against the apply windows. Pure. */
export function judgeWrites(
  writes: readonly AuditWrite[],
  windows: readonly ApplyWindow[],
  at: { since: string; until: string; now?: Date; settleSeconds?: number; resources?: readonly string[] },
): UnrecordedReport {
  const now = (at.now ?? new Date()).getTime();
  const settle = (at.settleSeconds ?? UNRECORDED_SETTLE_SECONDS) * 1000;
  const keep = at.resources?.length ? new Set(at.resources) : undefined;
  const report: UnrecordedReport = { since: at.since, until: at.until, unrecorded: [], recorded: 0, controller: [], pending: 0 };
  for (const w of [...writes].sort((a, b) => a.at.localeCompare(b.at))) {
    if (keep && !w.resources.some((r) => keep.has(r) || [...keep].some((k) => r.endsWith(`/${k}`) || r.endsWith(`:${k}`)))) continue;
    if (w.actor === "controller") {
      report.controller.push(w);
      continue;
    }
    const when = t(w.at);
    if (!Number.isFinite(when) || now - when < settle) {
      report.pending++;
      continue;
    }
    const inside = windows.filter((x) => when >= t(x.started) - 1000 && when <= t(x.ended) + 1000);
    const by = inside.filter((x) => !x.principals || samePrincipal(w.who, x.principals));
    if (by.length > 0) {
      report.recorded++;
      continue;
    }
    const why =
      inside.length > 0
        ? `${inside.map((x) => x.run).join(", ")} ran then as ${[...new Set(inside.flatMap((x) => x.principals ?? []))].join(", ")}, not ${w.who}`
        : "no recorded apply ran then";
    report.unrecorded.push({ ...w, why });
  }
  return report;
}

/** Read the log's writes over the window and judge them. Never throws for the log. */
export async function unrecordedWrites(
  log: AuditLog,
  windows: readonly ApplyWindow[],
  at: { since: string; until: string; now?: Date; settleSeconds?: number; resources?: readonly string[] },
): Promise<UnrecordedReport> {
  const read = await log.writes({ since: at.since, until: at.until });
  if (read.status === "unavailable") return { since: at.since, until: at.until, unrecorded: [], recorded: 0, controller: [], pending: 0, unavailable: read.reason };
  return judgeWrites(read.writes, windows, at);
}

/** The report as lines for an issue or a log. */
export function renderUnrecorded(report: UnrecordedReport): string {
  if (report.unavailable) return `The audit log could not be read, so no write was judged: ${report.unavailable}.`;
  const lines = [`Between ${report.since} and ${report.until}: ${report.unrecorded.length} write${report.unrecorded.length === 1 ? "" : "s"} no recorded apply made, ${report.recorded} recorded, ${report.controller.length} by a controller, ${report.pending} too recent to judge.`];
  for (const w of report.unrecorded) lines.push(`- ${w.at} ${w.event} by ${w.who}${w.resources.length ? ` on ${w.resources.join(", ")}` : ""}: ${w.why}`);
  return lines.join("\n");
}
