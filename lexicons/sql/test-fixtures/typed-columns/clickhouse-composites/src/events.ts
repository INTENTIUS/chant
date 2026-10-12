import { CdcMirror, EventsTable, RollupView, ShardedTable } from "@intentius/chant-lexicon-sql/clickhouse";

export const events = EventsTable({
  name: "analytics.events",
  columns: "user_id UUID, kind LowCardinality(String)",
  orderBy: "(kind, ts)",
});

export const daily = RollupView({
  name: "analytics.daily",
  source: events.table,
  columns: "day Date, kind LowCardinality(String), n UInt64",
  select: "toDate(ts) AS day, kind, count() AS n",
  groupBy: "day, kind",
});

export const accounts = CdcMirror({ name: "analytics.accounts", columns: "id UInt64, email String", primaryKey: "id" });

export const clicks = ShardedTable({ name: "analytics.clicks", cluster: "main", columns: "id UInt64, url String", orderBy: "id" });
