// The sql lexicon. Each database dialect is a subpath:
//   @intentius/chant-lexicon-sql/clickhouse
//   @intentius/chant-lexicon-sql/postgres
// The root exports the plugin, the serializer and the dialect list.

export { sqlPlugin } from "./plugin";
export { sqlSerializer } from "./serializer";
export { SQL_DIALECTS, type SqlDialect } from "./dialects";
export { sqlConfigSchema, type SqlConfig } from "./config";

// The ClickHouse tags, also exported at the root because the plugin registers
// them as intrinsics (check-lexicon resolves a registered intrinsic against the
// root's exports). Declarations import them from the dialect subpath,
// `@intentius/chant-lexicon-sql/clickhouse`.
export { database, table, view, dictionary, user, role, policy, grant, literal } from "./clickhouse/entities";

// The Postgres tags whose names ClickHouse does not export, for the same reason.
// A tag folds as the function its file imports, so `table` imported from
// `@intentius/chant-lexicon-sql/postgres` is Postgres's. Declarations import
// them from the dialect subpath.
export { schema, index, sequence, type, domain, extension, func, procedure, trigger } from "./postgres/entities";

// A schema change's statements between two builds, rendered offline for a
// migration file (#3644); also at `@intentius/chant-lexicon-sql/migration-statements`.
export {
  diffStatements,
  renderStatements,
  type DiffStatementsOptions,
  type ManualStep,
  type MigrationStep,
  type OpStep,
  type SchemaStatements,
  type StatementChange,
  type StatementStep,
  type StepObject,
} from "./migration-statements";
