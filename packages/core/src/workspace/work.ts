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
 * - `acceptance`, for a kind with acceptance criteria (#2772): how many of the
 *   record's criteria passing evidence of the expected verification meets;
 * - `contract`, for a kind with a contract link (#3147): the contract record
 *   the item builds, with its state, read from the contract kind at the same
 *   revision;
 *
 * and each decision `implementedBy`, the work records naming it. The
 * warnings are closed codes. `work-done-gap-open` is not raised here: it
 * takes a walk of the item's region, which `graph --intent` makes and
 * `records` asks it for (#2686). It never writes a record.
 */

import { dirname } from "node:path";
import type { ReasonCode } from "./reason-codes";
import { loadRecordKind, normalisePrincipal, readRecords, type LoadedRecordKind, type ReadRecordsOptions, type RecordEntry } from "./records";

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
  /** The record is done, and the finding it came from (`source.finding`) still fires on its region. Raised by `graph --intent`, and by `records` through a walk of that region (#2686). */
  "work-done-gap-open",
  /** The record is done, and an acceptance criterion has no passing evidence of the verification it expects (#2772). `check` fails on it (WSP117). */
  "work-acceptance-unmet",
  /** A passing `manual` verdict on a criterion names the record's implementer, so it does not count: a manual verdict comes from someone else (#2772). */
  "work-acceptance-self-verified",
  /** The record names a contract no record of the kind's contract kind has (#3147). */
  "work-contract-unknown",
  /** The record names a contract whose state is not approved, such as a draft (#3147). */
  "work-contract-undecided",
  /** The record names a builder tier its kind's `work.tier.tiers` does not list (#3147). */
  "work-tier-unknown",
] as const satisfies readonly ReasonCode[];
export type WorkWarningCode = (typeof WORK_WARNING_CODES)[number];

/** A link from a work record to another record, with that record's state now. */
export interface WorkLink {
  id: string;
  /** The linked record's state, or null when no record has the id. */
  state: string | null;
}

/**
 * One decision-point answer about a work item (#3147), as `records --json`
 * joins it from the answer kind the work kind names: the answer records whose
 * `constrains` names the item's id. The item never copies them.
 */
export interface WorkAnswer {
  /** The answer record's id, such as understand-0123456789ab. */
  id: string;
  /** The decision point it answers. */
  point: string | null;
  /** escalated, proposed or answered. */
  state: string | null;
  /** The answer, or null while there is none. */
  answer: string | boolean | null;
  /** The people who answered or confirmed it, empty when a table or model did. */
  answeredBy: string[];
}

/**
 * The answers about each work item: every answer record whose `constrains`
 * names the item's id, in path order, by item id.
 */
export function workAnswers(answerRecords: readonly RecordEntry[], ids: Iterable<string>): Map<string, WorkAnswer[]> {
  const out = new Map<string, WorkAnswer[]>();
  for (const id of ids) out.set(id, []);
  for (const a of answerRecords) {
    if (a.id === null || a.data === null) continue;
    for (const target of idList(a.data, "constrains")) {
      const list = out.get(target);
      if (!list || list.some((x) => x.id === a.id)) continue;
      const answer = a.data.answer;
      list.push({
        id: a.id,
        point: typeof a.data.point === "string" ? a.data.point : null,
        state: a.state,
        answer: typeof answer === "string" || typeof answer === "boolean" ? answer : null,
        answeredBy: idList(a.data, "answered_by"),
      });
    }
  }
  return out;
}

/** A decision as a work read lists it: its state and the work records implementing it. */
export interface DecisionWork {
  id: string;
  path: string;
  state: string | null;
  supersededBy: string | null;
  implementedBy: WorkLink[];
}

/** How a criterion is to be verified (#2772): by a unit, integration or end-to-end test, by the running system, or by a person. */
export const VERIFICATION_TYPES = ["unit", "integration", "e2e", "runtime", "manual"] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** The results a piece of evidence for a criterion can carry. */
export const EVIDENCE_RESULTS = ["pass", "fail"] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

/** One acceptance criterion as a work record states it. */
export interface Criterion {
  id: string;
  text: string;
  verification: VerificationType;
}

/** One criterion on read: whether passing evidence of its verification meets it. */
export interface CriterionState {
  id: string;
  verification: VerificationType;
  met: boolean;
}

/** A work record's acceptance criteria on read (#2772): how many are met, of how many. */
export interface WorkAcceptance {
  met: number;
  total: number;
  criteria: CriterionState[];
}

/** The acceptance criteria a record lists in `field`, leaving out entries without a string id and a known verification (the schema reports those). */
export function acceptanceCriteria(data: Record<string, unknown> | null, field: string): Criterion[] {
  const v = data?.[field];
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is Criterion =>
      c !== null && typeof c === "object" && typeof c.id === "string" && typeof c.text === "string" && (VERIFICATION_TYPES as readonly string[]).includes(c.verification),
  );
}

/**
 * Which of a record's criteria its evidence meets. Evidence meets a criterion
 * when it names the criterion, its result is `pass` and its verification is
 * the criterion's. A `manual` verdict also names who gave it in `by`, and
 * counts only when that is not the record's implementer; one that is lands in
 * `selfVerified`. `acceptance` is null when the record lists no criteria.
 */
export function workAcceptance(
  data: Record<string, unknown> | null,
  spec: { field: string; implementer: string },
  pinsField: string,
): { acceptance: WorkAcceptance | null; selfVerified: string[] } {
  if (!Array.isArray(data?.[spec.field])) return { acceptance: null, selfVerified: [] };
  const criteria = acceptanceCriteria(data, spec.field);
  const implementer = typeof data?.[spec.implementer] === "string" ? normalisePrincipal(data[spec.implementer] as string) : null;
  const evidence = Array.isArray(data?.[pinsField]) ? (data![pinsField] as unknown[]) : [];
  const selfVerified: string[] = [];
  const states = criteria.map((c): CriterionState => {
    let met = false;
    for (const e of evidence) {
      if (e === null || typeof e !== "object") continue;
      const ev = e as Record<string, unknown>;
      if (ev.criterion !== c.id || ev.result !== "pass" || ev.verification !== c.verification) continue;
      if (c.verification === "manual") {
        if (typeof ev.by !== "string") continue;
        if (implementer !== null && normalisePrincipal(ev.by) === implementer) {
          if (!selfVerified.includes(c.id)) selfVerified.push(c.id);
          continue;
        }
      }
      met = true;
    }
    return { id: c.id, verification: c.verification, met };
  });
  return { acceptance: { met: states.filter((c) => c.met).length, total: states.length, criteria: states }, selfVerified };
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

  // The contract kind a work item names its contract in (#3147), read at the same revision.
  let contracts: { kind: LoadedRecordKind; byId: Map<string, RecordEntry> } | undefined;
  if (work.contract) {
    const contractKind = await loadRecordKind(work.contract.kind, dirname(loaded.file));
    const contractRead = await readRecords(contractKind, { root: options.root, source: options.source });
    const contractById = new Map<string, RecordEntry>();
    for (const c of contractRead.records) if (c.id !== null && !contractById.has(c.id)) contractById.set(c.id, c);
    contracts = { kind: contractKind, byId: contractById };
  }

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
    if (work.acceptance && kind.pins) {
      const { acceptance, selfVerified } = workAcceptance(e.data, work.acceptance, kind.pins.field);
      e.acceptance = acceptance;
      if (selfVerified.length > 0) {
        e.warnings.push({
          code: "work-acceptance-self-verified",
          message: `the manual verdict on ${selfVerified.join(", ")} is by ${String(e.data[work.acceptance.implementer])}, the implementer, so it does not count: a manual verdict comes from someone else`,
        });
      }
      const unmet = acceptance?.criteria.filter((c) => !c.met) ?? [];
      if (e.state === work.done && unmet.length > 0) {
        e.warnings.push({
          code: "work-acceptance-unmet",
          message: `${e.id ?? e.path} is ${work.done}, and no passing evidence meets ${unmet.map((c) => `${c.id} (${c.verification})`).join(", ")}`,
        });
      }
    }
    if (contracts && work.contract) {
      const named = e.data[work.contract.field];
      if (typeof named === "string" && named !== "") {
        const c = contracts.byId.get(named);
        e.contract = { id: named, state: c?.state ?? null };
        if (!c) {
          e.warnings.push({ code: "work-contract-unknown", message: `names the contract ${named}, which no record in ${work.contract.kind} has` });
        } else if (!isDecided(contracts.kind.kind, c.state)) {
          e.warnings.push({ code: "work-contract-undecided", message: `names the contract ${named}, which is ${c.state ?? "in no state"}: the work may build a contract nobody approved` });
        }
      } else {
        e.contract = null;
      }
    }
    if (work.tier) {
      const tier = e.data[work.tier.field];
      if (typeof tier === "string" && !work.tier.tiers.includes(tier)) {
        e.warnings.push({ code: "work-tier-unknown", message: `names the builder tier ${tier}, which the kind's tiers (${work.tier.tiers.join(", ")}) do not list` });
      }
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
