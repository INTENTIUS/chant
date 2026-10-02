import { table } from "../lexicon/index";

export const bad = table`
  CREATE TABLE bad (
    id     UUID,
    email  Strin g
  )
  ENGINE = MergeTree
  ORDER BY id`;
