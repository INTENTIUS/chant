/**
 * How the backfill cuts a table into batches (#3281, #3322). A batch must be
 * the same rows on every run, or a receipt written for it by one run would
 * vouch for different rows in the next.
 *
 * - A primary key of one smallint, integer or bigint column: ranges of its
 *   value, `[b * size, (b + 1) * size)`. Arithmetic, so nothing needs to be
 *   remembered, and a batch is the same range however many rows were
 *   written since.
 * - Any other primary key (uuid, text, a timestamp, several columns):
 *   ranges between recorded boundaries in the key's order. The first run
 *   walks the key's index once, taking every `size`-th key as a boundary
 *   (`WHERE key >= boundary ORDER BY key OFFSET size LIMIT 1`, so the walk
 *   reads each key once and sorts nothing), and records the boundaries in
 *   the receipt store, beside the batches' receipts, before any batch runs.
 *   Every later run reads them back instead of walking again, so batch `i`
 *   is `boundary[i] <= key < boundary[i + 1]` in every run. The first batch
 *   has no lower bound and the last no upper one, so a row written since,
 *   anywhere in the key's order, falls in exactly one batch (and the dual
 *   write has already filled it). Each batch is a range scan of the primary
 *   key's index, with a row comparison (`(a, b) >= ($1, $2)`) in the index's
 *   own column order.
 *
 * Hash buckets (`hash(key) % n`) were the other option: they need nothing
 * recorded but the bucket count, but no index can serve them, so every batch
 * would read the whole table. Ranges recorded once read each row once.
 *
 * The record is bound to the table's oid and the new column's attribute
 * number, like the batches' receipts: a migration started again after
 * onFailure (which drops the new column and the receipts) walks the key
 * again. A record left from another batch size is kept, since its batches'
 * receipts are what the run resumes from.
 */

import { col } from "./names";
import type { PostgresClient } from "../live/client";
import type { PostgresReceiptStore } from "./receipts";

/** One primary-key column, in the key's order. */
export interface KeyColumn {
  name: string;
  /** As `format_type` prints it: what a boundary's text is cast back to. */
  type: string;
}

/** One batch: its id (the receipt's address suffix), its rows as a condition with parameters from `$1`, and what its receipt binds. */
export interface Batch {
  id: string;
  where: string;
  params: string[];
  inputs: Record<string, unknown>;
}

export const INTEGER_KEY_TYPES: ReadonlySet<string> = new Set(["smallint", "integer", "bigint"]);

/** Whether the key is batched by arithmetic ranges of its one integer column. */
export const isIntegerKey = (keys: readonly KeyColumn[]): boolean => keys.length === 1 && INTEGER_KEY_TYPES.has(keys[0]!.type);

/** `id`, or `(tenant_id, id)`. */
export const keyText = (keys: readonly KeyColumn[]): string => (keys.length === 1 ? keys[0]!.name : `(${keys.map((k) => k.name).join(", ")})`);

const tuple = (keys: readonly KeyColumn[]): string => (keys.length === 1 ? col(keys[0]!.name) : `(${keys.map((k) => col(k.name)).join(", ")})`);
const placeholders = (keys: readonly KeyColumn[], from: number): string => {
  const p = keys.map((k, i) => `$${from + i}::${k.type}`);
  return keys.length === 1 ? p[0]! : `(${p.join(", ")})`;
};

/** The batches of an integer key: one per range that holds rows. */
export async function integerBatches(client: PostgresClient, table: string, key: KeyColumn, size: number): Promise<Batch[]> {
  const k = col(key.name);
  const rows = await client.query<{ b: string }>(`SELECT pg_catalog.floor(${k}::numeric / ${size})::bigint::text AS b FROM ${table} GROUP BY 1 ORDER BY 1`);
  return rows.map(({ b }) => {
    const lo = (BigInt(b) * BigInt(size)).toString();
    const hi = ((BigInt(b) + 1n) * BigInt(size)).toString();
    return { id: b, where: `${k} >= $1 AND ${k} < $2`, params: [lo, hi], inputs: { batch: b, size, key: key.name } };
  });
}

