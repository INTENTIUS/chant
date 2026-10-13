import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database`CREATE DATABASE shop ENGINE = Atomic`;

// The sort key used to be (ts, user_id). Queries filter by user first, so it
// changes to (user_id, ts): a new on-disk order, which ALTER cannot make.
// `chant sql plan` refuses it and names the Op in ./rebuild-events.op.ts.
export const events = table`
  CREATE TABLE ${shop}.events (
    user_id  UInt64,
    kind     LowCardinality(String),
    ts       DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (user_id, ts)`;
