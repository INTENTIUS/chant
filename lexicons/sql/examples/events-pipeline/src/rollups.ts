import { RollupView } from "@intentius/chant-lexicon-sql/clickhouse";
import { events } from "./events";

// Events per kind per day, summed as rows arrive.
export const dailyKinds = RollupView({
  name: "daily_kinds",
  source: events.table,
  columns: "day Date, kind LowCardinality(String), n UInt64",
  select: "toDate(ts) AS day, kind, count() AS n",
  groupBy: "day, kind",
  partitionBy: "toYYYYMM(day)",
});

// Distinct users per day, merged from uniq states.
export const dailyUsers = RollupView({
  name: "daily_users",
  source: events.table,
  columns: "day Date, users AggregateFunction(uniq, UUID)",
  select: "toDate(ts) AS day, uniqState(user_id) AS users",
  groupBy: "day",
  engine: "AggregatingMergeTree",
  orderBy: "day",
});
