/**
 * The backfill (#3198): copy the old table into the new one with
 * `INSERT ... SELECT`, one partition at a time, each partition an effect
 * with its own receipt.
 *
 * Per partition, the cycle core's `effect()` step runs
 * (concepts/effect-receipts.mdx): read the receipt, skip the copy when it
 * matches, otherwise copy and write the receipt last, on success only.
 * `effect()` itself wraps steps declared at build time around one receipt
 * declared at build time; the partitions are only known when the run reads
 * the old table, so the cycle runs here, once per partition, over the same
 * `ReceiptStore` seam (`./receipts.ts`).
 *
 * A receipt's expectation is a hash of what the copy is: the table, the new
 * table's UUID, the partition, the columns copied and the cut-over. A new
 * table made again, or a new cut-over, makes every receipt stale and the
 * partitions are copied again into the new table.
 *
 * At-least-once is the receipt model's guarantee, and a partition copied
 * twice would be in the new table twice, so a copy that may have run before
 * is undone first. A partition with no matching receipt is a partition whose
 * copy never finished as far as anything recorded; if the new table holds
 * any of its rows (a run killed between the INSERT and the receipt), they are
 * deleted, the delete is waited on in `system.mutations`, and the partition
 * is copied once more. Each copy runs under a query id derived from the new
 * table and the partition, and any query still running under it (the server
 * goes on with an INSERT whose client went away) is killed before the
 * partition is cleared. A backfill interrupted halfway therefore resumes at
 * the first partition without a receipt, and no row is copied twice.
 *
 * In a Replicated database (#3249) a resumed backfill may run on another
 * replica than the one the copy ran on. The kill is `KILL QUERY ON CLUSTER`
 * the database's own cluster, so it reaches the replica still running the
 * copy; before the old table's partitions are listed, and before the new
 * table's rows are counted, this replica fetches what the others wrote
 * (`SYSTEM SYNC REPLICA`); and the receipts replicate with the tables
 * (`./receipts.ts`). Each copy runs with `insert_deduplicate = 0`: a
 * replicated table remembers the blocks it was given, and a partition copied
 * again after its rows were cleared would otherwise be dropped as a repeat.
 *
 * With a replica down (#3270) the kill goes on without it, and each sync
 * either finds nothing that replica alone has and returns, or stops the step
 * naming it (`./replicas.ts`).
 *
 * On a cluster of more than one shard (#3663) the unit is a partition on one
 * shard: read from that shard, written back to it, cleared on it alone, with
 * its own receipt (`./shards.ts`), so a rerun after a failure on one shard
 * skips what every shard already copied.
 *
 * In materialized-view mode a partition is copied in two parts
 * (INTENTIUS/sql-yodeler#45). The rows before the cut-over are copied as
 * above. The rows at or after it are the view's only when they were written
 * after the view was made; the ones the old table already held (a booking
 * next month, an expiry date) reach the new table only through the backfill.
 * The two kinds cannot be told apart by their values, so the second part
 * copies the difference: for each distinct row at or after the cut-over, as
 * many copies as the old table has more of it than the new one. That copy
 * converges on its own, so a run killed during it, or a partition copied
 * again, copies only what is still missing. A row the view is a moment from
 * committing can be copied by both: the copy is followed by a check for rows
 * the new table holds more often than the old one, which deletes and copies
 * those again. Whatever is left, the verification finds, and the swap does
 * not go ahead.
 */

import { EffectReceipt, receiptExpectation } from "@intentius/chant/effect-receipt";
import { clickhouseQuery } from "../http";
import { ident, sqlString } from "../apply/statements";
import { clickhouseReceiptStore, receiptAddress, type ClickHouseReceiptStore } from "./receipts";
import { RebuildRefusal, type RebuildObservation } from "./observe";
import { DDL_SETTINGS } from "./replicas";
import { shardPartitions, sourcePartitionExpression, sourcePartitions } from "./partitions";
import { rowHash } from "./verify";
import { cutoverOf, observe, serverCutoverProbe, syncReplica, utcLiteral, waitForCutover, waitOn, type CutoverProbe, type RebuildRun } from "./steps";
import { intoShard, onShard, onShardServers, shardTable, SHARD_DELETE_SETTINGS, SHARD_INSERT_SETTINGS, type Shard } from "./shards";
import { renderFor } from "../topology";

