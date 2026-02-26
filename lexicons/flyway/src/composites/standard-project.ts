/**
 * StandardProject composite — Project + dev environment + prod environment + config.
 *
 * A higher-level construct for the most common Flyway setup: a single project
 * with a development URL, a production URL, shared schemas, and sensible
 * config defaults.
 */

export interface StandardProjectProps {
  /** Project name — used as the Flyway project identifier. */
  name: string;
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /** JDBC URL for the development environment. */
  devUrl: string;
  /** JDBC URL for the production environment. */
  prodUrl: string;
  /** Schemas managed by Flyway (default: ["public"]). */
  schemas?: string[];
  /** Migration locations (default: ["filesystem:sql"]). */
  locations?: string[];
  /** Default schema (default: first entry from `schemas`). */
  defaultSchema?: string;
}

export interface StandardProjectResult {
  /** Props for a FlywayProject resource. */
  project: Record<string, unknown>;
  /** Props for the "dev" Environment resource. */
  dev: Record<string, unknown>;
  /** Props for the "prod" Environment resource. */
  prod: Record<string, unknown>;
  /** Props for a FlywayConfig resource. */
  config: Record<string, unknown>;
}

/**
 * Create a StandardProject composite — returns props for a FlywayProject,
 * two Environment resources (dev and prod), and a FlywayConfig.
 *
 * @example
 * ```ts
 * import { StandardProject } from "@intentius/chant-lexicon-flyway";
 *
 * const { project, dev, prod, config } = StandardProject({
 *   name: "my-app",
 *   databaseType: "postgresql",
 *   devUrl: "jdbc:postgresql://localhost:5432/myapp_dev",
 *   prodUrl: "jdbc:postgresql://prod-host:5432/myapp",
 *   schemas: ["public", "app"],
 * });
 *
 * export { project, dev, prod, config };
 * ```
 */
export function StandardProject(props: StandardProjectProps): StandardProjectResult {
  const {
    name,
    databaseType,
    devUrl,
    prodUrl,
    schemas = ["public"],
    locations = ["filesystem:sql"],
    defaultSchema,
  } = props;

  const resolvedDefaultSchema = defaultSchema ?? schemas[0];

  const project: Record<string, unknown> = {
    name,
  };

  const dev: Record<string, unknown> = {
    displayName: "dev",
    url: devUrl,
    schemas,
    provisioner: "clean",
  };

  const prod: Record<string, unknown> = {
    displayName: "prod",
    url: prodUrl,
    schemas,
  };

  const config: Record<string, unknown> = {
    defaultSchema: resolvedDefaultSchema,
    locations,
    databaseType,
    validateMigrationNaming: true,
    baselineOnMigrate: false,
  };

  return { project, dev, prod, config };
}
