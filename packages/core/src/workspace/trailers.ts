/**
 * chant's commit trailers (#3149, ws-075): the vocabulary a commit uses to
 * name the lease, the agent run, the records and the apply behind it.
 *
 * A trailer is how a commit points at a fact kept elsewhere: a work lease on
 * `chant/lifecycle`, an agent run in the run ledger (#3033), a record in the
 * working tree. Provenance is keyed to those ids, never to commit SHAs, so a
 * commit that keeps its message through a rebase or a cherry-pick keeps its
 * joins (#3037). chant never writes a commit itself (ws-074): whoever makes
 * the commit adds the trailers, and chant reads them back in `graph
 * --intent`, `graph --intent --record` and `workspace runs`.
 *
 * | Trailer | Value | Names |
 * |---|---|---|
 * | `Chant-Agent` | an agent session | the session that wrote the commit (ws-067) |
 * | `Chant-Lease` | a fencing token | the work lease the commit was made under |
 * | `Chant-Run` | a run id | the agent run that made the commit (#3033) |
 * | `Chant-Record` | `<kind>:<id>` | a record the commit carries out or changes; repeatable |
 * | `Chant-Applied-By` | a principal | who applied a leased branch, on the apply commit |
 * | `Chant-Applied-At` | ISO 8601 | when it was applied |
 * | `Chant-Applied-Commit` | a commit id | the tip of the branch that was applied |
 *
 * Every other trailer is a plugin's, and core gives it no meaning; a kind's
 * `commitJoins` may (`intent-joins.ts`).
 */

import { trailerValue, trailerValues } from "./intent-joins";

/** The agent session that wrote a commit (ws-067). */
export const AGENT_TRAILER = "Chant-Agent";
/** The fencing token of the work lease a commit was made under. */
export const LEASE_TRAILER = "Chant-Lease";
/** The agent run that made a commit (#3033). */
export const RUN_TRAILER = "Chant-Run";
/** A record a commit carries out or changes, as `<kind>:<id>`. Repeatable. */
export const RECORD_TRAILER = "Chant-Record";
/** Who applied a leased branch, on the commit that applied it. */
export const APPLIED_BY_TRAILER = "Chant-Applied-By";
/** When the branch was applied, ISO 8601. */
export const APPLIED_AT_TRAILER = "Chant-Applied-At";
/** The tip of the branch that was applied. */
export const APPLIED_COMMIT_TRAILER = "Chant-Applied-Commit";

/** Every trailer key core reads, in the order a writer should add them. */
export const CHANT_TRAILERS = [AGENT_TRAILER, LEASE_TRAILER, RUN_TRAILER, RECORD_TRAILER, APPLIED_BY_TRAILER, APPLIED_AT_TRAILER, APPLIED_COMMIT_TRAILER] as const;

/** A record kind's name, as a kind file's `recordKind.name` gives it. */
const KIND_NAME = /^[a-z][a-z0-9-]*$/;
/** A record id, as the record kinds allocate them and as a work lease keys them. */
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/** One `Chant-Record` value. */
export interface RecordRef {
  /** The record kind's name, such as `decision` or `work`. */
  kind: string;
  id: string;
}

/** An apply, from the `Chant-Applied-*` trailers. */
export interface AppliedTrailers {
  by: string;
  /** ISO 8601, or null when the trailer is missing. */
  at: string | null;
  /** The applied branch's tip, or null when the trailer is missing or is not a commit id. */
  commit: string | null;
}

/** What chant's own trailers on one commit say. */
export interface ChantTrailers {
  agent: string | null;
  lease: string | null;
  run: string | null;
  /** Each well-formed `Chant-Record` value, in order, without repeats. */
  records: RecordRef[];
  applied: AppliedTrailers | null;
}

/** Parse one `Chant-Record` value, `<kind>:<id>`, or undefined when it is not one. */
export function parseRecordRef(value: string): RecordRef | undefined {
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const kind = value.slice(0, colon).trim();
  const id = value.slice(colon + 1).trim();
  return KIND_NAME.test(kind) && RECORD_ID.test(id) ? { kind, id } : undefined;
}

/** Read chant's own trailers from a commit's parsed trailers. Keys compare without case, as git's do. */
export function readChantTrailers(trailers: Record<string, string[]>): ChantTrailers {
  const records: RecordRef[] = [];
  for (const v of trailerValues(trailers, RECORD_TRAILER)) {
    const ref = parseRecordRef(v);
    if (ref && !records.some((r) => r.kind === ref.kind && r.id === ref.id)) records.push(ref);
  }
  const by = trailerValue(trailers, APPLIED_BY_TRAILER) ?? null;
  const commit = trailerValue(trailers, APPLIED_COMMIT_TRAILER) ?? null;
  return {
    agent: trailerValue(trailers, AGENT_TRAILER) ?? null,
    lease: trailerValue(trailers, LEASE_TRAILER) ?? null,
    run: trailerValue(trailers, RUN_TRAILER) ?? null,
    records,
    applied: by === null ? null : { by, at: trailerValue(trailers, APPLIED_AT_TRAILER) ?? null, commit: commit !== null && COMMIT_ID.test(commit) ? commit : null },
  };
}

/** Whether a commit carries any of chant's own trailers. */
export function hasChantTrailers(t: ChantTrailers): boolean {
  return t.agent !== null || t.lease !== null || t.run !== null || t.records.length > 0 || t.applied !== null;
}

/** What a writer passes to {@link formatChantTrailers}. */
export interface ChantTrailerInput {
  agent?: string;
  lease?: string;
  run?: string;
  records?: (RecordRef | string)[];
  applied?: { by: string; at?: string; commit?: string };
}

/**
 * The trailer lines for a commit message, in {@link CHANT_TRAILERS} order.
 * Throws when a value holds a line break or a record ref is malformed, since
 * either would write a trailer git parses differently.
 */
export function formatChantTrailers(input: ChantTrailerInput): string[] {
  const lines: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const v = value.trim();
    if (v === "" || /[\r\n]/.test(v)) throw new Error(`${key} takes one line of text, not ${JSON.stringify(value)}`);
    lines.push(`${key}: ${v}`);
  };
  add(AGENT_TRAILER, input.agent);
  add(LEASE_TRAILER, input.lease);
  add(RUN_TRAILER, input.run);
  for (const r of input.records ?? []) {
    const ref = typeof r === "string" ? parseRecordRef(r) : r;
    if (!ref || !KIND_NAME.test(ref.kind) || !RECORD_ID.test(ref.id)) throw new Error(`${RECORD_TRAILER} takes <kind>:<id>, not ${JSON.stringify(r)}`);
    add(RECORD_TRAILER, `${ref.kind}:${ref.id}`);
  }
  if (input.applied) {
    add(APPLIED_BY_TRAILER, input.applied.by);
    add(APPLIED_AT_TRAILER, input.applied.at);
    if (input.applied.commit !== undefined && !COMMIT_ID.test(input.applied.commit)) throw new Error(`${APPLIED_COMMIT_TRAILER} takes a full commit id, not ${JSON.stringify(input.applied.commit)}`);
    add(APPLIED_COMMIT_TRAILER, input.applied.commit);
  }
  return lines;
}