export interface BackfillResult {
  state: RebuildObservation["state"];
  /** Partitions of the old table. */
  partitions: number;
  /** Copied in this run. */
  copied: number;
  /** Skipped: their receipt matched. */
  skipped: number;
  /** Partitions this run found partly copied and cleared before copying again. */
  cleared: number;
  /** Distinct rows at or after the cut-over found in the new table too often (copied while the view was writing them), deleted and copied again. */
  repaired: number;
}

/** The effect a partition's copy is, and its receipt's address suffix. */
export const partitionEffect = (key: string, partition: string, shard?: Shard): string => (shard ? `rebuild/${key}/shard${shard.num}/${partition}` : `rebuild/${key}/${partition}`);

/** The receipt's expected value for one partition's copy, on one shard of a cluster when `shard` is given. */
export function partitionExpectation(o: RebuildObservation, partition: string, cutover: number | undefined, shard?: Shard): string {
  const effect = partitionEffect(o.names.key, partition, shard);
  return receiptExpectation(
    EffectReceipt(effect, {
      effect,
      flavor: "hash",
      inputs: {
        table: o.names.key,
        newTable: o.newTable!.uuid,
        partition,
        ...(shard ? { shard: shard.num } : {}),
        copied: o.copied,
        cutover: cutover === undefined ? null : new Date(cutover).toISOString(),
        // The rows at or after the cut-over the old table held are copied too (sql-yodeler#45); a receipt from before that copied fewer.
        ...(cutover === undefined ? {} : { after: "difference" }),
      },
    }),
  );
}

export interface BackfillDeps {
  /** The receipt store. Default: the receipts table on the target server. */
  receipts?: ClickHouseReceiptStore;
  /** Called after each partition is copied and its receipt written, with its shard on a cluster of shards; a test interrupts the backfill here. */
  afterPartition?: (partition: string, shard?: number) => void | Promise<void>;
  /** What the wait for the cut-over reads. Default: the server's clock, queries and insert buffers. */
  cutoverProbe?: CutoverProbe;
}

