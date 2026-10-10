/**
 * sql Op activities, resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `sql` lexicon. Contributes the ClickHouse
 * applier (`clickhouseApply`, #3208), the Postgres applier (`postgresApply`,
 * #3280) and their envelope projection (`toApplyResult`, one for both), which
 * core's apply activity looks up by name for the `clickhouse` and `postgres`
 * targets, the emulator lifecycles, the steps of the two migration Ops, and
 * the receipt store and SQL step of an Op of `effect()` batches.
 */
import type { ReceiptReadArgs, ReceiptStalenessArgs, ReceiptWriteArgs } from "@intentius/chant/op/receipt-store";
import { sqlReceiptActivities } from "../../receipts";

export { clickhouseApply, toApplyResult, resolveMarker } from "./clickhouse-apply";
export type { ClickHouseApplyArgs, ClickHouseApplyDeps, ClickHouseApplyOutcome } from "./clickhouse-apply";
export { clickhouseUp, clickhouseDown, CLICKHOUSE_EMULATOR, CLICKHOUSE_EMULATOR_SPEC } from "./clickhouse-emulator";
export { postgresApply } from "./postgres-apply";
export type { PostgresApplyArgs, PostgresApplyDeps, PostgresApplyOutcome } from "./postgres-apply";
export { postgresUp, postgresDown, POSTGRES_EMULATOR, POSTGRES_EMULATOR_SPEC } from "./postgres-emulator";

// effect() steps (#3657): their receipts are kept on the environment's
// database server (../../receipts.ts, `chant_receipts.receipts`), and
// `sqlExec` runs a batch's SQL there. The receipt activities are fallbacks
// (core's ACTIVITY_FALLBACKS): those names are global to a run, and a project
// that also lists aws or k8s keeps its receipts in that lexicon's row.

/** The activities this module provides only when no other configured lexicon does. */
export const ACTIVITY_FALLBACKS: readonly string[] = ["receiptRead", "receiptWrite", "receiptStaleness"];
// Bound per call: the environment (`chant run --env`) and the project are read when a step runs.
export const receiptRead = (args: ReceiptReadArgs, signal?: AbortSignal) => sqlReceiptActivities().receiptRead(args, signal);
export const receiptWrite = (args: ReceiptWriteArgs, signal?: AbortSignal) => sqlReceiptActivities().receiptWrite(args, signal);
export const receiptStaleness = (args: ReceiptStalenessArgs, signal?: AbortSignal) => sqlReceiptActivities().receiptStaleness(args, signal);
export { sqlExec } from "./sql-exec";
export type { SqlExecArgs, SqlExecResult, SqlExecDeps } from "./sql-exec";

// The rebuild migration (#3198): one activity per step of ClickHouseRebuildOp
// (../../clickhouse/rebuild/op.ts). Its receipts are kept in ClickHouse and
// reached by the backfill directly, with the copy's own identity.
export {
  clickhouseRebuildPlan,
  clickhouseRebuildCreate,
  clickhouseRebuildDualWrite,
  clickhouseRebuildBackfill,
  clickhouseRebuildVerify,
  clickhouseRebuildSwap,
  clickhouseRebuildRetain,
  clickhouseRebuildDrop,
  clickhouseRebuildCompensate,
} from "./clickhouse-rebuild";
export type { ClickHouseRebuildArgs, ClickHouseRebuildDeps, RebuildPlanResult } from "./clickhouse-rebuild";

// The Postgres expand-and-contract migration (#3281): one activity per step of
// PostgresMigrationOp (../../postgres/migrate/op.ts). Its receipts are kept in
// the migrated table's schema and written by the backfill directly, in each
// batch's own transaction.
export {
  postgresMigrationPlan,
  postgresMigrationExpand,
  postgresMigrationDualWrite,
  postgresMigrationBackfill,
  postgresMigrationCarry,
  postgresMigrationVerify,
  postgresMigrationSwitch,
  postgresMigrationRetain,
  postgresMigrationContract,
  postgresMigrationCompensate,
} from "./postgres-migration";
export type { PostgresMigrationArgs, PostgresMigrationDeps, MigrationPlanResult } from "./postgres-migration";
