/**
 * Effect receipts kept in ClickHouse (#3198): where the rebuild migration's
 * backfill records which partitions it has copied.
 *
 * A receipt is the proof that one effect ran, kept where the effect happened
 * (concepts/effect-receipts.mdx). The backfill's effect is "this partition of
 * the old table is in the new table", and both tables are on the server, so
 * the receipt is a row on the same server:
 *
 *     SELECT * FROM chant_receipts.receipts
 *
 * Why not git (core's lifecycle receipt store, `chant/lifecycle`): the
 * receipt has to die with the data it witnesses. The rebuild's `onFailure`
 * drops the new table; a receipt kept in git would go on saying partitions
 * were copied into a table that no longer exists, and a resumed backfill
 * would skip them. Here every receipt's expectation is bound to the new
 * table's UUID, so a new table made again reads every old receipt as stale,
 * and the receipts are read and written over the connection the copy already
 * uses, with no commit and push per partition. Readable with nothing but a
 * ClickHouse client, which is the walk-away property the other rows have.
 *
 * The store implements core's `ReceiptStore` seam
 * (`@intentius/chant/op/receipt-store`). It is not exported as the
 * `receiptRead` / `receiptWrite` activities: those names are global to a
 * run, and a project that also configures aws or k8s would have its
 * `effect()` steps read ClickHouse instead of SSM or a ConfigMap. The backfill
 * activity reaches the store directly, the way the fly lexicon's release
 * component reaches its own.
 *
 * Write discipline: the backfill writes a partition's receipt after the
 * partition's copy succeeded, last, and nothing else writes one.
 */

import { OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import type { EffectReceiptRef, ReceiptStore } from "@intentius/chant/op/receipt-store";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { ident, sqlString } from "../apply/statements";
import { CLICKHOUSE_COMMENT_OWNERSHIP_KEYS, RECEIPTS_TRAILER_KEY } from "../ownership";

/** The database the receipts live in. Its comment marks it as chant's, so schema reads leave it out. */
export const RECEIPTS_DATABASE = "chant_receipts";
/** The table, one row per receipt write. */
export const RECEIPTS_TABLE = "receipts";

const COMMENT = `chant effect receipts [chant ${CLICKHOUSE_COMMENT_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE} ${RECEIPTS_TRAILER_KEY}=effects]`;
const TABLE = `${ident(RECEIPTS_DATABASE)}.${ident(RECEIPTS_TABLE)}`;
/** Plain synchronous inserts: an async insert can be acknowledged before it is written. */
const SYNC = { async_insert: "0" };

/** The receipt's address: `<stack>/<env>/<effect>`, the same fields an ownership marker carries. */
export function receiptAddress(identity: { stack?: string; env?: string }, effect: string): string {
  return `${identity.stack || "-"}/${identity.env || "-"}/${effect}`;
}

export interface ClickHouseReceiptStore extends ReceiptStore {
  /** Every receipt whose address starts with `prefix`, latest value each: one query for a whole backfill. */
  readAll(prefix: string): Promise<Map<string, string>>;
}

/**
 * A receipt store on the server at `endpoint`. Creates the receipts database
 * and table on first write if they are not there. `identity` is the
 * project's ownership stack and env, which every address starts with.
 */
export function clickhouseReceiptStore(endpoint: ClickHouseEndpoint, identity: { stack?: string; env?: string }, opts: { runId?: string } = {}): ClickHouseReceiptStore {
  let ensured = false;
  const ensure = async () => {
    if (ensured) return;
    await clickhouseQuery(endpoint, `CREATE DATABASE IF NOT EXISTS ${ident(RECEIPTS_DATABASE)} COMMENT ${sqlString(COMMENT)}`);
    await clickhouseQuery(
      endpoint,
      `CREATE TABLE IF NOT EXISTS ${TABLE} (address String, effect String, expectation String, run_id String, written_at DateTime64(3) DEFAULT now64(3)) ` +
        `ENGINE = ReplacingMergeTree(written_at) ORDER BY address COMMENT ${sqlString(COMMENT)}`,
    );
    ensured = true;
  };
  const exists = async () => {
    const rows = await clickhouseQuery<{ n: number | string }>(
      endpoint,
      `SELECT count() AS n FROM system.tables WHERE database = ${sqlString(RECEIPTS_DATABASE)} AND name = ${sqlString(RECEIPTS_TABLE)}`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  };
  const address = (receipt: EffectReceiptRef) => receiptAddress(identity, receipt.effect);

  return {
    async read(receipt) {
      if (!ensured && !(await exists())) return undefined;
      const rows = await clickhouseQuery<{ expectation: string }>(
        endpoint,
        `SELECT expectation FROM ${TABLE} WHERE address = ${sqlString(address(receipt))} ORDER BY written_at DESC LIMIT 1`,
      );
      return rows[0]?.expectation;
    },
    async readAll(prefix) {
      if (!ensured && !(await exists())) return new Map();
      const rows = await clickhouseQuery<{ address: string; expectation: string }>(
        endpoint,
        `SELECT address, argMax(expectation, written_at) AS expectation FROM ${TABLE} WHERE startsWith(address, ${sqlString(prefix)}) GROUP BY address`,
      );
      return new Map(rows.map((r) => [r.address, r.expectation]));
    },
    async write(receipt, expectation) {
      await ensure();
      await clickhouseQuery(
        endpoint,
        `INSERT INTO ${TABLE} (address, effect, expectation, run_id) VALUES (${sqlString(address(receipt))}, ${sqlString(receipt.effect)}, ${sqlString(expectation)}, ${sqlString(opts.runId ?? "")})`,
        { settings: SYNC },
      );
    },
  };
}
