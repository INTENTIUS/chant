/**
 * Activity contracts for the sql lexicon's own `op/activities` (chant #2101):
 * the ClickHouse rebuild migration's steps (#3198) and the Postgres
 * expand-and-contract migration's (#3281).
 *
 * `loadActivityContracts` imports this module at
 * `@intentius/chant-lexicon-sql/op/activity-contracts` for every project that
 * lists the sql lexicon, and core's OPS012 and OPS013 check every
 * `ClickHouseRebuildOp` and `PostgresMigrationOp` step against it at
 * `chant build`: the arguments, and the two references each Op makes into a
 * step's return value, the verification's `planDigest` (the swap or switch
 * gate) and the retention's `dropDigest` or `contractDigest` (the drop or
 * contract gate). Arguments are `z.strictObject`, so a
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
  replicaTimeout: z.string().optional(),
  stack: z.string().optional(),
  ownershipEnv: z.string().optional(),
  cwd: z.string().optional(),
  keepOnFailure: z.boolean().optional(),
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

// ── PostgresMigrationOp (#3281) ────────────────────────────────────────

/** `PostgresMigrationArgs` (`../postgres/migrate/op.ts`): the same for every step. */
const migrationArgs = z.strictObject({
  table: z.string(),
  column: z.string(),
  buildPath: z.string(),
  environment: z.string().optional(),
  using: z.string().optional(),
  retain: z.string().optional(),
  batchSize: z.number().int().positive().optional(),
  replicationLag: z.union([z.literal(false), z.strictObject({ max: z.string().optional(), wait: z.string().optional() })]).optional(),
  lockTimeoutMs: z.number().int().nonnegative().optional(),
  statementTimeoutMs: z.number().int().nonnegative().optional(),
  stack: z.string().optional(),
  ownershipEnv: z.string().optional(),
  cwd: z.string().optional(),
  keepOnFailure: z.boolean().optional(),
});

const migrationState = z.enum(["migrate", "switched", "done"]);

export const postgresMigrationPlanContract = activityContract(
  "postgresMigrationPlan",
  migrationArgs,
  z.object({ state: migrationState, migration: z.string(), change: z.enum(["rename", "type"]), planDigest: z.string().optional(), changes: z.array(z.string()), summary: z.string() }),
  tableEntity,
);

export const postgresMigrationExpandContract = activityContract(
  "postgresMigrationExpand",
  migrationArgs,
  z.object({ state: migrationState, column: z.string(), added: z.boolean() }),
  tableEntity,
);

export const postgresMigrationDualWriteContract = activityContract(
  "postgresMigrationDualWrite",
  migrationArgs,
  z.object({ state: migrationState, trigger: z.string(), created: z.boolean() }),
  tableEntity,
);

export const postgresMigrationBackfillContract = activityContract(
  "postgresMigrationBackfill",
  migrationArgs,
  z.object({ state: migrationState, batches: z.number(), filled: z.number(), skipped: z.number(), rows: z.number(), pausedMs: z.number() }),
  tableEntity,
);

export const postgresMigrationCarryContract = activityContract(
  "postgresMigrationCarry",
  migrationArgs,
  z.object({ state: migrationState, built: z.number(), ready: z.number(), views: z.number(), carried: z.array(z.string()) }),
  tableEntity,
);

export const postgresMigrationVerifyContract = activityContract(
  "postgresMigrationVerify",
  migrationArgs,
  z.object({
    state: migrationState,
    planDigest: z.string().optional(),
    rows: z.number(),
    mismatched: z.number(),
    nulls: z.number(),
    checksum: z.string(),
    expected: z.string(),
    summary: z.string(),
  }),
  tableEntity,
);

export const postgresMigrationSwitchContract = activityContract(
  "postgresMigrationSwitch",
  migrationArgs,
  z.object({ state: migrationState, switched: z.boolean(), oldColumn: z.string().optional(), retainUntil: z.string().optional() }),
  tableEntity,
);

export const postgresMigrationRetainContract = activityContract(
  "postgresMigrationRetain",
  migrationArgs,
  z.object({ state: migrationState, oldColumn: z.string().optional(), retainUntil: z.string().optional(), due: z.boolean(), contractDigest: z.string().optional() }),
  tableEntity,
);

export const postgresMigrationContractContract = activityContract(
  "postgresMigrationContract",
  migrationArgs,
  z.object({ state: migrationState, dropped: z.boolean(), oldColumn: z.string().optional(), retainUntil: z.string().optional() }),
  tableEntity,
);

export const postgresMigrationCompensateContract = activityContract(
  "postgresMigrationCompensate",
  migrationArgs,
  z.object({ dropped: z.array(z.string()) }),
  tableEntity,
);

// ── effect() batches (#3657) ───────────────────────────────────────────

/** `SqlExecArgs` (`./activities/sql-exec.ts`): one batch's SQL on the environment's server. */
export const sqlExecContract = activityContract(
  "sqlExec",
  z.strictObject({
    sql: z.string().min(1),
    environment: z.string().optional(),
    settings: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    cwd: z.string().optional(),
  }),
  z.object({ dialect: z.enum(["clickhouse", "postgres"]), source: z.string(), rows: z.number() }),
);
