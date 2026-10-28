/**
 * Overdue drift checks from the ledger (#4612). terragucci's
 * report/overdue.ts asks the forge when its drift job last ran, which only
 * the plan job of one repository can do. The estate reads every member at
 * once, so here the last run is the newest drift check on the member's run
 * ledger, and the rule is chant's `overdueVerdict` (../op/schedule-overdue.ts):
 * overdue once the cron has fired at least twice since that run. A member
 * with no check on record is counted from `added` when the caller knows when
 * its schedule began, and is otherwise not judged.
 *
 * The verdict keeps the plan note's {@link OverdueOp} shape, with the member
 * beside it, and its text uses the product's words: its name, its drift
 * word and its noun for a member.
 */
import { cronFiresUtc } from "../op/cron";
import type { OverdueOp } from "../op/schedule-overdue";
import { CHANT_WORDS, type CiProductWords } from "../ci-product-words";
import type { DriftRun, EstateRows } from "./rows";

/** One scheduled drift check: its Op and cron, and the members it covers. */
export interface DriftSchedule {
  op: string;
  cron: string;
  /** The members it checks. Default every member with a run of `op` on record. */
  members?: readonly string[];
}

/** A member whose drift checks stopped. */
export interface LedgerOverdue extends OverdueOp {
  member: string;
  /** The newest check on record, when there is one. */
  last?: { id: string; ended: string; status: string; runUrl?: string };
}

export interface LedgerOverdueOptions {
  words?: Pick<CiProductWords, "product" | "stages" | "noun">;
  now?: Date;
  /** When a member's schedule began (ISO 8601), for a member with no check on record. */
  added?: (op: string, member: string) => string | undefined;
}

const at = (iso: string): number => Date.parse(iso) || 0;

/** The newest drift check of `op` on `member`, by when it ended. */
function newestCheck(checks: readonly DriftRun[], op: string, member: string): DriftRun | undefined {
  let best: DriftRun | undefined;
  for (const c of checks) if (c.op === op && c.member === member && (!best || at(c.ended) > at(best.ended))) best = c;
  return best;
}

/**
 * Each member whose drift check of each schedule is overdue, sorted by
 * member and op. A member is overdue when the cron fired at least twice
 * since its newest check on record, or since `added` when it has none.
 */
export function ledgerOverdue(rows: Pick<EstateRows, "drift">, schedules: readonly DriftSchedule[], options: LedgerOverdueOptions = {}): LedgerOverdue[] {
  const words = options.words ?? CHANT_WORDS;
  const now = options.now ?? new Date();
  const out: LedgerOverdue[] = [];
  for (const s of schedules) {
    const members = s.members ?? [...new Set(rows.drift.filter((d) => d.op === s.op).map((d) => d.member))].sort();
    for (const member of members) {
      const last = newestCheck(rows.drift, s.op, member);
      const since = last?.ended ?? options.added?.(s.op, member);
      if (!since) continue;
      if (cronFiresUtc(s.cron, new Date(since), now, 2).length < 2) continue;
      const day = since.slice(0, 10);
      const what = last ? `its last check on the ledger ended on ${day}` : `no check is on the ledger since its schedule began on ${day}`;
      out.push({
        op: s.op,
        cron: s.cron,
        since,
        ...(last ? {} : { neverRan: true }),
        member,
        ...(last ? { last: { id: last.id, ended: last.ended, status: last.status, ...(last.runUrl ? { runUrl: last.runUrl } : {}) } } : {}),
        message: `${words.product} ${words.stages.drift} checks of ${words.noun[0]} \`${member}\` are overdue: the schedule \`${s.cron}\` of \`${s.op}\` has fired at least twice and ${what}.`,
      });
    }
  }
  return out.sort((a, b) => a.member.localeCompare(b.member) || a.op.localeCompare(b.op));
}
