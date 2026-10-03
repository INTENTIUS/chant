/**
 * The backfill and the verification of the expand-and-contract migration
 * (#3281).
 *
 * ## Backfill
 *
 * The rows that were in the table before the dual write started are filled
 * in batches: one range of the primary key per batch, `[b * size, (b + 1) *
 * size)`, so a batch is the same rows on every run however many rows were
 * written since. Each batch is one transaction:
 *
 *     UPDATE t SET new = <expression> WHERE key >= lo AND key < hi AND new IS DISTINCT FROM <expression>;
 *     INSERT INTO __chant_receipts ... -- the batch's receipt, last
 *     COMMIT;
 *
 * under `lock_timeout` (a row an application transaction holds makes the
 * batch give up and try again rather than queue behind it) and the
 * statement timeout for a catalog change, which bounds how long one batch
 * may hold its row locks.
 *
 * Per batch, the cycle core's `effect()` step runs
 * (concepts/effect-receipts.mdx): read the receipt, skip the batch when it
 * matches, otherwise update and write the receipt last, on success only.
 * The batches are only known when the run reads the table, so the cycle runs
 * here over the shared core's `ReceiptStore` seam (`./receipts.ts`), as the
 * ClickHouse rebuild's does per partition. Unlike ClickHouse, the receipt
 * commits in the batch's own transaction: a run killed anywhere leaves a
 * batch with its receipt or neither, and a resumed backfill starts at the
 * first batch with no receipt and updates no batch twice.
 *
 * Before each batch the backfill waits while a replica is further behind
 * than the bound (`./replication.ts`).
 *
 * ## Verification
 *
 * One statement over the whole table, one snapshot: the rows, the rows whose
 * new column differs from the expression over the old one, the new column's
 * NULLs, and a checksum (the sum of a 64-bit hash of each value) of the new
 * column and of the expression. Any difference, or a NULL where the column
 * is declared NOT NULL, fails the run, whose onFailure then drops what the
 * expand added. The dual-write trigger keeps writes going during the
 * verification consistent; the statement reads the table under ACCESS SHARE
 * only.
 */

import { EffectReceipt, receiptExpectation } from "@intentius/chant/effect-receipt";
import { computePlanDigest } from "@intentius/chant/op";
import { col } from "./names";
import { MigrationRefusal, migrationPlanSubject, type MigrationObservation } from "./observe";
import { postgresReceiptStore, receiptAddress, type PostgresReceiptStore } from "./receipts";
import { waitForReplicas } from "./replication";
import { batchPrefix, identityOf, inTransaction, observe, type MigrationRun } from "./steps";
import { carriedNotReady, requiresNotNull } from "./carry";

export interface BackfillResult {
  state: MigrationObservation["state"];
  /** Batches of the table's key ranges that hold rows. */
  batches: number;
  /** Batches filled in this run. */
  filled: number;
  /** Batches skipped: their receipt matched. */
  skipped: number;
  /** Rows this run updated. */
  rows: number;
  /** How long the backfill paused for replicas, in ms. */
  pausedMs: number;
}

/** The effect a batch is, and its receipt's address suffix. */
export const batchEffect = (key: string, batch: string): string => `migrate/${key}/${batch}`;

/** The receipt's expected value for one batch: bound to the table, the new column's attribute number, the range and the expression. */
export function batchExpectation(o: MigrationObservation, batch: string, size: number): string {
  const effect = batchEffect(o.names.key, batch);
  return receiptExpectation(
    EffectReceipt(effect, {
      effect,
      flavor: "hash",
      inputs: { migration: o.names.key, table: o.oid, column: o.newColumn!.attnum, batch, size, key: o.batchKey, expression: o.expression },
    }),
  );
}

