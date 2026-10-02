import { table, view } from "../lexicon/index";

export const clicks = table`
  CREATE TABLE clicks (
    url   String,
    kind  LowCardinality(String),
    ts    DateTime
  )
  ENGINE = MergeTree
  ORDER BY (url, ts)`;

export const clicksByKind = view`
  CREATE VIEW clicks_by_kind AS
  SELECT ${clicks.columns.kind} AS kind, count() AS c
  FROM ${clicks}
  GROUP BY ${clicks.columns.kind}`;
