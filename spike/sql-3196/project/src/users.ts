import { table } from "../lexicon/index";

export const users = table`
  CREATE TABLE users (
    id     UUID,
    email  String,
    plan   LowCardinality(String)
  )
  ENGINE = ReplacingMergeTree
  ORDER BY id`;