export interface BackfillDeps {
  /** The receipt store. Default: `<schema>.__chant_receipts` over the run's connection. */
  receipts?: PostgresReceiptStore;
  /** Called after a batch's receipt is written and before its transaction commits; a test kills the run here. */
  beforeCommit?: (batch: string) => void | Promise<void>;
  /** Called after each batch commits; a test interrupts the backfill here. */
  afterBatch?: (batch: string) => void | Promise<void>;
  /** Wait for replicas with this (tests). */
  waitForReplicas?: typeof waitForReplicas;
}

export async function backfill(run: MigrationRun, deps: BackfillDeps = {}): Promise<BackfillResult> {
  const o = await observe(run);
  const result: BackfillResult = { state: o.state, batches: 0, filled: 0, skipped: 0, rows: 0, pausedMs: 0 };
  if (o.state !== "migrate") return result;
  const n = o.names;
  if (!o.newColumn) throw new MigrationRefusal(`${n.key}: the new column is not there yet; the Expand phase adds it`);
  if (!o.trigger) throw new MigrationRefusal(`${n.key}: the dual write is not on; the Dual write phase starts it, and the backfill fills only rows written before it`);
  if (!Number.isInteger(run.batchSize) || run.batchSize < 1) throw new MigrationRefusal(`${n.key}: batchSize must be a positive integer, got ${run.batchSize}`);

  const identity = identityOf(run.marker);
  const receipts = deps.receipts ?? postgresReceiptStore(run.client, n.schema, identity, run.runId ? { runId: run.runId } : {});
  await receipts.ensure();
  const recorded = await receipts.readAll(batchPrefix(identity, n.key));

  const size = String(run.batchSize);
  const key = col(o.batchKey);
  const batches = (
    await run.client.query<{ b: string }>(`SELECT pg_catalog.floor(${key}::numeric / ${size})::bigint::text AS b FROM ${n.qualifiedTable} GROUP BY 1 ORDER BY 1`)
  ).map((r) => r.b);
  result.batches = batches.length;
  const wait = deps.waitForReplicas ?? waitForReplicas;
  const target = `${col(n.newColumn)}`;

  for (const b of batches) {
    run.signal?.throwIfAborted();
    const effect = batchEffect(n.key, b);
    const expectation = batchExpectation(o, b, run.batchSize);
    if (recorded.get(receiptAddress(identity, effect)) === expectation) {
      result.skipped++;
      continue;
    }
    if (run.replicationLag) result.pausedMs += await wait(run.client, run.replicationLag, { log: run.log, ...(run.signal ? { signal: run.signal } : {}) });
    const lo = (BigInt(b) * BigInt(run.batchSize)).toString();
    const hi = ((BigInt(b) + 1n) * BigInt(run.batchSize)).toString();
    const updated = await inTransaction(run, async (exec) => {
      const [row] = await exec(
        `WITH u AS (UPDATE ${n.qualifiedTable} SET ${target} = (${o.expression}) WHERE ${key} >= $1 AND ${key} < $2 AND ${target} IS DISTINCT FROM (${o.expression}) RETURNING 1) ` +
          "SELECT count(*)::int AS n FROM u",
        [lo, hi],
      );
      // The receipt, last, in the batch's own transaction.
      await receipts.write({ name: effect, effect, flavor: "hash", inputs: {} }, expectation);
      await deps.beforeCommit?.(b);
      return Number(row?.n ?? 0);
    });
    result.rows += updated;
    result.filled++;
    await deps.afterBatch?.(b);
  }
  run.log(`-- backfill of ${n.key}: ${result.batches} batch(es), ${result.filled} filled (${result.rows} row(s)), ${result.skipped} already filled`);
  return result;
}

// ── verify ─────────────────────────────────────────────────────────────

export interface VerifyResult {
  state: MigrationObservation["state"];
  /** The digest the switch gate binds: the plan and the verified new column. Absent once the switch has run. */
  planDigest?: string;
  rows: number;
  /** Rows whose new column differs from the expression over the old one. */
  mismatched: number;
  /** Rows whose new column is NULL. */
  nulls: number;
  /** The sum of a 64-bit hash of every new value, and of every value the expression gives. */
  checksum: string;
  expected: string;
  /** One line for the run record and the gate. */
  summary: string;
}

