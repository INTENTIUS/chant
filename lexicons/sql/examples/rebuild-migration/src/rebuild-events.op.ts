import { ClickHouseRebuildOp } from "@intentius/chant-lexicon-sql/clickhouse";

// Rebuilds shop.events into the declaration's new sort key: a new table, a
// materialized view carrying writes from the cut-over, a backfill per month
// with receipts, verification, a gated swap, and the old table kept 7 days.
// `chant run rebuild-shop-events` goes as far as the next gate each time.
export const { op } = ClickHouseRebuildOp({
  name: "rebuild-shop-events",
  env: "prod",
  table: "shop.events",
  dualWrite: { mode: "materialized-view", cutoverColumn: "ts" },
  retain: "7d",
});
