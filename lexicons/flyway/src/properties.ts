/**
 * Canonical property definitions for all Flyway lexicon types.
 *
 * Single source of truth used by:
 * - codegen/generate.ts — typed .d.ts generation
 * - serializer.ts — key ordering
 * - lint/post-synth/wfw111.ts — unknown key detection
 */

import type { DtsProperty } from "@intentius/chant/codegen/generate-typescript";

// ── FlywayProject (root-level) ──────────────────────────────────────

export const FLYWAY_PROJECT_PROPERTIES: DtsProperty[] = [
  { name: "id", type: "string", required: true, description: "Unique project identifier" },
  { name: "name", type: "string", required: true, description: "Human-readable project name" },
  { name: "databaseType", type: "DatabaseTypeValue", required: false, description: "Default database type for the project" },
];

// ── FlywayConfig ([flyway] section) ─────────────────────────────────

export const FLYWAY_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "locations", type: "string[]", required: false, description: "Locations to scan for migrations" },
  { name: "defaultSchema", type: "string", required: false, description: "Default schema managed by Flyway" },
  { name: "schemas", type: "string[]", required: false, description: "Schemas managed by Flyway" },
  { name: "encoding", type: "string", required: false, description: "Encoding of SQL migration files" },
  { name: "validateMigrationNaming", type: "boolean", required: false, description: "Whether to validate migration naming conventions" },
  { name: "validateOnMigrate", type: "boolean", required: false, description: "Whether to validate applied migrations against resolved ones on migrate" },
  { name: "outOfOrder", type: "boolean", required: false, description: "Allow out-of-order migrations" },
  { name: "cleanDisabled", type: "boolean", required: false, description: "Whether to disable clean command" },
  { name: "baselineOnMigrate", type: "boolean", required: false, description: "Whether to baseline on migrate for non-empty schemas" },
  { name: "baselineVersion", type: "string", required: false, description: "Version to tag existing schema as baseline" },
  { name: "baselineDescription", type: "string", required: false, description: "Description for the baseline migration" },
  { name: "sqlMigrationPrefix", type: "string", required: false, description: "Prefix for versioned SQL migrations" },
  { name: "sqlMigrationSeparator", type: "string", required: false, description: "Separator between version and description" },
  { name: "sqlMigrationSuffixes", type: "string[]", required: false, description: "File suffixes for SQL migrations" },
  { name: "repeatableMigrationPrefix", type: "string", required: false, description: "Prefix for repeatable migrations" },
  { name: "table", type: "string", required: false, description: "Name of the schema history table" },
  { name: "tablespace", type: "string", required: false, description: "Tablespace for the schema history table" },
  { name: "group", type: "boolean", required: false, description: "Whether to group pending migrations into a single transaction" },
  { name: "mixed", type: "boolean", required: false, description: "Allow mixing transactional and non-transactional statements in a migration" },
  { name: "cherryPick", type: "string[]", required: false, description: "Specific migrations to apply, ignoring others" },
  { name: "callbackLocations", type: "string[]", required: false, description: "Locations for callback scripts" },
  { name: "skipExecutingMigrations", type: "boolean", required: false, description: "Skip executing migrations, only update schema history" },
  { name: "placeholders", type: "Record<string, string>", required: false, description: "Placeholders to replace in SQL migrations" },
  { name: "callbacks", type: "Record<string, string>", required: false, description: "Named callback definitions" },
  { name: "databaseType", type: "DatabaseTypeValue", required: false, description: "Database type override" },
  { name: "schemaModelLocation", type: "string", required: false, description: "Location of the schema model directory" },
  { name: "schemaModelPrefix", type: "string", required: false, description: "Prefix for schema model files" },
];

// ── Environment ([environments.*]) ──────────────────────────────────

