/**
 * The verification (#3198, INTENTIUS/sql-yodeler#45): row counts and
 * checksums per partition, the old table against the new one, before anyone
 * is asked to approve the swap.
 *
 * Per partition of the old table: the number of rows and the sum of a
 * 64-bit hash of each row's copied columns, read in one grouped query on
 * each side. The old side casts each column to its type in the new table
 * first, so a column whose type the rebuild changes hashes the same when
 * its values survived the change.
 *
 * Every row is compared, in both modes. In materialized-view mode the rows
 * at or after the cut-over are in the new table twice over: those the old
 * table held before the view existed, which the backfill copies, and those
 * written since, which the view writes. Comparing only the rows before the
 * cut-over let a swap go ahead without the first kind (sql-yodeler#45).
 * Writes go on while the tables are read, and a row the old table has
 * committed may be a moment from committing in the new one through the view,
 * so the old table is read first and a difference is read again a few times
 * before it counts.
 *
 * The same comparison runs again in the Swap step just before the
 * `EXCHANGE`, so rows that reach the old table alone after this step (a row
 * later than the cut-over delay, with a time before the cut-over) stop the
 * swap too, rather than stay behind in the old table.
 *
 * A table whose engine collapses rows that share a sorting key when parts
 * merge (Summing, Replacing, Aggregating, Collapsing, VersionedCollapsing,
 * Coalescing and Graphite, replicated or not), rebuilt into such an engine,
 * is read under `FINAL` on both sides (#3674). The old table can hold unmerged parts with several rows for
 * one key, which the copy inserts in one block and the new table collapses
 * as it writes them, so the raw counts differ although the data is the same.
 * Under `FINAL` both sides are compared as merged.
 *
 * On a cluster of more than one shard (#3663) every shard is read, through
 * the profile's server, and each partition is compared per shard
 * (`shard<n>/<partition>`), so a shard the copy missed is a difference.
 *
 * Any difference fails the run, naming the partitions; the run's onFailure
 * then drops the new table. On a match the result carries the digest the
 * swap gate binds: the rebuild's plan and the counts and checksums of the
 * rows before the cut-over, which no later write changes, so an approval
 * is for this plan with these counts, and a changed count needs a new
 * approval. The rows at or after the cut-over keep arriving through the view
 * and are compared, not bound.
 */

import { computePlanDigest } from "@intentius/chant/op";
import { clickhouseQuery } from "../http";
import { ident, sqlString } from "../apply/statements";
import { rebuildPlanSubject, RebuildRefusal, type RebuildObservation } from "./observe";
import { sourcePartitionExpression } from "./partitions";
import { cutoverOf, observe, syncReplica, utcLiteral, waitOn, type RebuildRun } from "./steps";
import { shardTable } from "./shards";
import { collapsesRows } from "./engines";

export interface PartitionCheck {
  partition: string;
  rows: number;
  checksum: string;
}

export interface VerifyResult {
  state: RebuildObservation["state"];
  /** The digest the swap gate binds: plan plus verification. Absent once the swap has run: there is nothing left for that gate to approve. */
  planDigest?: string;
  /** Partitions of the old table compared. */
  partitions: number;
  /** Rows compared: every row of the old table. */
  rows: number;
  /** One line for the run record and the gate. */
  summary: string;
  /** Per partition, the rows before the cut-over (every row in app mode): what the swap gate binds. */
  verification: PartitionCheck[];
}

/** A verification that found the tables different. */
export class RebuildVerificationError extends Error {
  constructor(
    readonly table: string,
    readonly mismatches: Mismatch[],
    /** The engine, when it collapses rows and the tables were compared under FINAL (#3674). */
    readonly collapsingEngine?: string,
  ) {
    const shown = mismatches
      .slice(0, 10)
      .map((m) => `${m.partition}: old ${m.old ? `${m.old.rows} rows, checksum ${m.old.checksum}` : "none"}, new ${m.new ? `${m.new.rows} rows, checksum ${m.new.checksum}` : "none"}`)
      .join("; ");
    const lateWrite =
      `in materialized-view mode a row written to the old table later than the cut-over delay, with a time before the cut-over, ` +
      `and in app mode a write the application did not stop`;
    super(
      `${table}: the new table does not match the old one in ${mismatches.length} partition(s): ${shown}${mismatches.length > 10 ? "; ..." : ""}. Nothing was swapped. ` +
        (collapsingEngine
          ? `${table} is a ${collapsingEngine}, which collapses rows that share a sorting key when parts merge, and both tables were compared under FINAL. ` +
            `They still differ when the new table collapses the copied rows by its sorting key differently from how the old one merges them: ` +
            `run OPTIMIZE TABLE ${table} FINAL, drop the new table if the Op kept it, and run the rebuild again, so the copy reads merged rows. ` +
            `The other causes are ${lateWrite}.`
          : `The usual cause is ${lateWrite}.`),
    );
    this.name = "RebuildVerificationError";
  }
}

