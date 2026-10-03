/**
 * sql Op activities, resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `sql` lexicon. Contributes the ClickHouse
 * applier (`clickhouseApply`, #3208) and its envelope projection
 * (`toApplyResult`), which core's apply activity looks up by name for the
 * `clickhouse` target, and the emulator lifecycle.
 */
export { clickhouseApply, toApplyResult, resolveMarker } from "./clickhouse-apply";
export type { ClickHouseApplyArgs, ClickHouseApplyDeps, ClickHouseApplyOutcome } from "./clickhouse-apply";
export { clickhouseUp, clickhouseDown, CLICKHOUSE_EMULATOR, CLICKHOUSE_EMULATOR_SPEC } from "./clickhouse-emulator";

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