export const ENVIRONMENT_PROPERTIES: DtsProperty[] = [
  { name: "url", type: "string", required: false, description: "JDBC connection URL" },
  { name: "user", type: "string", required: false, description: "Database user" },
  { name: "password", type: "string", required: false, description: "Database password" },
  { name: "displayName", type: "string", required: false, description: "Display name for the environment" },
  { name: "schemas", type: "string[]", required: false, description: "Schemas managed in this environment" },
  { name: "provisioner", type: "string", required: false, description: "Provisioner type or config" },
  { name: "resolvers", type: "Record<string, unknown>", required: false, description: "Resolver configurations" },
  { name: "flyway", type: "EnvironmentFlyway", required: false, description: "Per-environment Flyway config overrides" },
  { name: "extends", type: "string", required: false, description: "Parent environment to extend" },
  { name: "cleanDisabled", type: "boolean", required: false, description: "Whether to disable clean command in this environment" },
  { name: "validateOnMigrate", type: "boolean", required: false, description: "Whether to validate on migrate in this environment" },
  { name: "baselineOnMigrate", type: "boolean", required: false, description: "Whether to baseline on migrate in this environment" },
];

// ── EnvironmentFlyway (per-env overrides) ───────────────────────────

export const ENVIRONMENT_FLYWAY_PROPERTIES: DtsProperty[] = [
  { name: "locations", type: "string[]", required: false, description: "Locations to scan for migrations" },
  { name: "defaultSchema", type: "string", required: false, description: "Default schema managed by Flyway" },
  { name: "schemas", type: "string[]", required: false, description: "Schemas managed by Flyway" },
  { name: "encoding", type: "string", required: false, description: "Encoding of SQL migration files" },
  { name: "validateMigrationNaming", type: "boolean", required: false, description: "Whether to validate migration naming conventions" },
  { name: "validateOnMigrate", type: "boolean", required: false, description: "Whether to validate on migrate" },
  { name: "outOfOrder", type: "boolean", required: false, description: "Allow out-of-order migrations" },
  { name: "cleanDisabled", type: "boolean", required: false, description: "Whether to disable clean command" },
  { name: "baselineOnMigrate", type: "boolean", required: false, description: "Whether to baseline on migrate" },
  { name: "baselineVersion", type: "string", required: false, description: "Version to tag as baseline" },
  { name: "baselineDescription", type: "string", required: false, description: "Description for the baseline" },
  { name: "sqlMigrationPrefix", type: "string", required: false, description: "Prefix for versioned SQL migrations" },
  { name: "sqlMigrationSeparator", type: "string", required: false, description: "Separator between version and description" },
  { name: "sqlMigrationSuffixes", type: "string[]", required: false, description: "File suffixes for SQL migrations" },
  { name: "repeatableMigrationPrefix", type: "string", required: false, description: "Prefix for repeatable migrations" },
  { name: "table", type: "string", required: false, description: "Name of the schema history table" },
  { name: "tablespace", type: "string", required: false, description: "Tablespace for the schema history table" },
  { name: "group", type: "boolean", required: false, description: "Group pending migrations in a single transaction" },
  { name: "mixed", type: "boolean", required: false, description: "Allow mixed transactional and non-transactional statements" },
  { name: "cherryPick", type: "string[]", required: false, description: "Specific migrations to apply" },
  { name: "callbackLocations", type: "string[]", required: false, description: "Locations for callback scripts" },
  { name: "skipExecutingMigrations", type: "boolean", required: false, description: "Skip executing, only update history" },
  { name: "placeholders", type: "Record<string, string>", required: false, description: "Placeholders for SQL migrations" },
  { name: "callbacks", type: "Record<string, string>", required: false, description: "Named callback definitions" },
  { name: "databaseType", type: "DatabaseTypeValue", required: false, description: "Database type override" },
  { name: "schemaModelLocation", type: "string", required: false, description: "Location of the schema model directory" },
  { name: "schemaModelPrefix", type: "string", required: false, description: "Prefix for schema model files" },
];

// ── Resolvers ───────────────────────────────────────────────────────