/** How often a difference is read again before it counts, and how long apart. */
const COMPARE_ATTEMPTS = 5;
const COMPARE_INTERVAL_MS = 1000;

/** One side's counts per old partition: every row, and the rows before the cut-over. */
interface SideCounts {
  all: Map<string, PartitionCheck>;
  before: Map<string, PartitionCheck>;
}

/**
 * Read both tables' counts and checksums per old partition, the old table
 * first, until they agree or `attempts` reads have disagreed. Returns the
 * last read and the partitions that differ in it.
 */
async function compareTables(
  run: RebuildRun,
  o: RebuildObservation,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<{ old: SideCounts; new: SideCounts; mismatches: Mismatch[]; collapsingEngine?: string }> {
  if (!o.newTable) throw new RebuildRefusal(`${o.names.key}: the new table is not there yet; the Create phase makes it`);
  const n = o.names;
  const cutover = cutoverOf(run, o);
  await waitOn(run, n.database, n.name);
  await waitOn(run, n.database, n.newName);

  const types = new Map(
    (
      await clickhouseQuery<{ name: string; type: string }>(
        run.target.endpoint,
        `SELECT name, type FROM system.columns WHERE database = ${sqlString(n.database)} AND table = ${sqlString(n.newName)}`,
      )
    ).map((c) => [c.name, c.type]),
  );
  const oldHash = rowHash(o.copied.map((c) => `CAST(${ident(c.source)}, ${sqlString(types.get(c.name) ?? "String")})`));
  const newHash = rowHash(o.copied.map((c) => ident(c.name)));
  const cut = run.dualWrite.mode === "materialized-view" ? o.copied.find((c) => c.name === (run.dualWrite as { cutoverColumn: string }).cutoverColumn) : undefined;
  const oldBefore = cut && cutover !== undefined ? `${ident(cut.source)} < ${utcLiteral(cutover)}` : "1";
  const newBefore = cut && cutover !== undefined ? `${ident(cut.name)} < ${utcLiteral(cutover)}` : "1";
  const fromOld = sourcePartitionExpression(o.live.partitionKey, o.newTable.partitionKey, o.copied);

  // Across the shards of a cluster (#3663), every shard's rows, each partition counted per shard as `shard<n>/<partition>`.
  const sharding = run.sharding;
  // Tables whose engines collapse rows by sorting key are read as merged (#3674). Only when both do: a collapsing
  // table rebuilt into a plain MergeTree keeps every row it copies, and is compared row for row.
  const final = collapsesRows(o.live.engine) && collapsesRows(o.newTable.engine);
  const read = async (table: string, name: string, partition: string, hash: string, before: string, final: boolean): Promise<SideCounts> => {
    const from = `${sharding ? shardTable(sharding, n.database, name) : table}${final ? " FINAL" : ""}`;
    const key = sharding ? `concat('shard', toString(_shard_num), '/', ${partition})` : partition;
    const rows = await clickhouseQuery<{ p: string; rows: string | number; checksum: string; brows: string | number; bchecksum: string }>(
      run.target.endpoint,
      `SELECT ${key} AS p, count() AS rows, toString(sum(${hash})) AS checksum, countIf(${before}) AS brows, toString(sumIf(${hash}, ${before})) AS bchecksum ` +
        `FROM ${from} GROUP BY p`,
    );
    const side: SideCounts = { all: new Map(), before: new Map() };
    for (const r of rows) {
      side.all.set(r.p, { partition: r.p, rows: Number(r.rows), checksum: r.checksum });
      // A partition with no row before the cut-over is left out, as a WHERE would leave it out.
      if (Number(r.brows) > 0) side.before.set(r.p, { partition: r.p, rows: Number(r.brows), checksum: r.bchecksum });
    }
    return side;
  };

  const attempts = Math.max(1, opts.attempts ?? COMPARE_ATTEMPTS);
  for (let attempt = 1; ; attempt++) {
    // In a Replicated database: count what every replica wrote, not what this one has fetched so far.
    await syncReplica(run, o, n.database, n.name);
    await syncReplica(run, o, n.database, n.newName);
    // The old table first: a row the view has yet to commit in the new one is read as missing there, never the other way round.
    const before = await read(n.table, n.name, "_partition_id", oldHash, oldBefore, final);
    const after = await read(n.newTable, n.newName, fromOld, newHash, newBefore, final);
    const mismatches = differences(before.all, after.all);
    if (mismatches.length === 0 || attempt >= attempts) {
      return { old: before, new: after, mismatches, ...(final ? { collapsingEngine: o.live.engine } : {}) };
    }
    run.log(`-- ${n.key}: ${mismatches.length} partition(s) differ (${mismatches.map((m) => m.partition).slice(0, 5).join(", ")}); reading again (${attempt}/${attempts})`);
    await sleep(opts.intervalMs ?? COMPARE_INTERVAL_MS, run.signal);
  }
}

export type Mismatch = { partition: string; old?: PartitionCheck; new?: PartitionCheck };

function differences(before: Map<string, PartitionCheck>, after: Map<string, PartitionCheck>): Mismatch[] {
  const out: Mismatch[] = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(p);
    const b = after.get(p);
    if (!a || !b || a.rows !== b.rows || a.checksum !== b.checksum) out.push({ partition: p, ...(a ? { old: a } : {}), ...(b ? { new: b } : {}) });
  }
  return out;
}