export async function backfill(run: RebuildRun, deps: BackfillDeps = {}): Promise<BackfillResult> {
  const o = await observe(run);
  const result: BackfillResult = { state: o.state, partitions: 0, copied: 0, skipped: 0, cleared: 0, repaired: 0 };
  if (o.state !== "rebuild") return result;
  if (!o.newTable) throw new RebuildRefusal(`${o.names.key}: the new table is not there yet; the Create phase makes it`);
  const n = o.names;
  const cutover = cutoverOf(run, o);

  // Rows before the cut-over are the backfill's; wait until none of them is still to arrive.
  if (cutover !== undefined) await waitForCutover(run, cutover, deps.cutoverProbe ?? serverCutoverProbe(run, o), run.cutoverTimeoutMs !== undefined ? { timeoutMs: run.cutoverTimeoutMs } : {});
  await waitOn(run, n.database, n.name);
  await syncReplica(run, o, n.database, n.name);

  const cutColumn = run.dualWrite.mode === "materialized-view" ? o.copied.find((c) => c.name === (run.dualWrite as { cutoverColumn: string }).cutoverColumn) : undefined;
  const sourceRange = cutColumn && cutover !== undefined ? ` AND ${ident(cutColumn.source)} < ${utcLiteral(cutover)}` : "";
  const targetRange = cutColumn && cutover !== undefined ? ` AND ${ident(cutColumn.name)} < ${utcLiteral(cutover)}` : "";
  const fromOld = sourcePartitionExpression(o.live.partitionKey, o.newTable.partitionKey, o.copied);
  const columns = o.copied.map((c) => ident(c.name)).join(", ");
  const select = o.copied.map((c) => ident(c.source)).join(", ");
  const later = cutColumn && cutover !== undefined ? await laterRowsCopy(run, o, cutColumn, cutover, fromOld) : undefined;
  const sharding = run.sharding;
  // The old and new tables as one shard's rows (#3663, `./shards.ts`), or as this server's.
  const oldFrom = (shard?: Shard) => (shard && sharding ? `${shardTable(sharding, n.database, n.name)} WHERE ${onShard(shard)} AND` : `${n.table} WHERE`);
  const newFrom = (shard?: Shard) => (shard && sharding ? `${shardTable(sharding, n.database, n.newName)} WHERE ${onShard(shard)} AND` : `${n.newTable} WHERE`);
  const into = (shard?: Shard) => (shard && sharding ? intoShard(sharding, shard, n.database, n.newName) : n.newTable);
  const insertSettings = sharding ? SHARD_INSERT_SETTINGS : {};

  const identity = { ...(run.marker?.stack ? { stack: run.marker.stack } : {}), ...(run.marker?.env ? { env: run.marker.env } : {}) };
  const receipts =
    deps.receipts ??
    clickhouseReceiptStore(run.target.endpoint, identity, {
      ...(run.runId ? { runId: run.runId } : {}),
      ...(o.replicated ? { replicatedIn: n.database } : {}),
      ...(run.target.topology ? { topology: run.target.topology } : {}),
      ...(run.replicaTimeoutMs !== undefined ? { replicaTimeoutMs: run.replicaTimeoutMs } : {}),
    });
  const recorded = await receipts.readAll(receiptAddress(identity, `rebuild/${n.key}/`));

  // The unit of work: a partition of the old table, on each shard of a cluster that has more than one.
  const units: Array<{ shard?: Shard; partition: string }> = sharding
    ? (await shardPartitions(run, sharding, n.database, n.name)).map((u) => ({ shard: sharding.shards.find((x) => x.num === u.shard)!, partition: u.partition }))
    : (await sourcePartitions(run.target, n)).map((partition) => ({ partition }));
  result.partitions = units.length;
  for (const { shard, partition: p } of units) {
    run.signal?.throwIfAborted();
    const effect = partitionEffect(n.key, p, shard);
    const expectation = partitionExpectation(o, p, cutover, shard);
    if (recorded.get(receiptAddress(identity, effect)) === expectation) {
      result.skipped++;
      continue;
    }

    const queryId = `chant-rebuild-${o.newTable.uuid}-${shard ? `shard${shard.num}-` : ""}${p}`;
    const laterQueryId = `${queryId}-after`;
    const killWhere = `query_id IN (${sqlString(queryId)}, ${sqlString(laterQueryId)})`;
    if (sharding) {
      // The copy reads and writes every shard from this server; what it started on the others goes with it.
      await clickhouseQuery(
        run.target.endpoint,
        `KILL QUERY ON CLUSTER ${sqlString(sharding.cluster)} WHERE ${killWhere} OR initial_query_id IN (${sqlString(queryId)}, ${sqlString(laterQueryId)}) SYNC`,
        { settings: DDL_SETTINGS },
      );
    } else if (o.replicated) {
      // On every replica that answers: the copy may be running on another one
      // than this run's. A replica that is down is skipped once Keeper sees it
      // inactive; nothing of its can be running a copy that still writes,
      // and a part it wrote before going down is waited for by the sync below.
      await clickhouseQuery(run.target.endpoint, `KILL QUERY ON CLUSTER ${sqlString(n.database)} WHERE ${killWhere} SYNC`, {
        settings: DDL_SETTINGS,
      });
      await syncReplica(run, o, n.database, n.newName);
    } else {
      await clickhouseQuery(run.target.endpoint, `KILL QUERY WHERE ${killWhere} SYNC`);
    }
    const mine = `${fromOld} = ${sqlString(p)}${targetRange}`;
    const where = shard ? `partition ${p} on shard ${shard.num}` : `partition ${p}`;
    const [left] = await clickhouseQuery<{ n: string | number }>(run.target.endpoint, `SELECT count() AS n FROM ${newFrom(shard)} ${mine}`);
    if (Number(left?.n ?? 0) > 0) {
      run.log(`-- ${where}: ${left!.n} row(s) from a copy that did not finish; deleting them before copying again`);
      const sql =
        shard && sharding
          ? renderFor(`ALTER TABLE ${n.newTable} DELETE WHERE ${onShardServers(shard)} AND ${mine}`, run.target.topology)
          : `ALTER TABLE ${n.newTable} DELETE WHERE ${mine}`;
      run.log(sql);
      await clickhouseQuery(run.target.endpoint, sql, shard && sharding ? { settings: { ...DDL_SETTINGS, ...SHARD_DELETE_SETTINGS } } : {});
      await waitOn(run, n.database, n.newName);
      result.cleared++;
    }

    const sql = `INSERT INTO ${into(shard)} (${columns}) SELECT ${select} FROM ${oldFrom(shard)} _partition_id = ${sqlString(p)}${sourceRange}`;
    run.log(sql);
    await clickhouseQuery(run.target.endpoint, sql, { queryId, settings: { async_insert: "0", insert_deduplicate: "0", ...insertSettings }, ...(run.signal ? { signal: run.signal } : {}) });
    if (later) result.repaired += await copyAfterCutover(run, o, later, p, laterQueryId, shard);
    // The receipt, last, on success only.
    await receipts.write({ name: effect, effect, flavor: "hash", inputs: {} }, expectation);
    result.copied++;
    await deps.afterPartition?.(p, shard?.num);
  }
  run.log(`-- backfill of ${n.key}: ${result.partitions} partition(s), ${result.copied} copied, ${result.skipped} already copied, ${result.cleared} cleared first${result.repaired > 0 ? `, ${result.repaired} row(s) after the cut-over copied twice and repaired` : ""}`);
  return result;
}