export const VAULT_RESOLVER_PROPERTIES: DtsProperty[] = [
  { name: "url", type: "string", required: true, description: "Vault server URL" },
  { name: "token", type: "string", required: true, description: "Vault authentication token" },
  { name: "secretPath", type: "string", required: false, description: "Path to the secret in Vault" },
  { name: "engineName", type: "string", required: false, description: "Vault secrets engine name" },
  { name: "engineVersion", type: "string", required: false, description: "Vault secrets engine version" },
];

export const GCP_RESOLVER_PROPERTIES: DtsProperty[] = [
  { name: "project", type: "string", required: false, description: "GCP project ID" },
];

export const DAPR_RESOLVER_PROPERTIES: DtsProperty[] = [
  { name: "url", type: "string", required: false, description: "Dapr sidecar URL" },
  { name: "storeName", type: "string", required: false, description: "Dapr secret store name" },
];

export const CLONE_RESOLVER_PROPERTIES: DtsProperty[] = [
  { name: "environment", type: "string", required: false, description: "Source environment to clone from" },
];

export const AZURE_AD_RESOLVER_PROPERTIES: DtsProperty[] = [
  { name: "tenantId", type: "string", required: false, description: "Azure AD tenant ID" },
  { name: "clientId", type: "string", required: false, description: "Azure AD client/application ID" },
];

export const ENV_RESOLVER_PROPERTIES: DtsProperty[] = [];

export const GIT_RESOLVER_PROPERTIES: DtsProperty[] = [];

export const LOCAL_SECRET_RESOLVER_PROPERTIES: DtsProperty[] = [];

// ── Provisioners ────────────────────────────────────────────────────

export const BACKUP_PROVISIONER_PROPERTIES: DtsProperty[] = [
  { name: "filePath", type: "string", required: true, description: "Path to the backup file" },
];

export const SNAPSHOT_PROVISIONER_PROPERTIES: DtsProperty[] = [
  { name: "filePath", type: "string", required: true, description: "Path to the snapshot file" },
];

export const CLEAN_PROVISIONER_PROPERTIES: DtsProperty[] = [];

export const CREATE_DB_PROVISIONER_PROPERTIES: DtsProperty[] = [];

export const DOCKER_PROVISIONER_PROPERTIES: DtsProperty[] = [
  { name: "image", type: "string", required: false, description: "Docker image to use" },
  { name: "port", type: "number", required: false, description: "Port to expose" },
  { name: "envVars", type: "Record<string, string>", required: false, description: "Environment variables for the container" },
];

// ── FlywayDesktopConfig ([flywayDesktop]) ───────────────────────────

export const FLYWAY_DESKTOP_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "developmentEnvironment", type: "string", required: false, description: "Name of the development environment" },
  { name: "shadowEnvironment", type: "string", required: false, description: "Name of the shadow environment" },
  { name: "generate", type: "Record<string, unknown>", required: false, description: "Generation settings" },
];

// ── RedgateCompareConfig ([redgateCompare]) ─────────────────────────

export const REDGATE_COMPARE_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "filterFile", type: "string", required: false, description: "Path to the Redgate compare filter file" },
];

// ── Placeholder ─────────────────────────────────────────────────────

export const PLACEHOLDER_PROPERTIES: DtsProperty[] = [
  { name: "key", type: "string", required: true, description: "Placeholder key" },
  { name: "value", type: "string", required: true, description: "Placeholder value" },
];

// ── Database-specific configs ───────────────────────────────────────

export const POSTGRES_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "transactionalLock", type: "boolean", required: false, description: "Use transactional advisory lock" },
];

export const MYSQL_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "ssl", type: "boolean", required: false, description: "Enable SSL" },
];

export const SQLSERVER_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "trustServerCertificate", type: "boolean", required: false, description: "Trust the server certificate" },
];

