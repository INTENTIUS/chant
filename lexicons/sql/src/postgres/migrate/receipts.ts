/**
 * Effect receipts kept in Postgres (#3281): where the expand-and-contract
 * migration's backfill records which batches it has filled.
 *
 * A receipt is the proof that one effect ran, kept where the effect happened
 * (concepts/effect-receipts.mdx). A batch's effect is "these rows of the
 * table have the new column filled", so the receipt is a row in the same
 * database, in the table's own schema:
 *
 *     SELECT * FROM app.__chant_receipts
 *
 * In the table's schema rather than a `chant_receipts` schema, as #3265 put
 * the ClickHouse receipts of a Replicated database beside the tables they
 * witness: whoever can read the table can read its receipts, and a
 * provider that reserves schemas or limits `CREATE SCHEMA` (#3282) does not
 * stop the migration. The table's comment carries chant's trailer with the
 * `receipts` key, so the catalog read leaves it out of plans, import and
 * prune.
 *
 * Postgres adds what ClickHouse could not: the receipt is written in the
 * batch's own transaction, after its `UPDATE`, and commits with it. The
 * receipt is still written last and on success only, and a run killed
 * anywhere leaves either the batch and its receipt or neither, so a resumed
 * backfill never updates a batch twice. Each expectation is bound to the
 * table's oid and the new column's attribute number, which a column dropped
 * by onFailure and added again does not keep, so an old receipt reads as
 * stale; onFailure and the contract also delete the migration's receipts.
 *
 * The store implements the shared core's `SqlReceiptStore`
 * (`../../core/receipts.ts`) over the migration's own connection, which the
 * backfill reaches directly. A sql project's `effect()` receipts use the same
 * store over `chant_receipts.receipts` (`../../receipts.ts`).
 */

import { OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import type { EffectReceiptRef } from "@intentius/chant/op/receipt-store";
import { COMMENT_OWNERSHIP_KEYS, hasChantTrailerKey, RECEIPTS_TRAILER_KEY } from "../../core/ownership";
import { receiptAddress, type SqlReceiptStore } from "../../core/receipts";
import { quoteIdent } from "../keywords";
import type { PostgresClient } from "../live/client";

/** The receipts table, in the migrated table's schema. */
export const POSTGRES_RECEIPTS_TABLE = "__chant_receipts";

const COMMENT = `chant effect receipts [chant ${COMMENT_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE} ${RECEIPTS_TRAILER_KEY}=effects]`;

export { receiptAddress } from "../../core/receipts";

/** A receipts table chant did not make: a user's table under the same name. */
export class ReceiptsTableConflict extends Error {
  constructor(schema: string, table: string = POSTGRES_RECEIPTS_TABLE) {
    super(
      `${schema}.${table} exists and is not chant's receipts table (its comment carries no receipts marker). ` +
        `chant keeps its receipts under that name, so it stops rather than write into it; rename the table.`,
    );
    this.name = "ReceiptsTableConflict";
  }
}

export interface PostgresReceiptStore extends SqlReceiptStore {
  /** The qualified, quoted table name. */
  table: string;
  /** Create the table if it is not there. Outside any transaction the store's caller has open. */
  ensure(): Promise<void>;
  /** Delete every receipt whose address starts with `prefix`, and the table once it holds none. */
  forget(prefix: string): Promise<number>;
}

/**
 * A receipt store in `<schema>.__chant_receipts`, over `client`. `write` runs
 * on the client as it is, so a write inside the caller's transaction commits
 * or rolls back with it. `identity` is the project's ownership stack and env,
 * which every address starts with. `table` names the table in `schema`,
 * `__chant_receipts` by default (`../../receipts.ts` keeps `effect()`
 * receipts in `chant_receipts.receipts`).
 */
export function postgresReceiptStore(
  client: PostgresClient,
  schema: string,
  identity: { stack?: string; env?: string },
  opts: { runId?: string; table?: string } = {},
): PostgresReceiptStore {
  const name = opts.table ?? POSTGRES_RECEIPTS_TABLE;
  const table = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  let ensured = false;
  const comment = async (): Promise<string | null | undefined> => {
    const [row] = await client.query<{ present: boolean; comment: string | null }>(
      "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present, pg_catalog.obj_description(pg_catalog.to_regclass($1), 'pg_class') AS comment",
      [table],
    );
    return row?.present ? (row.comment ?? null) : undefined;
  };
  /** Whether there is a table to read; one that is not chant's is refused. */
  const readable = async (): Promise<boolean> => {
    if (ensured) return true;
    const c = await comment();
    if (c === undefined) return false;
    if (!hasChantTrailerKey(c ?? undefined, [RECEIPTS_TRAILER_KEY])) throw new ReceiptsTableConflict(schema, name);
    return true;
  };
  const address = (receipt: EffectReceiptRef) => receiptAddress(identity, receipt.effect);

  return {
    table,
    async ensure() {
      if (ensured) return;
      if (!(await readable())) {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${table} (address text PRIMARY KEY, effect text NOT NULL, expectation text NOT NULL, run_id text NOT NULL DEFAULT '', written_at timestamptz NOT NULL DEFAULT pg_catalog.now())`,
        );
        await client.query(`COMMENT ON TABLE ${table} IS '${COMMENT.replace(/'/g, "''")}'`);
      }
      ensured = true;
    },
    async read(receipt) {
      if (!(await readable())) return undefined;
      const [row] = await client.query<{ expectation: string }>(`SELECT expectation FROM ${table} WHERE address = $1`, [address(receipt)]);
      return row?.expectation;
    },
    async readAll(prefix) {
      if (!(await readable())) return new Map();
      const rows = await client.query<{ address: string; expectation: string }>(`SELECT address, expectation FROM ${table} WHERE starts_with(address, $1)`, [prefix]);
      return new Map(rows.map((r) => [r.address, r.expectation]));
    },
    async write(receipt, expectation) {
      await client.query(
        `INSERT INTO ${table} (address, effect, expectation, run_id) VALUES ($1, $2, $3, $4) ` +
          "ON CONFLICT (address) DO UPDATE SET effect = EXCLUDED.effect, expectation = EXCLUDED.expectation, run_id = EXCLUDED.run_id, written_at = pg_catalog.now()",
        [address(receipt), receipt.effect, expectation, opts.runId ?? ""],
      );
    },
    async forget(prefix) {
      if (!(await readable())) return 0;
      const deleted = await client.query<{ address: string }>(`DELETE FROM ${table} WHERE starts_with(address, $1) RETURNING address`, [prefix]);
      const [left] = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      if (left?.n === 0) {
        await client.query(`DROP TABLE IF EXISTS ${table}`);
        ensured = false;
      }
      return deleted.length;
    },
  };
}