/** The statements that copy one old partition's rows at or after the cut-over. */
interface LaterRows {
  /**
   * Per distinct row (by its hash), the old table's copies past the number
   * the new table holds, into the new table. On a cluster of shards, one
   * shard's rows into the same shard.
   */
  copy: (partition: string, shard?: Shard) => string;
  /** The hashes of the rows the new table holds more copies of than the old one. */
  extras: (partition: string, shard?: Shard) => string;
  /** Delete every copy of those rows from the new table. */
  drop: (partition: string, hashes: readonly string[], shard?: Shard) => string;
}

/** The most extra rows one partition's repair deletes and copies again; past that the verification decides. */
const REPAIR_LIMIT = 1000;
const REPAIR_ROUNDS = 3;

/**
 * The statements for the rows at or after the cut-over. The old side casts
 * each column to its type in the new table before hashing, as the
 * verification does, so a row and its copy hash the same.
 */
async function laterRowsCopy(
  run: RebuildRun,
  o: RebuildObservation,
  cut: RebuildObservation["copied"][number],
  cutover: number,
  fromOld: string,
): Promise<LaterRows> {
  const n = o.names;
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
  const columns = o.copied.map((c) => ident(c.name)).join(", ");
  const aliases = o.copied.map((_, i) => `__chant_c${i}`);
  const fromOldSide = o.copied.map((c, i) => `${ident(c.source)} AS ${aliases[i]}`).join(", ");
  const sharding = run.sharding;
  const on = (shard?: Shard) => (shard && sharding ? ` AND ${onShard(shard)}` : "");
  const oldTable = (shard?: Shard) => (shard && sharding ? shardTable(sharding, n.database, n.name) : n.table);
  const newTable = (shard?: Shard) => (shard && sharding ? shardTable(sharding, n.database, n.newName) : n.newTable);
  const oldRows = (p: string, shard?: Shard) => `FROM ${oldTable(shard)} WHERE _partition_id = ${sqlString(p)} AND ${ident(cut.source)} >= ${utcLiteral(cutover)}${on(shard)}`;
  const newRows = (p: string, shard?: Shard) => `FROM ${newTable(shard)} WHERE ${fromOld} = ${sqlString(p)} AND ${ident(cut.name)} >= ${utcLiteral(cutover)}${on(shard)}`;
  return {
    copy: (p, shard) =>
      `INSERT INTO ${shard && sharding ? intoShard(sharding, shard, n.database, n.newName) : n.newTable} (${columns}) SELECT ${aliases.join(", ")} FROM (` +
      `SELECT ${fromOldSide}, ${oldHash} AS __chant_h, row_number() OVER (PARTITION BY __chant_h) AS __chant_k ${oldRows(p, shard)}` +
      `) AS old_rows LEFT JOIN (SELECT ${newHash} AS __chant_h, count() AS __chant_n ${newRows(p, shard)} GROUP BY __chant_h) AS new_rows ` +
      `USING (__chant_h) WHERE __chant_k > ifNull(__chant_n, 0)`,
    extras: (p, shard) =>
      `SELECT toString(__chant_h) AS h FROM (SELECT ${newHash} AS __chant_h, count() AS __chant_n ${newRows(p, shard)} GROUP BY __chant_h) AS new_rows ` +
      `LEFT JOIN (SELECT ${oldHash} AS __chant_h, count() AS __chant_o ${oldRows(p, shard)} GROUP BY __chant_h) AS old_rows ` +
      `USING (__chant_h) WHERE __chant_n > ifNull(__chant_o, 0) LIMIT ${REPAIR_LIMIT + 1}`,
    drop: (p, hashes, shard) => {
      const where = `${fromOld} = ${sqlString(p)} AND ${ident(cut.name)} >= ${utcLiteral(cutover)} AND ${newHash} IN (${hashes.join(", ")})`;
      return shard && sharding
        ? renderFor(`ALTER TABLE ${n.newTable} DELETE WHERE ${onShardServers(shard)} AND ${where}`, run.target.topology)
        : `ALTER TABLE ${n.newTable} DELETE WHERE ${where}`;
    },
  };
}