/** The 64-bit hash of a row's copied columns, as the backfill and the verification compute it. */
export const rowHash = (columns: readonly string[]): string => `cityHash64(toString(tuple(${columns.join(", ")})))`;

/**
 * Before the swap: the new table holds every row the old one does. Throws a
 * {@link RebuildVerificationError} when it does not, so nothing is swapped.
 */
export async function assertSameRows(run: RebuildRun, o: RebuildObservation): Promise<void> {
  const { mismatches, collapsingEngine } = await compareTables(run, o);
  if (mismatches.length > 0) throw new RebuildVerificationError(o.names.key, mismatches, collapsingEngine);
}

export async function verifyRebuild(run: RebuildRun): Promise<VerifyResult> {
  const o = await observe(run);
  if (o.state !== "rebuild") return { state: o.state, partitions: 0, rows: 0, verification: [], summary: `nothing to verify: ${o.state}` };
  const cutover = cutoverOf(run, o);
  const compared = await compareTables(run, o);
  if (compared.mismatches.length > 0) throw new RebuildVerificationError(o.names.key, compared.mismatches, compared.collapsingEngine);

  const all = [...compared.old.all.values()];
  const rows = all.reduce((s, v) => s + v.rows, 0);
  // What the approval binds: the rows before the cut-over (every row in app mode), which later writes do not change.
  const verification = [...compared.old.before.values()].sort((x, y) => x.partition.localeCompare(y.partition));
  const bound = verification.reduce((s, v) => s + v.rows, 0);
  const range = cutover !== undefined ? ` (${bound} of them before the cut-over at ${new Date(cutover).toISOString()})` : "";
  const merged = compared.collapsingEngine ? `, read under FINAL (${compared.collapsingEngine})` : "";
  const summary = `${o.names.key}: ${all.length} partition(s), ${rows} row(s)${range}, counts and checksums equal in the old and new tables${merged}`;
  run.log(`-- ${summary}`);
  return {
    state: o.state,
    planDigest: computePlanDigest("clickhouse-rebuild", {
      plan: rebuildPlanSubject(o, run.dualWrite),
      cutover: cutover === undefined ? null : new Date(cutover).toISOString(),
      verification,
    }),
    partitions: all.length,
    rows,
    summary,
    verification,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
