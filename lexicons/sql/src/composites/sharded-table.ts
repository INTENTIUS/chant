/**
 * `ShardedTable`: a ReplicatedMergeTree table on every node of a cluster and the Distributed table that spreads reads and writes across it.
 *
 * Both tables are created `ON CLUSTER`. The local table, `<name>_local`, holds
 * each shard's rows and replicates them within the shard; with no engine
 * arguments it takes the server's default replication path. The Distributed
 * table, `<name>`, holds no data: an insert goes to one shard by the sharding
 * key, and a query runs on every shard and merges the results.
 *
 * The Distributed table reads the local one by reference, so the build creates
 * the local table first. Give `name` without a database: the Distributed
 * engine names its table in the current database.
 */

import { Composite } from "@intentius/chant/composite";
import { table, type ClickHouseTable } from "../clickhouse/entities";
import type { ClickHouseMemberName } from "../core/typed";
import type { Instance, TypedComposite } from "./typed";

export interface ShardedTableProps {
  /** The Distributed table's name, unqualified. The local table is `<name>_local`. */
  name: string;
  /** The cluster both tables are created on, as the server's `remote_servers` names it. */
  cluster: string;
  /** The columns, as SQL. Both tables declare the same list. */
  columns: string;
  /** The local table's sort key. */
  orderBy: string;
  /** The expression that picks a shard for an inserted row (default `rand()`). */
  shardingKey?: string;
  /** The local table's partition key. Left out by default. */
  partitionBy?: string;
}

/** `Local` and `Distributed` are the two tables' names, when the call's props give them (chant#3787). */
export type ShardedTableMembers<Local extends string = string, Distributed extends string = string> = {
  local: ClickHouseTable<Local>;
  distributed: ClickHouseTable<Distributed>;
};

type ShardedTableCall = <const N extends string>(props: ShardedTableProps & { name: N }) => Instance<ShardedTableMembers<ClickHouseMemberName<N, "_local">, ClickHouseMemberName<N>>>;

/** A ReplicatedMergeTree table on every node of a cluster and the Distributed table over it. */
export const ShardedTable = Composite<ShardedTableProps, ShardedTableMembers, TypedComposite<ShardedTableProps, ShardedTableMembers, ShardedTableCall>>((props) => {
  const local = table`
    CREATE TABLE ${`${props.name}_local`} ON CLUSTER ${props.cluster} (${props.columns})
    ENGINE = ReplicatedMergeTree
    ${props.partitionBy ? `PARTITION BY ${props.partitionBy}` : ""}
    ORDER BY ${props.orderBy}`;
  const distributed = table`
    CREATE TABLE ${props.name} ON CLUSTER ${props.cluster} (${props.columns})
    ENGINE = Distributed(${props.cluster}, currentDatabase(), ${local}, ${props.shardingKey ?? "rand()"})`;
  return { local, distributed };
}, "ShardedTable");
