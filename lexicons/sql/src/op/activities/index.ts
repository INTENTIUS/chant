/**
 * sql Op activities, resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `sql` lexicon. Contributes the ClickHouse
 * applier (`clickhouseApply`, #3208), the Postgres applier (`postgresApply`,
 * #3280) and their envelope projection (`toApplyResult`, one for both), which
 * core's apply activity looks up by name for the `clickhouse` and `postgres`
 * targets, the emulator lifecycles, and the steps of the two migration Ops.
 */
export { clickhouseApply, toApplyResult, resolveMarker } from "./clickhouse-apply";
export type { ClickHouseApplyArgs, ClickHouseApplyDeps, ClickHouseApplyOutcome } from "./clickhouse-apply";
export { clickhouseUp, clickhouseDown, CLICKHOUSE_EMULATOR, CLICKHOUSE_EMULATOR_SPEC } from "./clickhouse-emulator";
export { postgresApply } from "./postgres-apply";
export type { PostgresApplyArgs, PostgresApplyDeps, PostgresApplyOutcome } from "./postgres-apply";
export { postgresUp, postgresDown, POSTGRES_EMULATOR, POSTGRES_EMULATOR_SPEC } from "./postgres-emulator";

// The rebuild migration (#3198): one activity per step of ClickHouseRebuildOp
// (../../clickhouse/rebuild/op.ts). Its receipts are kept in ClickHouse and
// reached by the backfill directly, so this module exports no receiptRead or
// receiptWrite: those names are global to a run and belong to the receipt row
// of a project's aws or k8s lexicon.
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