/** The batches between recorded boundaries: `[undefined, b1)`, `[b1, b2)`, ..., `[bn, undefined)`, where `b0` is only where the walk started. */
export function boundaryBatches(keys: readonly KeyColumn[], bounds: readonly string[][]): Batch[] {
  const k = tuple(keys);
  return bounds.map((lo, i) => {
    const hi = bounds[i + 1];
    const where: string[] = [];
    const params: string[] = [];
    if (i > 0) {
      where.push(`${k} >= ${placeholders(keys, 1)}`);
      params.push(...lo);
    }
    if (hi) {
      where.push(`${k} < ${placeholders(keys, params.length + 1)}`);
      params.push(...hi);
    }
    return {
      id: `k${i}`,
      where: where.join(" AND ") || "true",
      params,
      inputs: { batch: `k${i}`, key: keys.map((c) => c.name), lo: i > 0 ? lo : null, hi: hi ?? null },
    };
  });
}

/** Walk the key's order and take every `size`-th key: the boundaries the batches lie between. */
export async function walkBoundaries(client: PostgresClient, table: string, keys: readonly KeyColumn[], size: number, signal?: AbortSignal): Promise<string[][]> {
  const select = keys.map((k, i) => `${col(k.name)}::text AS k${i}`).join(", ");
  const order = keys.map((k) => col(k.name)).join(", ");
  const values = (row: Record<string, unknown> | undefined): string[] | undefined => (row ? keys.map((_, i) => String(row[`k${i}`])) : undefined);
  const bounds: string[][] = [];
  let at = values((await client.query(`SELECT ${select} FROM ${table} ORDER BY ${order} LIMIT 1`))[0]);
  while (at) {
    signal?.throwIfAborted();
    bounds.push(at);
    at = values((await client.query(`SELECT ${select} FROM ${table} WHERE ${tuple(keys)} >= ${placeholders(keys, 1)} ORDER BY ${order} OFFSET ${size} LIMIT 1`, at))[0]);
  }
  return bounds;
}

/** The batching a run recorded, as kept in the receipt store. */
export interface BatchRecord {
  v: 1;
  /** The table's oid and the new column's attribute number, which the record is for. */
  table: string;
  column: number;
  keys: string[];
  size: number;
  bounds: string[][];
}

/**
 * The boundary batches of a key that is not one integer column: read from
 * the record in the receipt store, or walked and recorded when there is
 * none for this table and new column.
 */
export async function recordedBatches(
  client: PostgresClient,
  input: { table: string; oid: string; attnum: number; keys: readonly KeyColumn[]; size: number; effect: string; receipts: PostgresReceiptStore; log: (line: string) => void; signal?: AbortSignal },
): Promise<{ batches: Batch[]; record: BatchRecord; walked: boolean }> {
  const ref = { name: input.effect, effect: input.effect, flavor: "hash" as const, inputs: {} };
  const keys = input.keys.map((k) => k.name);
  const raw = await input.receipts.read(ref);
  let record: BatchRecord | undefined;
  try {
    const parsed = raw === undefined ? undefined : (JSON.parse(raw) as BatchRecord);
    if (parsed?.v === 1 && parsed.table === input.oid && parsed.column === input.attnum && JSON.stringify(parsed.keys) === JSON.stringify(keys)) record = parsed;
  } catch {
    record = undefined;
  }
  let walked = false;
  if (!record) {
    const bounds = await walkBoundaries(client, input.table, input.keys, input.size, input.signal);
    record = { v: 1, table: input.oid, column: input.attnum, keys, size: input.size, bounds };
    await input.receipts.write(ref, JSON.stringify(record));
    walked = true;
    input.log(`-- batches of ${keyText(input.keys)}: ${bounds.length} boundary(ies) every ${input.size} key(s), recorded`);
  } else if (record.size !== input.size) {
    input.log(`-- batches of ${keyText(input.keys)}: kept as recorded every ${record.size} key(s); batchSize ${input.size} applies to a migration started again`);
  }
  return { batches: boundaryBatches(input.keys, record.bounds), record, walked };
}
