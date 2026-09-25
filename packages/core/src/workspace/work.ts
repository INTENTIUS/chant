/**
 * Work items on read (#2683): a record kind with a `work` block.
 *
 * A work item is a record in the workspace, a git-tracked file with its
 * dependencies written inside it, that people and agents share as one queue
 * with no server. Most work items come from a gap the intent graph already
 * reports (`source.finding`), given an id, an owner and a lifecycle.
 *
 * `records.ts` calls {@link applyWork} after it has read a work kind's
 * records, before it sets `valid` and applies `--current`. This module reads
 * the decision kind the work kind names, at the same revision, and gives each
 * work record:
 *
 * - `ready`: its state is the kind's open state, every need is done, and the
 *   record is valid and not superseded;
 * - `blockedBy`: each need that is not done, with its state;
 * - `implements`: each decision it names, with that decision's state;
 *
 * and each decision `implementedBy`, the work records naming it. The
 * warnings are closed codes. `work-done-gap-open` is not raised here: only
 * `graph --intent` walks a region, so only it can tell whether the finding a
 * done item came from still fires. It never writes a record.
 */

import { dirname } from "node:path";
import type { ReasonCode } from "./reason-codes";
import { loadRecordKind, readRecords, type LoadedRecordKind, type ReadRecordsOptions, type RecordEntry } from "./records";

/** Why a work record carries a warning. Closed, like the record warning codes. */
export const WORK_WARNING_CODES = [
  /** A `needs` entry names a work id no record has. */
  "work-needs-unknown",
  /** An `implements` entry names a decision id no decision has. */
  "work-implements-unknown",
  /** The record needs itself through its `needs` links, so it can never be ready. */
  "work-needs-cycle",
  /** The record implements a decision whose state is not approved, such as proposed or withdrawn. */
  "work-implements-undecided",
  /** The record is done and its evidence list is empty: nothing shows the work was done. */
  "work-done-unpinned",
  /** The record is in a closed state and has no closing date. */
  "work-closed-without-date",
  /** The record is done, and the finding it came from (`source.finding`) still fires on its region. Raised by `graph --intent` only. */
  "work-done-gap-open",
] as const satisfies readonly ReasonCode[];
export type WorkWarningCode = (typeof WORK_WARNING_CODES)[number];

/** A link from a work record to another record, with that record's state now. */
export interface WorkLink {
  id: string;
  /** The linked record's state, or null when no record has the id. */
  state: string | null;
}

/** A decision as a work read lists it: its state and the work records implementing it. */
export interface DecisionWork {
  id: string;
  path: string;
  state: string | null;
  supersededBy: string | null;
  implementedBy: WorkLink[];
}

