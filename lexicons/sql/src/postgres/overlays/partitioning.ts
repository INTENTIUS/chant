/** Partitioning: `PARTITION BY`, partition bounds, `DEFAULT` partitions, `ATTACH` and `DETACH`. */

import { arg, type Clause } from "./kinds";

export const PARTITION_STRATEGIES = ["RANGE", "LIST", "HASH"] as const;

export const PARTITIONING: Record<string, Clause> = {
  partitionBy: {
    summary: "PARTITION BY { RANGE | LIST | HASH } ({ column | (expression) } [COLLATE c] [opclass], ...)",
    args: [arg("strategy", "keyword", { values: PARTITION_STRATEGIES }), arg("keys", "expression", { repeated: true })],
  },
  forValuesRange: { summary: "FOR VALUES FROM (bounds) TO (bounds); MINVALUE and MAXVALUE stand for unbounded", args: [arg("from", "expression", { repeated: true }), arg("to", "expression", { repeated: true })] },
  forValuesList: { summary: "FOR VALUES IN (values)", args: [arg("values", "expression", { repeated: true })] },
  forValuesHash: {
    summary: "FOR VALUES WITH (MODULUS m, REMAINDER r)",
    args: [arg("modulus", "number", { range: [1, 2147483647] }), arg("remainder", "number", { range: [0, 2147483646] })],
  },
  default: { summary: "DEFAULT partition", args: [] },
  attach: { summary: "ALTER TABLE parent ATTACH PARTITION child { FOR VALUES ... | DEFAULT }", args: [arg("partition", "identifier")] },
  detach: {
    summary: "ALTER TABLE parent DETACH PARTITION child [CONCURRENTLY | FINALIZE]",
    args: [arg("partition", "identifier"), arg("mode", "keyword", { optional: true, values: ["CONCURRENTLY", "FINALIZE"] })],
  },
  mergePartitions: { summary: "ALTER TABLE parent MERGE PARTITIONS (children) INTO child", args: [arg("partitions", "identifier", { repeated: true })], since: 18 },
  splitPartition: { summary: "ALTER TABLE parent SPLIT PARTITION child INTO (partitions)", args: [arg("partition", "identifier")], since: 18 },
};
