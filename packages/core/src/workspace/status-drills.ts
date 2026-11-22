/**
 * The restore drills for `chant workspace status` (#5450): the newest drill
 * of each store, whether it met its targets, and the RTO and RPO it measured.
 *
 * Read from `<env>/drills.jsonl` under the member's prefix on `chant/lifecycle`,
 * at the branch tip status names. Nothing is written and no drill is run: a
 * line is what the last drill recorded, and its time says how long ago.
 */

import { latestDrillPerStore, parseDrillLedger, type DrillCheckResult, type DrillOutcome, type DrillRecord, type DrillShortfall, type DrillStoreKind, type DrillTargets } from "../lifecycle/drill-record";
import { defaultStageLedgerReader, type StageLedgerReader } from "./status-stages";

/** The file under an environment's directory the drills are recorded in. */
export const DRILL_LEDGER_PATH = "drills.jsonl";

/** The newest drill of one store. */
export interface StatusDrill {
  store: string;
  kind: DrillStoreKind;
  env: string;
  /** The drill's id, as its record has it. */
  id: string;
  /** The Op that ran it, or null. */
  op: string | null;
  /** When it ended. */
  at: string;
  outcome: DrillOutcome;
  /** Whether every declared target was met, or null when none was declared or a measurement is missing. */
  met: boolean | null;
  rtoMs: number | null;
  rpoMs: number | null;
  targets: DrillTargets;
  /** How far over each missed target it ran, in milliseconds. */
  shortfall: DrillShortfall;
  checks: { passed: number; total: number; failed: string[] };
  /** The backup restored, or null when none was found. */
  backup: { id: string; at: string } | null;
  /** The failure, for a drill that failed. */
  error: string | null;
  /** False when the drill left its scratch environment behind. */
  tornDown: boolean;
}

export interface MemberDrills {
  drills: StatusDrill[];
  /** Lines of the ledger that are not a drill record. */
  malformed: number;
}

function view(r: DrillRecord): StatusDrill {
  const failed = (r.checks as DrillCheckResult[]).filter((c) => !c.ok).map((c) => c.name);
  return {
    store: r.store,
    kind: r.kind,
    env: r.env,
    id: r.id,
    op: r.op ?? null,
    at: r.ended,
    outcome: r.outcome,
    met: r.met ?? null,
    rtoMs: r.rtoMs ?? null,
    rpoMs: r.rpoMs ?? null,
    targets: r.targets,
    shortfall: r.shortfall ?? {},
    checks: { passed: r.checks.length - failed.length, total: r.checks.length, failed },
    backup: r.backup ?? null,
    error: r.error ?? null,
    tornDown: r.tornDown !== false,
  };
}

/**
 * The newest drill of each store in `env`, sorted by store name. `prefix` is
 * the member's ledger prefix (`_members/<member>/`, or "" for the flat
 * layout); `commit` is the branch tip, or null when the checkout has no
 * ledger branch.
 */
export async function readMemberDrills(input: { prefix: string; env: string; commit: string | null; cwd: string; read?: StageLedgerReader }): Promise<MemberDrills> {
  if (input.commit === null) return { drills: [], malformed: 0 };
  const text = await (input.read ?? defaultStageLedgerReader)(`${input.prefix}${input.env}/${DRILL_LEDGER_PATH}`, input.commit, input.cwd);
  if (text === null) return { drills: [], malformed: 0 };
  const { records, malformed } = parseDrillLedger(text);
  return { drills: latestDrillPerStore(records).map(view), malformed };
}

/** The rows `formatStatus` prints: one per store with its newest drill. */
export function drillRows(members: readonly { name: string; drills?: StatusDrill[] }[], span: (ms: number) => string): string[][] {
  const rows: string[][] = [["MEMBER", "STORE", "LAST DRILL", "RESULT", "RTO", "RPO", "CHECKS"]];
  const cell = (measured: number | null, target: number | undefined): string =>
    measured === null ? "-" : target === undefined ? span(measured) : `${span(measured)} of ${span(target)}`;
  for (const m of members) {
    for (const d of m.drills ?? []) {
      const result = d.outcome === "passed" ? (d.met === true ? "met targets" : "passed") : d.outcome === "missed" ? "missed targets" : "failed";
      rows.push([m.name, `${d.store} (${d.kind})`, d.at, d.tornDown ? result : `${result}, scratch left`, cell(d.rtoMs, d.targets.rtoMs), cell(d.rpoMs, d.targets.rpoMs), `${d.checks.passed}/${d.checks.total}`]);
    }
  }
  return rows;
}
