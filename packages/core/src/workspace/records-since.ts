/**
 * `chant workspace records --kind <kind file> --since <rev> [--at <rev>]
 * [--json]` (#2673, #2650 C11): what changed in a kind's records between two
 * revisions. It reads the records at `<rev>` and at `--at` (the working tree
 * without it), through the same reader as `records`, and lists new and
 * removed records, state transitions, new verdicts, new supersessions and
 * changed pins. Between a review session's open and close commits, that is
 * what the session did.
 *
 * Records are matched by id. A record whose id could not be read is left
 * out of the comparison, since nothing says which record it was before.
 */

import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { pinEntries } from "./record-assets";
import { gitRoot, resolveRevision } from "./record-source";
import { READ_ERROR_CODES, RecordReadError, type LoadedRecordKind, type ReadErrorCode, type RecordEntry, type RecordKind } from "./records";
import { readRecordsFor, RECORDS_CONTRACT_VERSION } from "./records-cli";
import type { ReasonCode } from "./reason-codes";

/** `$id` of the JSON Schema for `records --since --json`, shipped beside this file. */
export const RECORDS_SINCE_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records-since/v1/records-since.schema.json";

/** Why a `--since` read failed: any records read error, or a `--since` that names no commit. Closed. */
export const RECORDS_SINCE_ERROR_CODES = [
  ...READ_ERROR_CODES,
  /** `--since` names no commit. */
  "since-rev-unknown",
] as const satisfies readonly ReasonCode[];
export type RecordsSinceErrorCode = (typeof RECORDS_SINCE_ERROR_CODES)[number];

/** The kinds of change, in the order the output lists them. */
export const SINCE_CHANGE_KINDS = ["new", "removed", "state", "verdict", "supersession", "pin"] as const;
export type SinceChangeKind = (typeof SINCE_CHANGE_KINDS)[number];

/** The review list on a record that is not a session, when its kind declares none (#2670, #2671). */
const REVIEWS_FIELD = "reviews";

export type SinceChange =
  | { change: "new"; id: string; path: string; state: string | null }
  | { change: "removed"; id: string; path: string; state: string | null }
  | { change: "state"; id: string; from: string | null; to: string | null }
  | { change: "verdict"; id: string; principal: string | null; verdict: string | null; index: number; record?: string; session?: string }
  | { change: "supersession"; id: string; supersedes: string }
  | { change: "pin"; id: string; path: string; from: string | null; to: string | null };

export type RecordsSinceDocument =
  | {
      $schema: string;
      contract: number;
      kind: { name: string; schema: string; file: string };
      since: string;
      at: string | null;
      changes: SinceChange[];
      summary: Record<SinceChangeKind, number>;
    }
  | { $schema: string; contract: number; error: { code: RecordsSinceErrorCode; message: string } };

export interface RecordsSinceQuery {
  kind: string;
  since: string;
  at?: string;
  cwd: string;
}

