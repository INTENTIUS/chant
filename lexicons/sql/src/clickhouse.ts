/**
 * `@intentius/chant-lexicon-sql/clickhouse`: the ClickHouse dialect.
 *
 * Everything here is spec-true to ClickHouse at the pinned server release
 * (`CLICKHOUSE_VERSION`), not a database-agnostic model: the engine names,
 * column type families, codecs, skip index types and settings are the pinned
 * server's own, read from its `system.*` tables, and the argument grammar the
 * catalog does not carry comes from the overlays beside them.
 */

export {
  database,
  table,
  view,
  literal,
  SqlLiteral,
  SqlTemplateError,
  ClickHouseObject,
  CLICKHOUSE_ENTITY_TYPES,
  isClickHouseObject,
  isColumnRef,
  quoteIdentifier,
  type ClickHouseEntityType,
  type ClickHouseDatabase,
  type ClickHouseRelation,
  type ClickHouseTable,
  type ClickHouseView,
  type ColumnDef,
  type DatabaseProps,
  type EngineDef,
  type LineageEdge,
  type TableProps,
  type ViewProps,
} from "./clickhouse/entities";
export * from "./generated/clickhouse";
export * from "./composites/clickhouse";
export type * from "./clickhouse/catalog-types";
export { ENGINE_ARGUMENTS } from "./clickhouse/overlays/engines";
export { SKIP_INDEX_PARAMETERS } from "./clickhouse/overlays/skip-indexes";
export { CODEC_OVERLAY, type CodecOverlay } from "./clickhouse/overlays/codecs";
export { TYPE_PARAMETERS, WRAPPER_TYPES, type TypeParameter } from "./clickhouse/overlays/types";
export {
  TTL_ACTIONS,
  COLUMN_TTL_ACTIONS,
  TTL_RESULT_TYPES,
  TTL_SETTINGS,
  type TtlAction,
} from "./clickhouse/overlays/ttl";
export {
  PROJECTION_FORMS,
  PROJECTION_SETTINGS,
  PROJECTION_FORBIDDEN_CLAUSES,
  type ProjectionForm,
} from "./clickhouse/overlays/projections";
export { CLICKHOUSE_IMAGE_DIGEST, CLICKHOUSE_IMAGE_REPOSITORY, clickhouseImage } from "./spec/pin";
export {
  ClickHouseRebuildOp,
  type ClickHouseRebuildOpConfig,
  type ClickHouseRebuildOpResources,
  type ClickHouseRebuildArgs,
} from "./clickhouse/rebuild/op";
export type { DualWrite } from "./clickhouse/rebuild/observe";
export { RECEIPTS_DATABASE, RECEIPTS_TABLE } from "./clickhouse/rebuild/receipts";
