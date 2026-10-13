import { ShardedTable } from "@intentius/chant-lexicon-sql/clickhouse";

// Page hits on the `web` cluster: one replicated local table per shard, and
// a Distributed table that writes to a shard by user and reads from all.
export const hits = ShardedTable({
  name: "hits",
  cluster: "web",
  columns: "user_id UInt64, url String, referrer String, ts DateTime",
  orderBy: "(user_id, ts)",
  shardingKey: "cityHash64(user_id)",
  partitionBy: "toYYYYMM(ts)",
});
