import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const events = table`
  CREATE TABLE smoke_events (user_id UUID, kind LowCardinality(String), ts DateTime)
  ENGINE = MergeTree
  ORDER BY (user_id, ts)`;

export const byKind = view`
  CREATE VIEW smoke_by_kind AS
  SELECT ${events.columns.kind} AS kind, count() AS n FROM ${events} GROUP BY kind`;
