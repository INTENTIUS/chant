/**
 * Flyway built-in placeholder constants and enums.
 *
 * These provide type-safe access to Flyway's built-in values.
 */

/**
 * Built-in Flyway placeholders available in SQL migrations.
 * These expand to `${flyway:name}` syntax in the TOML config.
 */
export const FLYWAY = {
  defaultSchema: "${flyway:defaultSchema}",
  user: "${flyway:user}",
  database: "${flyway:database}",
  timestamp: "${flyway:timestamp}",
  filename: "${flyway:filename}",
  workingDirectory: "${flyway:workingDirectory}",
  table: "${flyway:table}",
  environment: "${flyway:environment}",
} as const;

/**
 * Flyway callback event names.
 * Used in callback file naming and `callbackLocations` configuration.
 */
export const CallbackEvent = {
  beforeMigrate: "beforeMigrate",
  beforeEachMigrate: "beforeEachMigrate",
  beforeEachMigrateStatement: "beforeEachMigrateStatement",
  afterEachMigrateStatement: "afterEachMigrateStatement",
  afterEachMigrate: "afterEachMigrate",
  afterMigrate: "afterMigrate",
  afterMigrateError: "afterMigrateError",
  beforeUndo: "beforeUndo",
  afterUndo: "afterUndo",
  beforeDeploy: "beforeDeploy",
  afterDeploy: "afterDeploy",
  afterDeployError: "afterDeployError",
  beforeClean: "beforeClean",
  afterClean: "afterClean",
  afterCleanError: "afterCleanError",
  beforeValidate: "beforeValidate",
  afterValidate: "afterValidate",
  afterValidateError: "afterValidateError",
  beforeBaseline: "beforeBaseline",
  afterBaseline: "afterBaseline",
  afterBaselineError: "afterBaselineError",
  beforeRepair: "beforeRepair",
  afterRepair: "afterRepair",
  afterRepairError: "afterRepairError",
  beforeCreateSchema: "beforeCreateSchema",
  beforeConnect: "beforeConnect",
  afterConnect: "afterConnect",
} as const;

/**
 * All known callback event names as a set (for validation).
 */
export const CALLBACK_EVENTS = new Set(Object.values(CallbackEvent));

/**
 * Enterprise-only callback events (require Flyway Teams/Enterprise).
 */
export const ENTERPRISE_CALLBACK_EVENTS = new Set([
  CallbackEvent.beforeUndo,
  CallbackEvent.afterUndo,
]);

/**
 * Supported database types for Flyway projects.
 */
export const DatabaseType = {
  postgresql: "postgresql",
  mysql: "mysql",
  sqlserver: "sqlserver",
  oracle: "oracle",
  sqlite: "sqlite",
  mariadb: "mariadb",
  cockroachdb: "cockroachdb",
  h2: "h2",
  hsqldb: "hsqldb",
  derby: "derby",
} as const;

/**
 * All known database types as a set (for validation).
 */
export const DATABASE_TYPES = new Set(Object.values(DatabaseType));

/**
 * Provisioner type identifiers.
 */
export const ProvisionerType = {
  clean: "clean",
  backup: "backup",
  snapshot: "snapshot",
  createdb: "createdb",
  docker: "docker",
} as const;

/**
 * Resolver type identifiers.
 */
export const ResolverType = {
  vault: "vault",
  googlesecrets: "googlesecrets",
  dapr: "dapr",
  clone: "clone",
  azuread: "azuread",
  env: "env",
  git: "git",
  localSecret: "localSecret",
  localdb: "localdb",
} as const;
