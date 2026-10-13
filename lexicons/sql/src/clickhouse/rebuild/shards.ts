/**
 * A rebuild across the shards of a cluster (#3663).
 *
 * On a `cluster:<name>` topology the rebuild's DDL runs `ON CLUSTER`, so
 * every server gets the new table, the dual-write view and the swap. The
 * rows do not move that way: each shard holds its own, and a copy run on
 * the profile's server alone copies that server's shard and no other. So
 * with more than one shard, the backfill and the verification work shard by
 * shard, all through the profile's server:
 *
 * - a shard's rows are read with `cluster('<name>', db, t)` and
 *   `_shard_num = <n>`, one replica per shard, as the cluster's own
 *   configuration reaches it;
 * - they are written back to the same shard with
 *   `INSERT INTO FUNCTION cluster('<name>', db, t__chant_new, <slot>)`, a
 *   constant sharding key that lands on that shard, inserted in the
 *   foreground so the statement returns once the shard has the rows;
 * - a shard's half-copied rows are deleted with an `ALTER ... ON CLUSTER`
 *   whose condition holds on that shard's servers only
 *   (`getMacro('shard')`, the macro the cluster's Keeper paths already use).
 *
 * Each (shard, partition) is one copy with its own receipt, so a rerun after
 * a failure on one shard skips what every shard already copied.
 *
 * With one shard nothing changes: the replicas of a shard replicate what is
 * written on any of them, which is what the rebuild has always relied on.
 */

import { clickhouseQuery } from "../http";
import type { ClickHouseTarget } from "../live/bind";
import { ident, sqlString } from "../apply/statements";
import { RebuildRefusal } from "./observe";

export interface Shard {
  /** `_shard_num` / `system.clusters.shard_num`, from 1. */
  num: number;
  /** The shard's `{shard}` macro, the same on each of its replicas. */
  macro: string;
  /** The sharding key that lands on this shard: the sum of the weights of the shards before it. */
  slot: number;
}

export interface Sharding {
  cluster: string;
  shards: Shard[];
}

/** Settings for a copy into one shard: in the foreground, and read from the cluster rather than pushed down to each shard. */
export const SHARD_INSERT_SETTINGS: Record<string, string> = { distributed_foreground_insert: "1", parallel_distributed_insert_select: "0" };

/** Settings for a delete on one shard: its condition is the server's own macro, the same on every replica of the shard. */
export const SHARD_DELETE_SETTINGS: Record<string, string> = { allow_nondeterministic_mutations: "1", mutations_sync: "2" };

/**
 * The shards of the target's cluster, when its topology is `cluster:<name>`
 * and the cluster has more than one. Undefined otherwise: the rebuild works
 * on the profile's server as it always has.
 */
export async function clusterSharding(target: ClickHouseTarget): Promise<Sharding | undefined> {
  if (target.topology?.kind !== "cluster") return undefined;
  let cluster = target.topology.cluster;
  const macro = /^\{(\w+)\}$/.exec(cluster);
  if (macro) {
    const [row] = await clickhouseQuery<{ c: string }>(target.endpoint, `SELECT getMacro(${sqlString(macro[1]!)}) AS c`);
    cluster = row?.c ?? cluster;
  }
  const weights = await clickhouseQuery<{ shard: number | string; weight: number | string }>(
    target.endpoint,
    `SELECT shard_num AS shard, any(shard_weight) AS weight FROM system.clusters WHERE cluster = ${sqlString(cluster)} GROUP BY shard_num ORDER BY shard_num`,
  );
  if (weights.length <= 1) return undefined;
  const macros = new Map(
    (await clickhouseQuery<{ shard: number | string; macro: string }>(target.endpoint, `SELECT _shard_num AS shard, getMacro('shard') AS macro FROM cluster(${sqlString(cluster)}, system.one)`)).map(
      (r) => [Number(r.shard), r.macro],
    ),
  );
  let slot = 0;
  const shards: Shard[] = [];
  for (const w of weights) {
    const num = Number(w.shard);
    const m = macros.get(num);
    if (m === undefined) throw new RebuildRefusal(`cluster ${cluster}: shard ${num} has no {shard} macro, which a rebuild across shards needs to delete a half-copied partition on that shard alone`);
    shards.push({ num, macro: m, slot });
    slot += Number(w.weight) || 1;
  }
  const distinct = new Set(shards.map((s) => s.macro));
  if (distinct.size !== shards.length) {
    throw new RebuildRefusal(`cluster ${cluster}: two shards share a {shard} macro (${shards.map((s) => `${s.num}=${s.macro}`).join(", ")}); each shard needs its own`);
  }
  return { cluster, shards };
}

/** One shard's rows of `database.table`, as a table expression; filter with {@link onShard}. */
export const shardTable = (sharding: Sharding, database: string, table: string): string => `cluster(${sqlString(sharding.cluster)}, ${ident(database)}, ${ident(table)})`;

/** The condition that keeps one shard's rows of a {@link shardTable}. */
export const onShard = (shard: Shard): string => `_shard_num = ${shard.num}`;

/** Where a copy into one shard of `database.table` writes. */
export const intoShard = (sharding: Sharding, shard: Shard, database: string, table: string): string =>
  `FUNCTION cluster(${sqlString(sharding.cluster)}, ${ident(database)}, ${ident(table)}, ${shard.slot})`;

/** The condition, in an `ALTER ... ON CLUSTER` mutation, that holds on that shard's servers only. */
export const onShardServers = (shard: Shard): string => `getMacro('shard') = ${sqlString(shard.macro)}`;
