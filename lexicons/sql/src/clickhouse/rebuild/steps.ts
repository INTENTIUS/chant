/**
 * The rebuild migration's steps (#3198), each one convergent: it observes
 * the server (`./observe.ts`), does what is left of its own part, and
 * reports. Running a step twice does what running it once did.
 *
 * The backfill and the verification are in `./backfill.ts` and
 * `./verify.ts`; the Op that orders them is `./op.ts`.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { computePlanDigest, parseDuration } from "@intentius/chant/op";
import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "../live/bind";
import { carriesMarker, readTrailerPairs, REBUILD_TRAILER_KEY, stampedComment } from "../ownership";
import { createStatement, ident, qualifiedIdent, renamedDeclaration, sqlString, type DeclaredObject } from "../apply/statements";
import { waitForMutations } from "../apply/mutations";
import {
  changesBetween,
  observeRebuild,
  rebuildNames,
  RebuildRefusal,
  showCreate,
  type DualWrite,
  type RebuildObservation,
} from "./observe";

/** What every step is given. */
export interface RebuildRun {
  target: ClickHouseTarget;
  /** The declared table being rebuilt. */
  declared: DeclaredObject;
  /** This project's ownership marker, stamped on every working object. */
  marker?: OwnershipMarker;
  dualWrite: DualWrite;
  /** How long the old table is kept after the swap, in milliseconds. */
  retainMs: number;
  /** How long to wait for one table's mutations. Default: ten minutes. */
  mutationTimeoutMs?: number;
  log: (line: string) => void;
  signal?: AbortSignal;
  /** The run's id, recorded on the receipts it writes. */
  runId?: string;
}

/** The server's clock, in milliseconds: the cut-over and the retention are the server's times, not this machine's. */
export async function serverNow(target: ClickHouseTarget): Promise<number> {
  const [row] = await clickhouseQuery<{ t: string | number }>(target.endpoint, "SELECT toUnixTimestamp64Milli(now64(3)) AS t");
  return Number(row?.t ?? Date.now());
}

/** `2026-10-02 12:00:00.000`, UTC: how a cut-over is written into SQL. */
export const sqlUtc = (ms: number): string => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

/** A `DateTime64` literal in UTC. */
export const utcLiteral = (ms: number): string => `toDateTime64(${sqlString(sqlUtc(ms))}, 3, 'UTC')`;

export const observe = (run: RebuildRun): Promise<RebuildObservation> => observeRebuild(run.target, run.declared, run.marker);

const q = (run: RebuildRun, sql: string) => {
  run.signal?.throwIfAborted();
  run.log(sql);
  return clickhouseQuery(run.target.endpoint, sql, run.signal ? { signal: run.signal } : {});
};