/**
 * Copy one old partition's rows at or after the cut-over that the new table
 * lacks. A row the view had written to the old table but not yet to the new
 * one when the copy read them is copied by both, and is then in the new
 * table once too often: every copy of such a row is deleted from the new
 * table and the difference copied again, a few rounds at most. What is left
 * after that, the verification finds. Returns the rows repaired.
 */
async function copyAfterCutover(run: RebuildRun, o: RebuildObservation, later: LaterRows, p: string, queryId: string, shard?: Shard): Promise<number> {
  const n = o.names;
  const sharded = shard !== undefined && run.sharding !== undefined;
  const insert = async () => {
    const sql = later.copy(p, shard);
    run.log(sql);
    await clickhouseQuery(run.target.endpoint, sql, {
      queryId,
      settings: { async_insert: "0", insert_deduplicate: "0", ...(sharded ? SHARD_INSERT_SETTINGS : {}) },
      ...(run.signal ? { signal: run.signal } : {}),
    });
  };
  await insert();
  let repaired = 0;
  for (let round = 0; round < REPAIR_ROUNDS; round++) {
    await syncReplica(run, o, n.database, n.newName);
    const extras = (await clickhouseQuery<{ h: string }>(run.target.endpoint, later.extras(p, shard))).map((r) => r.h);
    if (extras.length === 0 || extras.length > REPAIR_LIMIT) break;
    run.log(`-- partition ${p}: ${extras.length} row(s) after the cut-over in the new table more often than in the old one; deleting them and copying again`);
    const sql = later.drop(p, extras, shard);
    run.log(sql);
    await clickhouseQuery(run.target.endpoint, sql, sharded ? { settings: { ...DDL_SETTINGS, ...SHARD_DELETE_SETTINGS } } : {});
    await waitOn(run, n.database, n.newName);
    repaired += extras.length;
    await insert();
  }
  return repaired;
}
