/** The schema the round trip tests import, build, and compare: roundtrip.e2e.test.ts against live servers, import/roundtrip.test.ts offline. */
export const SCHEMA = [
  "CREATE DATABASE analytics ENGINE = Atomic COMMENT 'product analytics'",
  `CREATE TABLE analytics.events (
     user_id UUID,
     kind LowCardinality(String) DEFAULT 'click' COMMENT 'what happened',
     ts DateTime CODEC(Delta, ZSTD(3)),
     props Map(String, String),
     n Nullable(UInt32),
     total UInt64 MATERIALIZED ifNull(n, 0) * 2,
     INDEX by_kind kind TYPE bloom_filter(0.01) GRANULARITY 4,
     PROJECTION per_kind (SELECT kind, count() GROUP BY kind)
   )
   ENGINE = MergeTree
   PARTITION BY toYYYYMM(ts)
   ORDER BY (user_id, kind, ts)
   TTL ts + INTERVAL 180 DAY
   SETTINGS min_bytes_for_wide_part = 0
   COMMENT 'raw events'`,
  "CREATE TABLE analytics.users (id UUID, email String, updated_at DateTime) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id",
  "CREATE TABLE analytics.daily (day Date, kind LowCardinality(String), users AggregateFunction(uniq, UUID)) ENGINE = AggregatingMergeTree ORDER BY (day, kind)",
  "CREATE MATERIALIZED VIEW analytics.daily_mv TO analytics.daily AS SELECT toDate(ts) AS day, kind, uniqState(user_id) AS users FROM analytics.events GROUP BY day, kind",
  "CREATE VIEW analytics.by_kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind",
  "CREATE TABLE default.scratch (a UInt8) ENGINE = Log",
];
