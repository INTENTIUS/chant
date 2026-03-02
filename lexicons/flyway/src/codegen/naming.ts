/**
 * Flyway naming strategy — trivial mapping since Flyway types are few and static.
 *
 * Maps Flyway::{TypeName} -> TypeName (e.g. Flyway::Project -> FlywayProject).
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";

const flywayNamingConfig: NamingConfig = {
  priorityNames: {
    "Flyway::Project": "FlywayProject",
    "Flyway::Config": "FlywayConfig",
    "Flyway::Environment": "Environment",
    "Flyway::Environment.Flyway": "EnvironmentFlyway",
    "Flyway::Resolver.Vault": "VaultResolver",
    "Flyway::Resolver.Gcp": "GcpResolver",
    "Flyway::Resolver.Dapr": "DaprResolver",
    "Flyway::Resolver.Clone": "CloneResolver",
    "Flyway::Resolver.AzureAd": "AzureAdResolver",
    "Flyway::Resolver.Env": "EnvResolver",
    "Flyway::Resolver.Git": "GitResolver",
    "Flyway::Resolver.LocalSecret": "LocalSecretResolver",
    "Flyway::Provisioner.Backup": "BackupProvisioner",
    "Flyway::Provisioner.Snapshot": "SnapshotProvisioner",
    "Flyway::Provisioner.Clean": "CleanProvisioner",
    "Flyway::Provisioner.CreateDb": "CreateDbProvisioner",
    "Flyway::Provisioner.Docker": "DockerProvisioner",
    "Flyway::FlywayDesktop": "FlywayDesktopConfig",
    "Flyway::RedgateCompare": "RedgateCompareConfig",
    "Flyway::Placeholder": "Placeholder",
    "Flyway::Database.Postgres": "PostgresConfig",
    "Flyway::Database.MySQL": "MySQLConfig",
    "Flyway::Database.SQLServer": "SQLServerConfig",
    "Flyway::Database.Oracle": "OracleConfig",
    "Flyway::Database.SQLite": "SQLiteConfig",
  },

  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},

  shortName: (typeName: string) => typeName.split("::").pop() ?? typeName,
  serviceName: (_typeName: string) => "Flyway",
};

/**
 * Flyway naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(inputs: NamingInput[]) {
    super(inputs, flywayNamingConfig);
  }
}
