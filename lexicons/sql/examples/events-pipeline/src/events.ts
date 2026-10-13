import { EventsTable } from "@intentius/chant-lexicon-sql/clickhouse";

// Product events, kept for 30 days and partitioned by month.
export const events = EventsTable({
  name: "events",
  columns: "user_id UUID, kind LowCardinality(String), url String",
  orderBy: "(kind, user_id, ts)",
  ttlDays: 30,
});
