/**
 * Runtime factory constructors for Flyway lexicon types.
 *
 * Hand-authored (no upstream schema) — covers Flyway v10+ TOML config.
 */
import { createResource, createProperty } from "@intentius/chant/runtime";

// ── Resource types (top-level entities) ────────────────────────────

/** Flyway project — top-level configuration container. */
export const FlywayProject = createResource("Flyway::Project", "flyway", { name: "name" });

/** Flyway global config — [flyway] namespace settings. */
export const FlywayConfig = createResource("Flyway::Config", "flyway", {});

/** Environment — [environments.<name>] section. */
export const Environment = createResource("Flyway::Environment", "flyway", { name: "name" });

// ── Property types (nested / inline entities) ──────────────────────

/** Per-environment flyway overrides — [environments.<name>.flyway]. */
export const EnvironmentFlyway = createProperty("Flyway::Environment.Flyway", "flyway");

/** Vault resolver config. */
export const VaultResolver = createProperty("Flyway::Resolver.Vault", "flyway");

/** GCP Secret Manager resolver config. */
export const GcpResolver = createProperty("Flyway::Resolver.Gcp", "flyway");

/** Dapr resolver config. */
export const DaprResolver = createProperty("Flyway::Resolver.Dapr", "flyway");

/** Clone resolver config. */
export const CloneResolver = createProperty("Flyway::Resolver.Clone", "flyway");

/** Azure AD resolver config. */
export const AzureAdResolver = createProperty("Flyway::Resolver.AzureAd", "flyway");

/** Environment variable resolver (no config). */
export const EnvResolver = createProperty("Flyway::Resolver.Env", "flyway");

/** Git resolver (no config). */
export const GitResolver = createProperty("Flyway::Resolver.Git", "flyway");

/** Local secret resolver (no config). */
export const LocalSecretResolver = createProperty("Flyway::Resolver.LocalSecret", "flyway");

/** Backup provisioner config. */
export const BackupProvisioner = createProperty("Flyway::Provisioner.Backup", "flyway");

/** Snapshot provisioner config. */
export const SnapshotProvisioner = createProperty("Flyway::Provisioner.Snapshot", "flyway");

/** Clean provisioner (no config). */
export const CleanProvisioner = createProperty("Flyway::Provisioner.Clean", "flyway");

/** Create database provisioner (no config). */
export const CreateDbProvisioner = createProperty("Flyway::Provisioner.CreateDb", "flyway");

/** Docker provisioner (no config). */
export const DockerProvisioner = createProperty("Flyway::Provisioner.Docker", "flyway");

/** Flyway Desktop config — [flywayDesktop] namespace. */
export const FlywayDesktopConfig = createResource("Flyway::FlywayDesktop", "flyway", {});

/** Redgate Compare config — [redgateCompare] namespace. */
export const RedgateCompareConfig = createResource("Flyway::RedgateCompare", "flyway", {});

/** Placeholder entry — key-value in [flyway.placeholders]. */
export const Placeholder = createProperty("Flyway::Placeholder", "flyway");

// Database-specific config types
export const PostgresConfig = createProperty("Flyway::Database.Postgres", "flyway");
export const MySQLConfig = createProperty("Flyway::Database.MySQL", "flyway");
export const SQLServerConfig = createProperty("Flyway::Database.SQLServer", "flyway");
export const OracleConfig = createProperty("Flyway::Database.Oracle", "flyway");
export const SQLiteConfig = createProperty("Flyway::Database.SQLite", "flyway");