class SinceError extends Error {
  constructor(
    readonly code: RecordsSinceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Run the comparison and build the document `--json` prints. Never throws a read error. */
export async function queryRecordsSince(query: RecordsSinceQuery): Promise<RecordsSinceDocument> {
  const failure = (code: RecordsSinceErrorCode, message: string): RecordsSinceDocument => ({
    $schema: RECORDS_SINCE_OUTPUT_SCHEMA_ID,
    contract: RECORDS_CONTRACT_VERSION,
    error: { code, message },
  });
  try {
    const since = resolveSince(query.cwd, query.since);
    const after = await readRecordsFor({ kind: query.kind, at: query.at, cwd: query.cwd });
    let before: RecordEntry[];
    try {
      before = (await readRecordsFor({ kind: query.kind, at: since, cwd: query.cwd })).result.records;
    } catch (err) {
      // A directory that did not exist yet held no records.
      if (!(err instanceof RecordReadError) || err.code !== "location-missing") throw err;
      before = [];
    }
    const changes = compareRecords(after.loaded.kind, before, after.result.records);
    const summary = Object.fromEntries(SINCE_CHANGE_KINDS.map((k) => [k, changes.filter((c) => c.change === k).length])) as Record<SinceChangeKind, number>;
    return {
      $schema: RECORDS_SINCE_OUTPUT_SCHEMA_ID,
      contract: RECORDS_CONTRACT_VERSION,
      kind: kindView(after.loaded, after.root),
      since,
      at: after.at,
      changes,
      summary,
    };
  } catch (err) {
    if (err instanceof SinceError) return failure(err.code, err.message);
    if (err instanceof RecordReadError) return failure(err.code satisfies ReadErrorCode, err.message);
    throw err;
  }
}

function kindView(loaded: LoadedRecordKind, root: string): { name: string; schema: string; file: string } {
  return { name: loaded.kind.name, schema: loaded.kind.schema.id, file: relative(root, loaded.file).split("\\").join("/") };
}

/** The full commit id `rev` names, from the repository holding `cwd`. */
function resolveSince(cwd: string, rev: string): string {
  let dir = cwd;
  try {
    dir = realpathSync(cwd);
  } catch {
    // Reported by the read that follows, if at all.
  }
  const top = gitRoot(dir);
  if (!top) throw new RecordReadError("not-a-git-repository", "--since reads git objects, and this directory is not in a git repository");
  try {
    return resolveRevision(top, rev);
  } catch (err) {
    if (err instanceof RecordReadError && err.code === "revision-unknown") {
      throw new SinceError("since-rev-unknown", `--since ${rev} names no commit in this repository`);
    }
    throw err;
  }
}

/** The first record with each id, in path order; records with no id are left out. */
function byId(records: RecordEntry[]): Map<string, RecordEntry> {
  const out = new Map<string, RecordEntry>();
  for (const r of records) if (r.id !== null && !out.has(r.id)) out.set(r.id, r);
  return out;
}

interface Verdict {
  key: string;
  index: number;
  principal: string | null;
  verdict: string | null;
  record?: string;
  session?: string;
}

/**
 * A record's verdicts: a session's own verdict list, or the review list on
 * any other record. Two entries are the same verdict when they name the same
 * principal, verdict, date, session and record, so a dissent that later gains
 * `addressed_by` is not a new verdict.
 */
function verdicts(kind: RecordKind, r: RecordEntry): Verdict[] {
  const field = kind.session ? kind.session.verdicts : (kind.reviews?.field ?? REVIEWS_FIELD);
  const list = r.data?.[field];
  if (!Array.isArray(list)) return [];
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const out: Verdict[] = [];
  list.forEach((e, index) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return;
    const o = e as Record<string, unknown>;
    const principal = str(kind.session ? o.principal : o.reviewer) ?? null;
    const verdict = str(o.verdict) ?? null;
    const record = str(o.record);
    const session = str(o.session);
    out.push({
      key: JSON.stringify([principal, verdict, str(o.on) ?? null, session ?? null, record ?? null]),
      index,
      principal,
      verdict,
      ...(record !== undefined ? { record } : {}),
      ...(session !== undefined ? { session } : {}),
    });
  });
  return out;
}

/** What changed from `before` to `after`, in the order of {@link SINCE_CHANGE_KINDS} and then by id. */
export function compareRecords(kind: RecordKind, before: RecordEntry[], after: RecordEntry[]): SinceChange[] {
  const old = byId(before);
  const now = byId(after);
  const ids = [...new Set([...old.keys(), ...now.keys()])].sort();
  const out: Record<SinceChangeKind, SinceChange[]> = { new: [], removed: [], state: [], verdict: [], supersession: [], pin: [] };
  for (const id of ids) {
    const a = old.get(id);
    const b = now.get(id);
    if (!a && b) out.new.push({ change: "new", id, path: b.path, state: b.state });
    if (a && !b) out.removed.push({ change: "removed", id, path: a.path, state: a.state });
    if (!b) continue;
    if (a && a.state !== b.state) out.state.push({ change: "state", id, from: a.state, to: b.state });

    // Verdicts in b beyond the ones a already had, compared as multisets.
    const seen = new Map<string, number>();
    for (const v of a ? verdicts(kind, a) : []) seen.set(v.key, (seen.get(v.key) ?? 0) + 1);
    for (const v of verdicts(kind, b)) {
      const left = seen.get(v.key) ?? 0;
      if (left > 0) {
        seen.set(v.key, left - 1);
        continue;
      }
      out.verdict.push({
        change: "verdict",
        id,
        principal: v.principal,
        verdict: v.verdict,
        index: v.index,
        ...(v.record !== undefined ? { record: v.record } : {}),
        ...(v.session !== undefined ? { session: v.session } : {}),
      });
    }

    // Supersession as derived, so a link that only now takes effect counts.
    if (b.supersededBy !== null && (!a || a.supersededBy !== b.supersededBy)) {
      out.supersession.push({ change: "supersession", id: b.supersededBy, supersedes: id });
    }

    if (a && kind.pins) {
      const from = new Map(pinEntries(a.data, kind.pins.field).map((p) => [p.path, p.sha256]));
      const to = new Map(pinEntries(b.data, kind.pins.field).map((p) => [p.path, p.sha256]));
      for (const path of [...new Set([...from.keys(), ...to.keys()])].sort()) {
        const x = from.get(path) ?? null;
        const y = to.get(path) ?? null;
        if (x !== y) out.pin.push({ change: "pin", id, path, from: x, to: y });
      }
    }
  }
  out.supersession.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return SINCE_CHANGE_KINDS.flatMap((k) => out[k]);
}

/** The text form: one line per change and a summary. */
export function formatSince(doc: Extract<RecordsSinceDocument, { changes: SinceChange[] }>): string {
  const lines = doc.changes.map((c) => {
    switch (c.change) {
      case "new":
        return `${c.id}  new, ${c.state ?? "no state"}  (${c.path})`;
      case "removed":
        return `${c.id}  removed, was ${c.state ?? "no state"}  (${c.path})`;
      case "state":
        return `${c.id}  state ${c.from ?? "none"} to ${c.to ?? "none"}`;
      case "verdict":
        return `${c.id}  verdict ${c.verdict ?? "-"} by ${c.principal ?? "-"}${c.record ? ` on ${c.record}` : ""}${c.session ? ` in ${c.session}` : ""}`;
      case "supersession":
        return `${c.id}  supersedes ${c.supersedes}`;
      case "pin":
        return `${c.id}  pin ${c.path} ${c.from ? c.from.slice(0, 12) : "none"} to ${c.to ? c.to.slice(0, 12) : "none"}`;
    }
  });
  const s = doc.summary;
  lines.push(
    `${doc.changes.length} changes since ${doc.since.slice(0, 8)}${doc.at ? ` to ${doc.at.slice(0, 8)}` : " to the working tree"}: ${s.new} new, ${s.removed} removed, ${s.state} state, ${s.verdict} verdicts, ${s.supersession} supersessions, ${s.pin} pins`,
  );
  return lines.join("\n");
}