/** The strings of a front-matter list, or none. */
export function idList(data: Record<string, unknown> | null, field: string): string[] {
  const v = data?.[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Whether `state` counts as decided in the decision kind: ranked above 0 by
 * its approval ranks, or, for a kind without them, closed.
 */
export function isDecided(kind: LoadedRecordKind["kind"], state: string | null): boolean {
  if (state === null) return false;
  return kind.approval ? (kind.approval[state] ?? 0) > 0 : (kind.closedStates ?? []).includes(state);
}

/**
 * Give each work record its links, ready and blockedBy, and its warnings, in
 * place. Throws a `RecordReadError` when the decision kind can't be read.
 */
export async function applyWork(loaded: LoadedRecordKind, entries: RecordEntry[], options: ReadRecordsOptions): Promise<{ decisions: DecisionWork[] }> {
  const { kind } = loaded;
  const work = kind.work!;
  const decisionsKind = await loadRecordKind(work.decisions, dirname(loaded.file));
  const decisionRead = await readRecords(decisionsKind, { root: options.root, source: options.source });
  const decisionById = new Map<string, RecordEntry>();
  for (const d of decisionRead.records) if (d.id !== null && !decisionById.has(d.id)) decisionById.set(d.id, d);

  const byId = new Map<string, RecordEntry>();
  for (const e of entries) if (e.id !== null && !byId.has(e.id)) byId.set(e.id, e);
  const closed = new Set(kind.closedStates);

  // Records in a needs cycle: those that reach themselves.
  const inCycle = new Set<string>();
  for (const start of byId.keys()) {
    const seen = new Set<string>();
    const stack = [...idList(byId.get(start)!.data, work.needs)];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === start) {
        inCycle.add(start);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...idList(byId.get(id)?.data ?? null, work.needs));
    }
  }

  const implementedBy = new Map<string, WorkLink[]>();
  for (const e of entries) {
    if (e.data === null) continue;
    const needs = idList(e.data, work.needs);
    const implementsIds = idList(e.data, work.implements);
    e.blockedBy = needs.filter((n) => byId.get(n)?.state !== work.done).map((n) => ({ id: n, state: byId.get(n)?.state ?? null }));
    e.implements = implementsIds.map((d) => ({ id: d, state: decisionById.get(d)?.state ?? null }));
    e.ready = e.state === work.open && e.blockedBy.length === 0 && e.reasons.length === 0 && e.supersededBy === null && !(e.id !== null && inCycle.has(e.id));

    // An open item has no proof yet, so the kind's empty-evidence warning is
    // replaced by work-done-unpinned, which only a done item gets.
    e.warnings = e.warnings.filter((w) => w.code !== "record-no-evidence");
    const unknownNeeds = needs.filter((n) => !byId.has(n));
    if (unknownNeeds.length > 0) {
      e.warnings.push({ code: "work-needs-unknown", message: `needs ${unknownNeeds.join(", ")}, which no work record has, so the item stays blocked` });
    }
    const unknownDecisions = implementsIds.filter((d) => !decisionById.has(d));
    if (unknownDecisions.length > 0) {
      e.warnings.push({ code: "work-implements-unknown", message: `implements ${unknownDecisions.join(", ")}, which no decision in ${work.decisions} has` });
    }
    if (e.id !== null && inCycle.has(e.id)) {
      e.warnings.push({ code: "work-needs-cycle", message: `${e.id} needs itself through its needs links, so it can never be ready` });
    }
    const undecided = e.implements.filter((d) => d.state !== null && !isDecided(decisionsKind.kind, d.state));
    if (undecided.length > 0) {
      e.warnings.push({
        code: "work-implements-undecided",
        message: `implements ${undecided.map((d) => `${d.id}, which is ${d.state}`).join("; ")}: the work may carry out a choice nobody has made`,
      });
    }
    const evidence = kind.pins ? e.data[kind.pins.field] : undefined;
    if (e.state === work.done && kind.pins && !(Array.isArray(evidence) && evidence.length > 0)) {
      e.warnings.push({ code: "work-done-unpinned", message: `${e.id ?? e.path} is ${work.done} and ${kind.pins.field} is empty or missing: nothing shows the work was done` });
    }
    if (e.state !== null && closed.has(e.state) && typeof e.data[work.closedOn] !== "string") {
      e.warnings.push({ code: "work-closed-without-date", message: `${e.id ?? e.path} is ${e.state} and has no ${work.closedOn}` });
    }
    if (e.id !== null && byId.get(e.id) === e) {
      for (const d of implementsIds) {
        const list = implementedBy.get(d) ?? [];
        if (!list.some((x) => x.id === e.id)) list.push({ id: e.id, state: e.state });
        implementedBy.set(d, list);
      }
    }
  }

  return {
    decisions: decisionRead.records
      .filter((d): d is RecordEntry & { id: string } => d.id !== null && decisionById.get(d.id) === d)
      .map((d) => ({ id: d.id, path: d.path, state: d.state, supersededBy: d.supersededBy, implementedBy: implementedBy.get(d.id) ?? [] })),
  };
}