export const ORACLE_CONFIG_PROPERTIES: DtsProperty[] = [
  { name: "sqlplus", type: "boolean", required: false, description: "Enable SQL*Plus command support" },
  { name: "sqlplusWarn", type: "boolean", required: false, description: "Show SQL*Plus warnings" },
];

export const SQLITE_CONFIG_PROPERTIES: DtsProperty[] = [];

// ── Property map for codegen ────────────────────────────────────────

/**
 * Map from TypeScript class name to its property definitions.
 */
export const PROPERTIES_BY_CLASS: Record<string, DtsProperty[]> = {
  FlywayProject: FLYWAY_PROJECT_PROPERTIES,
  FlywayConfig: FLYWAY_CONFIG_PROPERTIES,
  Environment: ENVIRONMENT_PROPERTIES,
  EnvironmentFlyway: ENVIRONMENT_FLYWAY_PROPERTIES,
  VaultResolver: VAULT_RESOLVER_PROPERTIES,
  GcpResolver: GCP_RESOLVER_PROPERTIES,
  DaprResolver: DAPR_RESOLVER_PROPERTIES,
  CloneResolver: CLONE_RESOLVER_PROPERTIES,
  AzureAdResolver: AZURE_AD_RESOLVER_PROPERTIES,
  EnvResolver: ENV_RESOLVER_PROPERTIES,
  GitResolver: GIT_RESOLVER_PROPERTIES,
  LocalSecretResolver: LOCAL_SECRET_RESOLVER_PROPERTIES,
  BackupProvisioner: BACKUP_PROVISIONER_PROPERTIES,
  SnapshotProvisioner: SNAPSHOT_PROVISIONER_PROPERTIES,
  CleanProvisioner: CLEAN_PROVISIONER_PROPERTIES,
  CreateDbProvisioner: CREATE_DB_PROVISIONER_PROPERTIES,
  DockerProvisioner: DOCKER_PROVISIONER_PROPERTIES,
  FlywayDesktopConfig: FLYWAY_DESKTOP_CONFIG_PROPERTIES,
  RedgateCompareConfig: REDGATE_COMPARE_CONFIG_PROPERTIES,
  Placeholder: PLACEHOLDER_PROPERTIES,
  PostgresConfig: POSTGRES_CONFIG_PROPERTIES,
  MySQLConfig: MYSQL_CONFIG_PROPERTIES,
  SQLServerConfig: SQLSERVER_CONFIG_PROPERTIES,
  OracleConfig: ORACLE_CONFIG_PROPERTIES,
  SQLiteConfig: SQLITE_CONFIG_PROPERTIES,
};

// ── Key ordering for serializer ─────────────────────────────────────

/**
 * Key ordering for the [flyway] TOML section — most important keys first.
 * Derived from FLYWAY_CONFIG_PROPERTIES to keep a single source of truth.
 */
export const FLYWAY_KEY_ORDER = FLYWAY_CONFIG_PROPERTIES.map((p) => p.name);

/**
 * Key ordering for [environments.*] sections.
 * Derived from ENVIRONMENT_PROPERTIES to keep a single source of truth.
 */
export const ENV_KEY_ORDER = ENVIRONMENT_PROPERTIES.map((p) => p.name);

// ── Valid keys by TOML section (for post-synth checks) ──────────────

/**
 * Map from TOML section name to the set of valid keys in that section.
 * Used by WFW111 to detect unknown keys.
 */
export const VALID_KEYS_BY_TOML_SECTION: Record<string, Set<string>> = {
  root: new Set(FLYWAY_PROJECT_PROPERTIES.map((p) => p.name)),
  flyway: new Set(FLYWAY_CONFIG_PROPERTIES.map((p) => p.name)),
  environments: new Set(ENVIRONMENT_PROPERTIES.map((p) => p.name)),
  flywayDesktop: new Set(FLYWAY_DESKTOP_CONFIG_PROPERTIES.map((p) => p.name)),
  redgateCompare: new Set(REDGATE_COMPARE_CONFIG_PROPERTIES.map((p) => p.name)),
};
