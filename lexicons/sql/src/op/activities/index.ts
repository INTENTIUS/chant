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
