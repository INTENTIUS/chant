/**
 * Partitions, as the backfill copies them and the verification counts them.
 *
 * The unit of work is a partition of the old table. Its rows can land in
 * other partitions of the new table when the rebuild changes the partition
 * key, so "the rows of old partition p" is found on the new table by
 * computing the old partition key over the new table's columns:
 * `partitionID(<old key>)`, which the server computes the same way it named
 * the old partition (`_partition_id`). When the key is unchanged that is the
 * new table's own `_partition_id`; when the old table has no partition key
 * every row is in partition `all`.
 */

import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "../live/bind";
import { ident, sqlString } from "../apply/statements";
import type { CopiedColumn, RebuildNames } from "./observe";
import type { Sharding } from "./shards";

/** The old table's active partitions, by id. */
export async function sourcePartitions(target: ClickHouseTarget, names: RebuildNames): Promise<string[]> {
  const rows = await clickhouseQuery<{ partition_id: string }>(
    target.endpoint,
    `SELECT partition_id FROM system.parts WHERE database = ${sqlString(names.database)} AND table = ${sqlString(names.name)} AND active ` +
      `GROUP BY partition_id ORDER BY partition_id`,
  );
  return rows.map((r) => r.partition_id);
}

/** The old table's active partitions on each shard of a cluster (#3663), through this server. */
export async function shardPartitions(run: { target: ClickHouseTarget }, sharding: Sharding, database: string, table: string): Promise<Array<{ shard: number; partition: string }>> {
  const rows = await clickhouseQuery<{ shard: number | string; partition_id: string }>(
    run.target.endpoint,
    `SELECT _shard_num AS shard, partition_id FROM cluster(${sqlString(sharding.cluster)}, system.parts) ` +
      `WHERE database = ${sqlString(database)} AND table = ${sqlString(table)} AND active GROUP BY shard, partition_id ORDER BY shard, partition_id`,
  );
  return rows.map((r) => ({ shard: Number(r.shard), partition: r.partition_id }));
}

/** Rename the columns an expression names, old name to new, leaving function names and qualified names alone. */
export function renameColumns(expr: string, copied: readonly CopiedColumn[]): string {
  let out = expr;
  for (const c of copied) {
    if (c.source === c.name) continue;
    const re = new RegExp(`(?<![\\w.\`])\`?${c.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`?(?![\\w\`(])`, "g");
    out = out.replace(re, ident(c.name));
  }
  return out;
}

/** A tuple key's elements as arguments (`(a, b)` is `a, b`); any other key as itself. */
function asArguments(key: string): string {
  const k = key.trim();
  if (!k.startsWith("(") || !k.endsWith(")")) return k;
  let depth = 0;
  for (let i = 0; i < k.length; i++) {
    if (k[i] === "(") depth++;
    else if (k[i] === ")") depth--;
    if (depth === 0 && i < k.length - 1) return k; // `(a) + (b)`: not one outer pair
  }
  return k.slice(1, -1);
}

/**
 * The expression that gives, for a row of the new table, the id of the old
 * table's partition the row came from.
 */
export function sourcePartitionExpression(oldKey: string, newKey: string, copied: readonly CopiedColumn[]): string {
  if (oldKey.trim() === "") return "'all'";
  const renamed = renameColumns(oldKey, copied);
  if (renamed === oldKey && oldKey.trim() === newKey.trim()) return "_partition_id";
  return `partitionID(${asArguments(renamed)})`;
}
