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
 */

import { EffectReceipt, receiptExpectation } from "@intentius/chant/effect-receipt";
import { clickhouseQuery } from "../http";
import { ident, sqlString } from "../apply/statements";
import { clickhouseReceiptStore, receiptAddress, type ClickHouseReceiptStore } from "./receipts";
import { RebuildRefusal, type RebuildObservation } from "./observe";
import { DDL_SETTINGS } from "./replicas";
import { sourcePartitionExpression, sourcePartitions } from "./partitions";
import { cutoverOf, observe, serverNow, syncReplica, utcLiteral, waitOn, type RebuildRun } from "./steps";

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
}

/** The effect a partition's copy is, and its receipt's address suffix. */
export const partitionEffect = (key: string, partition: string): string => `rebuild/${key}/${partition}`;

/** The receipt's expected value for one partition's copy. */
export function partitionExpectation(o: RebuildObservation, partition: string, cutover: number | undefined): string {
  const effect = partitionEffect(o.names.key, partition);
  return receiptExpectation(
    EffectReceipt(effect, {
      effect,
      flavor: "hash",
      inputs: { table: o.names.key, newTable: o.newTable!.uuid, partition, copied: o.copied, cutover: cutover === undefined ? null : new Date(cutover).toISOString() },
    }),
  );
}

export interface BackfillDeps {
  /** The receipt store. Default: the receipts table on the target server. */
  receipts?: ClickHouseReceiptStore;
  /** Called after each partition is copied and its receipt written; a test interrupts the backfill here. */
  afterPartition?: (partition: string) => void | Promise<void>;
}

export async function backfill(run: RebuildRun, deps: BackfillDeps = {}): Promise<BackfillResult> {
  const o = await observe(run);
  const result: BackfillResult = { state: o.state, partitions: 0, copied: 0, skipped: 0, cleared: 0 };
  if (o.state !== "rebuild") return result;
  if (!o.newTable) throw new RebuildRefusal(`${o.names.key}: the new table is not there yet; the Create phase makes it`);
  const n = o.names;
  const cutover = cutoverOf(run, o);

  if (cutover !== undefined) {
    // Rows before the cut-over are the backfill's; wait until the server's
    // clock has passed it, so none of them is still to arrive.
    for (;;) {
      const now = await serverNow(run.target);
      if (now > cutover) break;
      run.log(`-- waiting ${Math.ceil((cutover - now) / 1000)}s for the cut-over at ${new Date(cutover).toISOString()}`);
      await sleep(Math.min(cutover - now + 50, 10_000), run.signal);
    }
  }
  await waitOn(run, n.database, n.name);
  await syncReplica(run, o, n.database, n.name);

  const cutColumn = run.dualWrite.mode === "materialized-view" ? o.copied.find((c) => c.name === (run.dualWrite as { cutoverColumn: string }).cutoverColumn) : undefined;
  const sourceRange = cutColumn && cutover !== undefined ? ` AND ${ident(cutColumn.source)} < ${utcLiteral(cutover)}` : "";
  const targetRange = cutColumn && cutover !== undefined ? ` AND ${ident(cutColumn.name)} < ${utcLiteral(cutover)}` : "";
  const fromOld = sourcePartitionExpression(o.live.partitionKey, o.newTable.partitionKey, o.copied);
  const columns = o.copied.map((c) => ident(c.name)).join(", ");
  const select = o.copied.map((c) => ident(c.source)).join(", ");

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

  const partitions = await sourcePartitions(run.target, n);
  result.partitions = partitions.length;
  for (const p of partitions) {
    run.signal?.throwIfAborted();
    const effect = partitionEffect(n.key, p);
    const expectation = partitionExpectation(o, p, cutover);
    if (recorded.get(receiptAddress(identity, effect)) === expectation) {
      result.skipped++;
      continue;
    }

    const queryId = `chant-rebuild-${o.newTable.uuid}-${p}`;
    if (o.replicated) {
      // On every replica that answers: the copy may be running on another one
      // than this run's. A replica that is down is skipped once Keeper sees it
      // inactive; nothing of its can be running a copy that still writes,
      // and a part it wrote before going down is waited for by the sync below.
      await clickhouseQuery(run.target.endpoint, `KILL QUERY ON CLUSTER ${sqlString(n.database)} WHERE query_id = ${sqlString(queryId)} SYNC`, {
        settings: DDL_SETTINGS,
      });
      await syncReplica(run, o, n.database, n.newName);
    } else {
      await clickhouseQuery(run.target.endpoint, `KILL QUERY WHERE query_id = ${sqlString(queryId)} SYNC`);
    }
    const mine = `${fromOld} = ${sqlString(p)}${targetRange}`;
    const [left] = await clickhouseQuery<{ n: string | number }>(run.target.endpoint, `SELECT count() AS n FROM ${n.newTable} WHERE ${mine}`);
    if (Number(left?.n ?? 0) > 0) {
      run.log(`-- partition ${p}: ${left!.n} row(s) from a copy that did not finish; deleting them before copying again`);
      const sql = `ALTER TABLE ${n.newTable} DELETE WHERE ${mine}`;
      run.log(sql);
      await clickhouseQuery(run.target.endpoint, sql);
      await waitOn(run, n.database, n.newName);
      result.cleared++;
    }

    const sql = `INSERT INTO ${n.newTable} (${columns}) SELECT ${select} FROM ${n.table} WHERE _partition_id = ${sqlString(p)}${sourceRange}`;
    run.log(sql);
    await clickhouseQuery(run.target.endpoint, sql, { queryId, settings: { async_insert: "0", insert_deduplicate: "0" }, ...(run.signal ? { signal: run.signal } : {}) });
    // The receipt, last, on success only.
    await receipts.write({ name: effect, effect, flavor: "hash", inputs: {} }, expectation);
    result.copied++;
    await deps.afterPartition?.(p);
  }
  run.log(`-- backfill of ${n.key}: ${result.partitions} partition(s), ${result.copied} copied, ${result.skipped} already copied, ${result.cleared} cleared first`);
  return result;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
