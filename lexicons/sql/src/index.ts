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
export { database, table, view, dictionary, user, role, policy, quota, settingsProfile, grant, literal } from "./clickhouse/entities";

// The Postgres tags whose names ClickHouse does not export, for the same reason.
// A tag folds as the function its file imports, so `table` imported from
// `@intentius/chant-lexicon-sql/postgres` is Postgres's. Declarations import
// them from the dialect subpath.
export { schema, index, sequence, type, domain, extension, func, procedure, aggregate, trigger, eventTrigger, operator, operatorClass, operatorFamily, foreignTable, textSearchConfiguration, textSearchDictionary, statistics, foreignDataWrapper, foreignServer, publication, collation, cast } from "./postgres/entities";

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

// Plain `.sql` files as a schema source (#3646): DDL read into the declarations
// the tagged templates make; also at `@intentius/chant-lexicon-sql/sql-files`.
export {
  readSqlFile,
  sqlFileDeclarations,
  sqlFileEntities,
  sqlFileOf,
  SqlFileError,
  type SqlFileObject,
  type SqlFileOptions,
  type SqlFileSource,
} from "./sql-files";

// SQL engine and yodel outcomes on chant's exit-code table (#4570); also at
// `@intentius/chant-lexicon-sql/exit-codes`.
export { sqlExitOf, sqlPlanMoved, yodelExitOf, YODEL_LEGACY_EXIT, type SqlEngineOutcome, type YodelExitSource } from "./exit-codes";

// The `sql-migrate` and `sql-apply` capabilities (#4569), contributed to core's
// capability-plugin seam: core loads `sqlCapabilityPlugin` when a project's
// chant.config lists this lexicon, so op waves and pr-plan plan and apply a
// SQL member through chant. sql-yodeler's engine runs by a fixed argv list
// (`YODEL_COMMANDS`).
export {
  sqlCapabilityPlugin,
  sqlMigrateCapability,
  sqlApplyCapability,
  createSqlMigrateCapability,
  createSqlApplyCapability,
  SqlPlanMovedError,
  YodelRunError,
  SQL_VERB_FAMILIES,
  type SqlMigrateStepInput,
  type SqlMigrateStepOutput,
  type SqlMigrateArtifact,
  type SqlApplyStepInput,
  type SqlApplyStepOutput,
} from "./capability-plugin";
export { YODEL_COMMANDS, YODEL_OPTIONAL_FLAGS, runAllowedYodel, allowedYodelArgv, type YodelRunner, type YodelRun } from "./yodel-run";
