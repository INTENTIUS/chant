import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The shop'`;

export const events = table`
  CREATE TABLE ${shop}.events (
    user_id  UInt64,
    kind     LowCardinality(String),
    ts       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (user_id, ts)
  TTL ts + INTERVAL 180 DAY
  COMMENT 'Raw events'`;

// Reads a column by reference, which the watch's snapshot hashes too.
export const byKind = view`
  CREATE VIEW ${shop}.by_kind AS
  SELECT ${events.columns.kind} AS kind, count() AS n
  FROM ${events}
  GROUP BY kind`;
