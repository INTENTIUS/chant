import { table } from "../lexicon/index";

export const events = table`
  CREATE TABLE events (
    user_id  UUID,
    kind     LowCardinality(String),
    ts       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (user_id, kind, ts)`;