/** A verification that found the columns different. */
export class MigrationVerificationError extends Error {
  constructor(
    readonly key: string,
    readonly result: Omit<VerifyResult, "summary" | "planDigest">,
    reason: string,
  ) {
    super(`${key}: ${reason}. Nothing was switched; onFailure drops what the expand added, and the next run starts again.`);
    this.name = "MigrationVerificationError";
  }
}

export async function verifyMigration(run: MigrationRun): Promise<VerifyResult> {
  const o = await observe(run);
  const empty = { rows: 0, mismatched: 0, nulls: 0, checksum: "0", expected: "0" };
  if (o.state !== "migrate") return { state: o.state, ...empty, summary: `nothing to verify: ${o.state}` };
  const n = o.names;
  if (!o.newColumn || !o.trigger) throw new MigrationRefusal(`${n.key}: the new column and its dual write are not there; the Expand and Dual write phases make them`);
  const nw = col(n.newColumn);
  const [row] = await inTransaction(
    run,
    (exec) =>
      exec(
        `SELECT count(*)::text AS rows, count(*) FILTER (WHERE ${nw} IS DISTINCT FROM (${o.expression}))::text AS mismatched,
                count(*) FILTER (WHERE ${nw} IS NULL)::text AS nulls,
                COALESCE(sum(pg_catalog.hashtextextended(${nw}::text, 0)), 0)::text AS checksum,
                COALESCE(sum(pg_catalog.hashtextextended((${o.expression})::text, 0)), 0)::text AS expected
         FROM ${n.qualifiedTable}`,
      ),
    { scan: true },
  );
  const r = { rows: Number(row?.rows ?? 0), mismatched: Number(row?.mismatched ?? 0), nulls: Number(row?.nulls ?? 0), checksum: String(row?.checksum ?? "0"), expected: String(row?.expected ?? "0") };
  if (r.mismatched > 0 || r.checksum !== r.expected) {
    throw new MigrationVerificationError(n.key, { state: o.state, ...r }, `${r.mismatched} of ${r.rows} row(s) have ${n.newColumn} different from ${o.expression} (checksums ${r.checksum} and ${r.expected})`);
  }
  if (requiresNotNull(o.column, o.carried) && r.nulls > 0) {
    throw new MigrationVerificationError(n.key, { state: o.state, ...r }, `${r.nulls} of ${r.rows} row(s) have ${n.newColumn} NULL, and ${n.column} is declared NOT NULL or is in the primary key`);
  }
  const notReady = carriedNotReady(o.carried, o.carriedStates);
  if (notReady.length > 0) {
    throw new MigrationRefusal(`${n.key}: ${notReady.map((c) => `${c.kind} ${c.working}`).join(", ")} on the new column is not there or not yet valid; the Carry over phase makes them`);
  }
  const carried =
    o.carried.length > 0 || o.views.length > 0
      ? `; ${o.carried.map((c) => `${c.kind} ${c.name}${c.target !== c.name ? ` (as ${c.target})` : ""}`).join(", ") || "no index or constraint"} carried over${o.views.length > 0 ? `, view(s) ${o.views.map((v) => v.name).join(", ")} made again at the switch` : ""}`
      : "";
  const summary = `${n.key}: ${r.rows} row(s), ${n.newColumn} equal to ${o.expression} in every one (checksum ${r.checksum})${carried}`;
  run.log(`-- ${summary}`);
  return {
    state: o.state,
    planDigest: computePlanDigest("postgres-migration", { plan: migrationPlanSubject(o), table: o.oid, column: o.newColumn.attnum, verified: { mismatched: 0 } }),
    ...r,
    summary,
  };
}
