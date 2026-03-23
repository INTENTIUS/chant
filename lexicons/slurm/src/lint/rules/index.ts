import { partitionNodesDefined } from "./partition-nodes-defined";
import { maxTimeFormat } from "./max-time-format";
import { selectTypeDeprecated } from "./select-type-deprecated";
import { defMemConflict } from "./def-mem-conflict";

export const rules = [
  partitionNodesDefined,
  maxTimeFormat,
  selectTypeDeprecated,
  defMemConflict,
];