export async function waitOn(run: RebuildRun, database: string, table: string): Promise<void> {
  const ids = await waitForMutations(run.target.endpoint, database, table, {
    ...(run.mutationTimeoutMs !== undefined ? { timeoutMs: run.mutationTimeoutMs } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
  });
  if (ids.length > 0) run.log(`-- waited for ${database}.${table} mutation(s) ${ids.join(", ")}`);
}

/**
 * In a Replicated database, wait until this replica has every part the
 * others have written to `database.table` (`SYSTEM SYNC REPLICA ...
 * LIGHTWEIGHT`, which waits for fetches and not for merges). A step that
 * reads rows on one replica after a copy ran on another reads them all.
 * Nothing to wait for in an Atomic database.
 */
export async function syncReplica(run: RebuildRun, o: Pick<RebuildObservation, "replicated">, database: string, table: string): Promise<void> {
  if (!o.replicated) return;
  await q(run, `SYSTEM SYNC REPLICA ${qualifiedIdent(database, table)} LIGHTWEIGHT`);
}

/** The trailer pairs a working object carries besides the marker. */
const working = (key: string, role: "new" | "dual" | "old", extra: Record<string, string> = {}) => ({ [REBUILD_TRAILER_KEY]: key, role, ...extra });

// ── create ─────────────────────────────────────────────────────────────

export interface CreateResult {
  state: RebuildObservation["state"];
  /** `db.t__chant_new`. */
  table: string;
  created: boolean;
}

/**
 * Create the new table from the declaration, under `t__chant_new`, marked as
 * this project's and this rebuild's. The old table's unfinished mutations are
 * waited on first, so what is copied is what they produce. A new table that
 * is already there is kept when it matches the declaration; one made from an
 * earlier declaration is refused, and the run's onFailure drops it.
 */
export async function createNewTable(run: RebuildRun): Promise<CreateResult> {
  const o = await observe(run);
  const table = `${o.names.database}.${o.names.newName}`;
  if (o.state !== "rebuild") return { state: o.state, table, created: false };
  await waitOn(run, o.names.database, o.names.name);
  if (o.newTable) {
    const live = await showCreate(run.target, o.names.newTable);
    const stale = (await changesBetween(run.target, o.names.key, { ...live, name: run.declared.canonical.name }, run.declared.canonical)).filter((c) => c.field !== "comment");
    if (stale.length > 0) {
      throw new RebuildRefusal(
        `${table} was made from another declaration of ${o.names.key} (${stale.map((c) => `${c.rule} on ${c.field}`).join(", ")}). ` +
          `The run fails so onFailure drops it, and the next run starts again from the current declaration.`,
      );
    }
    run.log(`-- ${table} is there and matches the declaration`);
    return { state: o.state, table, created: false };
  }
  const renamed = renamedDeclaration(run.declared, o.names.newName, run.target.defaultDatabase);
  await q(run, createStatement(renamed, run.marker, { trailer: working(o.names.key, "new") }));
  return { state: o.state, table, created: true };
}

// ── dual write ─────────────────────────────────────────────────────────

export interface DualWriteResult {
  state: RebuildObservation["state"];
  mode: DualWrite["mode"];
  /** The cut-over (materialized-view mode), ISO-8601 UTC. */
  cutover?: string;
  created: boolean;
}

/**
 * Materialized-view mode: create `t__chant_dual`, a materialized view on the
 * old table that writes every row at or after the cut-over into the new
 * table. The cut-over is the server's time now plus the delay, kept in the
 * view's own comment (`cutover=`), so a later run and the backfill read it
 * back from the server. App mode creates nothing; its gate is the Op's.
 */
export async function startDualWrite(run: RebuildRun): Promise<DualWriteResult> {
  const o = await observe(run);
  const mode = run.dualWrite.mode;
  if (o.state !== "rebuild" || run.dualWrite.mode === "app") return { state: o.state, mode, created: false };
  if (o.dual) return { state: o.state, mode, cutover: o.dual.pairs!.get("cutover")!, created: false };
  if (!o.newTable) throw new RebuildRefusal(`${o.names.key}: the new table is not there yet; the Create phase makes it`);

  const column = run.dualWrite.cutoverColumn;
  const cut = o.copied.find((c) => c.name === column);
  if (!cut) {
    throw new RebuildRefusal(
      `${o.names.key}: the cut-over column ${column} is not a column the new table copies from the old one ` +
        `(copied: ${o.copied.map((c) => c.name).join(", ")})`,
    );
  }
  const cutover = (await serverNow(run.target)) + parseDuration(run.dualWrite.cutoverDelay ?? "1m");
  const iso = new Date(cutover).toISOString();
  const select = o.copied.map((c) => (c.source === c.name ? ident(c.name) : `${ident(c.source)} AS ${ident(c.name)}`)).join(", ");
  const comment = stampedComment(`chant rebuild of ${o.names.key}: rows at or after the cut-over`, run.marker, working(o.names.key, "dual", { cutover: iso }));
  await q(
    run,
    `CREATE MATERIALIZED VIEW ${o.names.dualView} TO ${o.names.newTable} AS SELECT ${select} FROM ${o.names.table} ` +
      `WHERE ${ident(cut.source)} >= ${utcLiteral(cutover)} COMMENT ${sqlString(comment)}`,
  );
  return { state: o.state, mode, cutover: iso, created: true };
}

/** The cut-over in milliseconds, from the dual-write view; undefined in app mode. */
export function cutoverOf(run: RebuildRun, o: RebuildObservation): number | undefined {
  if (run.dualWrite.mode === "app") return undefined;
  const iso = o.dual?.pairs?.get("cutover");
  if (!iso) throw new RebuildRefusal(`${o.names.key}: the dual-write view ${o.names.database}.${o.names.dualName} is not there; the Dual write phase makes it`);
  return Date.parse(iso);
}

// ── swap ───────────────────────────────────────────────────────────────

export interface SwapResult {
  state: RebuildObservation["state"];
  swapped: boolean;
  /** The materialized views that read the table, recreated against the new one. */
  dependents: string[];
  /** Where the old table is kept, and until when. */
  oldTable?: string;
  retainUntil?: string;
}

/**
 * Swap the new table in: `EXCHANGE TABLES`, then drop the dual-write view,
 * rename the old table (now under the new table's name) to `t__chant_old`
 * with its retention date, recreate the materialized views that read the
 * table, and stamp the table's own comment as declared.
 *
 * Each part checks for itself whether it is done, so a swap interrupted
 * anywhere finishes on the next run. The table's comment is stamped last:
 * until it is, the table still carries `role=new` and the next run knows the
 * swap has not finished.
 *
 * Recreating a dependent view: in this server line a materialized view
 * follows its source by name, so after the EXCHANGE it already reads the new
 * table. It is detached and attached again so the server analyzes its query
 * against the new table's columns and types, and a view the new definition
 * breaks fails here, with the old table still kept, rather than on the next
 * insert. A view with an inner table keeps its data, which dropping and
 * creating it would not. Inserts that land while a view is detached are not
 * passed to it; in materialized-view mode writes go on through the swap, so
 * that window is the length of one DETACH and one ATTACH. In a Replicated
 * database the DETACH is `PERMANENTLY`, the form that database takes, and
 * the EXCHANGE, the DETACH and the ATTACH each run on every replica.
 */
export async function swapTables(run: RebuildRun): Promise<SwapResult> {
  const o = await observe(run);
  const n = o.names;
  if (o.state === "done") return { state: o.state, swapped: false, dependents: [] };
  if (o.state === "swapped" && !o.exchanged) {
    return { state: o.state, swapped: false, dependents: [], oldTable: `${n.database}.${n.oldName}`, ...retention(o) };
  }
  if (!o.exchanged) {
    if (!o.newTable) throw new RebuildRefusal(`${n.key}: there is no new table to swap in`);
    await q(run, `EXCHANGE TABLES ${n.table} AND ${n.newTable}`);
  }
  // The dual-write view now reads the new table by name; drop it before
  // anything else so it writes nothing more into the old one.
  const dual = await objectComment(run, n.database, n.dualName);
  if (dual !== undefined && readTrailerPairs(dual)?.get(REBUILD_TRAILER_KEY) === n.key && carriesMarker(dual, run.marker)) {
    await q(run, `DROP VIEW ${n.dualView} SYNC`);
  }

  if ((await objectComment(run, n.database, n.oldName)) === undefined) {
    await q(run, `RENAME TABLE ${n.newTable} TO ${n.oldTable}`);
  }
  const oldComment = await objectComment(run, n.database, n.oldName);
  let retainUntil = readTrailerPairs(oldComment)?.get("retain-until");
  if (readTrailerPairs(oldComment)?.get("role") !== "old") {
    retainUntil = new Date((await serverNow(run.target)) + run.retainMs).toISOString();
    const comment = stampedComment(`chant rebuild of ${n.key}: the old table, kept until ${retainUntil}`, run.marker, working(n.key, "old", { "retain-until": retainUntil }));
    await q(run, `ALTER TABLE ${n.oldTable} MODIFY COMMENT ${sqlString(comment)}`);
  }

  const dependents = await dependentViews(run, n.database, n.name);
  for (const d of dependents) {
    const [database, name] = d;
    // A Replicated database takes DETACH only as PERMANENTLY, run on every replica.
    const permanently = database === n.database ? o.replicated : await isReplicatedDatabase(run, database);
    await q(run, `DETACH TABLE ${qualifiedIdent(database, name)}${permanently ? " PERMANENTLY" : ""}`);
    await q(run, `ATTACH TABLE ${qualifiedIdent(database, name)}`);
  }
  await q(run, `ALTER TABLE ${n.table} MODIFY COMMENT ${sqlString(stampedComment(run.declared.canonical.comment, run.marker))}`);
  return { state: "swapped", swapped: true, dependents: dependents.map(([d, v]) => `${d}.${v}`), oldTable: `${n.database}.${n.oldName}`, ...(retainUntil ? { retainUntil } : {}) };
}

async function isReplicatedDatabase(run: RebuildRun, database: string): Promise<boolean> {
  const [row] = await clickhouseQuery<{ engine: string }>(run.target.endpoint, `SELECT engine FROM system.databases WHERE name = ${sqlString(database)}`);
  return row?.engine === "Replicated";
}

async function objectComment(run: RebuildRun, database: string, name: string): Promise<string | undefined> {
  const [row] = await clickhouseQuery<{ comment: string }>(
    run.target.endpoint,
    `SELECT comment FROM system.tables WHERE database = ${sqlString(database)} AND name = ${sqlString(name)}`,
  );
  return row?.comment;
}

/** The materialized views that read `database.name`, as `system.tables` lists them. */
export async function dependentViews(run: Pick<RebuildRun, "target">, database: string, name: string): Promise<Array<[string, string]>> {
  const [row] = await clickhouseQuery<{ dependencies_database: string[]; dependencies_table: string[] }>(
    run.target.endpoint,
    `SELECT dependencies_database, dependencies_table FROM system.tables WHERE database = ${sqlString(database)} AND name = ${sqlString(name)}`,
  );
  if (!row) return [];
  return row.dependencies_table.map((t, i) => [row.dependencies_database[i]!, t] as [string, string]);
}

// ── retain and drop ────────────────────────────────────────────────────

function retention(o: RebuildObservation): { retainUntil?: string } {
  const until = o.old?.pairs?.get("retain-until");
  return until ? { retainUntil: until } : {};
}

export interface RetainResult {
  state: RebuildObservation["state"];
  /** `db.t__chant_old`, while it is kept. */
  oldTable?: string;
  retainUntil?: string;
  /** The retention date has passed. */
  due: boolean;
  /** What the drop gate approves: this old table, by its UUID, and its date. Absent when there is nothing to drop. */
  dropDigest?: string;
}

/** Where the old table is kept and until when, and the digest the drop gate binds. */
export async function retainPlan(run: RebuildRun): Promise<RetainResult> {
  const o = await observe(run);
  if (!o.old) return { state: o.state, due: false };
  const retainUntil = o.old.pairs?.get("retain-until");
  const due = retainUntil !== undefined && (await serverNow(run.target)) >= Date.parse(retainUntil);
  const oldTable = `${o.names.database}.${o.names.oldName}`;
  return {
    state: o.state,
    oldTable,
    ...(retainUntil ? { retainUntil } : {}),
    due,
    dropDigest: computePlanDigest("clickhouse-rebuild-drop", { table: o.names.key, old: oldTable, uuid: o.old.uuid, retainUntil: retainUntil ?? null }),
  };
}

export interface DropResult {
  state: RebuildObservation["state"];
  dropped: boolean;
  oldTable?: string;
  retainUntil?: string;
}

/** Drop the old table once its retention date has passed. Before then, say until when and drop nothing. */
export async function dropOldTable(run: RebuildRun): Promise<DropResult> {
  const plan = await retainPlan(run);
  if (!plan.oldTable) return { state: plan.state, dropped: false };
  if (!plan.due) {
    run.log(`-- ${plan.oldTable} is kept until ${plan.retainUntil}; a run after that drops it`);
    return { state: plan.state, dropped: false, oldTable: plan.oldTable, ...(plan.retainUntil ? { retainUntil: plan.retainUntil } : {}) };
  }
  const n = rebuildNames(run.declared.canonical.database ?? run.target.defaultDatabase, run.declared.canonical.name);
  await q(run, `DROP TABLE ${n.oldTable} SYNC`);
  return { state: "done", dropped: true, oldTable: plan.oldTable };
}

// ── onFailure ──────────────────────────────────────────────────────────

export interface CompensateResult {
  dropped: string[];
}

/**
 * onFailure: drop the dual-write view and the new table, and nothing else.
 * Each is dropped only when its comment names this rebuild and its role and
 * carries this project's marker. After the EXCHANGE the new table is under
 * the table's own name and the old one under the new table's name without
 * `role=new`, so neither is touched: the swap is finished by the next run,
 * not undone. The old table kept after a swap (`role=old`) is never dropped
 * here; the drop gate decides that.
 */
export async function compensate(run: Pick<RebuildRun, "target" | "declared" | "marker" | "log" | "signal">): Promise<CompensateResult> {
  const n = rebuildNames(run.declared.canonical.database ?? run.target.defaultDatabase, run.declared.canonical.name);
  const rows = await clickhouseQuery<{ name: string; comment: string }>(
    run.target.endpoint,
    `SELECT name, comment FROM system.tables WHERE database = ${sqlString(n.database)} AND name IN (${sqlString(n.dualName)}, ${sqlString(n.newName)})`,
  );
  const dropped: string[] = [];
  for (const [name, role, what] of [
    [n.dualName, "dual", "VIEW"],
    [n.newName, "new", "TABLE"],
  ] as const) {
    const row = rows.find((r) => r.name === name);
    const pairs = readTrailerPairs(row?.comment);
    if (!row || pairs?.get(REBUILD_TRAILER_KEY) !== n.key || pairs.get("role") !== role || !carriesMarker(row.comment, run.marker)) continue;
    const sql = `DROP ${what} ${qualifiedIdent(n.database, name)} SYNC`;
    run.log(sql);
    await clickhouseQuery(run.target.endpoint, sql);
    dropped.push(`${n.database}.${name}`);
  }
  return { dropped };
}
