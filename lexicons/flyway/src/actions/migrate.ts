/**
 * Flyway CLI command and callback event constants.
 *
 * These are used by composites, skills, and LSP completions to reference
 * Flyway operations in a type-safe way.
 */

/**
 * Flyway CLI commands — the core operations available via `flyway <command>`.
 */
export const MigrateCommands = {
  info: "info",
  validate: "validate",
  migrate: "migrate",
  clean: "clean",
  repair: "repair",
  baseline: "baseline",
  undo: "undo",
} as const;

/**
 * Flyway callback event names that can be hooked in `flyway.callbacks`
 * or via callback SQL scripts.
 */
export const CallbackEvents = {
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
 * Enterprise-only callback events (require Flyway Teams/Enterprise).
 */
export const EnterpriseCallbackEvents = {
  beforeUndo: "beforeUndo",
  afterUndo: "afterUndo",
} as const;

/**
 * Flyway provisioner types used in environment configurations.
 */
export const ProvisionerTypes = {
  clean: "clean",
  backup: "backup",
  snapshot: "snapshot",
  createdb: "createdb",
  docker: "docker",
} as const;

/**
 * Flyway resolver types for credential injection.
 */
export const ResolverTypes = {
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
