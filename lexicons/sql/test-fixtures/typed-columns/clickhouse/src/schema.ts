import { database, dictionary, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const shopDb = database`CREATE DATABASE shop ENGINE = Atomic`;

export const events = table<"shop.events">`
  CREATE TABLE ${shopDb}.events (
    id UInt64,
    kind LowCardinality(String),
    at DateTime,
    country Nullable(String),
    score Float64,
    tags Array(Nullable(String)),
    attrs Map(String, UInt32),
    point Tuple(x Float64, y Float64)
  )
  ENGINE = MergeTree
  ORDER BY (kind, at)`;

export const rates = dictionary<"shop.rates">`
  CREATE DICTIONARY ${shopDb}.rates (
    currency String,
    rate Float64 DEFAULT 1
  )
  PRIMARY KEY currency
  SOURCE(CLICKHOUSE(TABLE 'rates_source' DB 'shop'))
  LAYOUT(HASHED())
  LIFETIME(300)`;

export const eventsByKind = view<"shop.events_by_kind">`
  CREATE MATERIALIZED VIEW ${shopDb}.events_by_kind
  ENGINE = SummingMergeTree ORDER BY ${events.columns.kind} AS
  SELECT ${events.columns.kind}, count() AS n FROM ${events} GROUP BY ${events.columns.kind}`;
