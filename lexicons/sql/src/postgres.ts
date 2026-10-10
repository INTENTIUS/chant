/**
 * `@intentius/chant-lexicon-sql/postgres`: the Postgres dialect (#3289).
 *
 * Everything here is spec-true to Postgres, not a database-agnostic model:
 * the statements are Postgres's own DDL, parsed at build time into entities,
 * and the names fold and quote as Postgres folds and quotes them.
 */

export {
  schema,
  table,
  index,
  view,
  sequence,
  type,
  domain,
  extension,
  func,
  procedure,
  trigger,
  literal,
  SqlLiteral,
  SqlTemplateError,
  PostgresObject,
  POSTGRES_ENTITY_TYPES,
  isPostgresObject,
  isColumnRef,
  quoteIdent,
  type PostgresEntityType,
  type PostgresSchema,
  type PostgresRelation,
  type PostgresTable,
  type PostgresView,
  type PostgresIndex,
  type PostgresSequence,
  type PostgresEnum,
  type PostgresDomain,
  type PostgresExtension,
  type PostgresFunction,
  type PostgresProcedure,
  type PostgresTrigger,
  type ColumnDef,
  type KeyDef,
  type CheckDef,
  type ForeignKeyDef,
  type ExclusionDef,
  type SchemaProps,
  type TableProps,
  type IndexProps,
  type ViewProps,
  type SequenceProps,
  type EnumProps,
  type DomainProps,
  type ExtensionProps,
  type RoutineProps,
  type RoutineArgDef,
  type FunctionProps,
  type ProcedureProps,
  type TriggerProps,
  type LineageEdge,
} from "./postgres/entities";

export {
  POSTGRES_PROVIDERS,
  COMMON_REFUSED,
  providerData,
  isPostgresProvider,
  providerAllowsExtension,
  isProviderOwned,
  refusedStatement,
  normalizeStatement,
  type PostgresProvider,
  type ProviderData,
  type ProviderSource,
  type RefusedStatement,
  type LiveObjectRef,
} from "./postgres/providers";

export {
  PostgresMigrationOp,
  type PostgresMigrationOpConfig,
  type PostgresMigrationOpResources,
  type PostgresMigrationArgs,
} from "./postgres/migrate/op";
export { POSTGRES_RECEIPTS_TABLE } from "./postgres/migrate/receipts";
export * from "./composites/postgres";
