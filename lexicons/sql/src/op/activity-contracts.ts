/**
 * Activity contracts for the sql lexicon's own `op/activities` (chant #2101):
 * the rebuild migration's steps (#3198).
 *
 * `loadActivityContracts` imports this module at
 * `@intentius/chant-lexicon-sql/op/activity-contracts` for every project that
 * lists the sql lexicon, and core's OPS012 and OPS013 check every
 * `ClickHouseRebuildOp` step against it at `chant build`: the arguments, and
 * the two references the Op makes into a step's return value, the
 * verification's `planDigest` (the swap gate) and the retention's
 * `dropDigest` (the drop gate). Arguments are `z.strictObject`, so a
 * misspelled key fails the build instead of vanishing.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

const dualWrite = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("materialized-view"), cutoverColumn: z.string(), cutoverDelay: z.string().optional() }),
  z.strictObject({ mode: z.literal("app") }),
]);

/** `ClickHouseRebuildArgs` (`../clickhouse/rebuild/op.ts`): the same for every step. */
const rebuildArgs = z.strictObject({
  table: z.string(),
  buildPath: z.string(),
  environment: z.string().optional(),
  dualWrite,
  retain: z.string().optional(),
  mutationTimeout: z.string().optional(),
  stack: z.string().optional(),
  ownershipEnv: z.string().optional(),
  cwd: z.string().optional(),
});

const state = z.enum(["rebuild", "swapped", "done"]);
const tableEntity = { entities: ["table"] };

export const clickhouseRebuildPlanContract = activityContract(
  "clickhouseRebuildPlan",
  rebuildArgs,
  z.object({ state, table: z.string(), planDigest: z.string().optional(), changes: z.array(z.string()), summary: z.string() }),
  tableEntity,
);

export const clickhouseRebuildCreateContract = activityContract(
  "clickhouseRebuildCreate",
  rebuildArgs,
  z.object({ state, table: z.string(), created: z.boolean() }),
  tableEntity,
);

export const clickhouseRebuildDualWriteContract = activityContract(
  "clickhouseRebuildDualWrite",
  rebuildArgs,
  z.object({ state, mode: z.enum(["materialized-view", "app"]), cutover: z.string().optional(), created: z.boolean() }),
  tableEntity,
);

export const clickhouseRebuildBackfillContract = activityContract(
  "clickhouseRebuildBackfill",
  rebuildArgs,
  z.object({ state, partitions: z.number(), copied: z.number(), skipped: z.number(), cleared: z.number() }),
  tableEntity,
);

export const clickhouseRebuildVerifyContract = activityContract(
  "clickhouseRebuildVerify",
  rebuildArgs,
  z.object({
    state,
    planDigest: z.string().optional(),
    partitions: z.number(),
    rows: z.number(),
    summary: z.string(),
    verification: z.array(z.object({ partition: z.string(), rows: z.number(), checksum: z.string() })),
  }),
  tableEntity,
);

export const clickhouseRebuildSwapContract = activityContract(
  "clickhouseRebuildSwap",
  rebuildArgs,
  z.object({ state, swapped: z.boolean(), dependents: z.array(z.string()), oldTable: z.string().optional(), retainUntil: z.string().optional() }),
  tableEntity,
);

export const clickhouseRebuildRetainContract = activityContract(
  "clickhouseRebuildRetain",
  rebuildArgs,
  z.object({ state, oldTable: z.string().optional(), retainUntil: z.string().optional(), due: z.boolean(), dropDigest: z.string().optional() }),
  tableEntity,
);

export const clickhouseRebuildDropContract = activityContract(
  "clickhouseRebuildDrop",
  rebuildArgs,
  z.object({ state, dropped: z.boolean(), oldTable: z.string().optional(), retainUntil: z.string().optional() }),
  tableEntity,
);

export const clickhouseRebuildCompensateContract = activityContract(
  "clickhouseRebuildCompensate",
  rebuildArgs,
  z.object({ dropped: z.array(z.string()) }),
  tableEntity,
);
