import { table } from "../lexicon/index";

const retentionDays = 90;
const codec = "ZSTD(3)";

export const logs = table`
  CREATE TABLE logs (
    ts   DateTime CODEC(${codec}),
    msg  String
  )
  ENGINE = MergeTree
  ORDER BY ts
  TTL ts + INTERVAL ${retentionDays} DAY`;
