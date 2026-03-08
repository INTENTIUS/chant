/**
 * StandardProject composite — Project + dev environment + prod environment + config.
 *
 * A higher-level construct for the most common Flyway setup: a single project
 * with a development URL, a production URL, shared schemas, and sensible
 * config defaults.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { FlywayProject, FlywayConfig, Environment } from "../generated";

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
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    project?: Partial<ConstructorParameters<typeof FlywayProject>[0]>;
    dev?: Partial<ConstructorParameters<typeof Environment>[0]>;
    prod?: Partial<ConstructorParameters<typeof Environment>[0]>;
    config?: Partial<ConstructorParameters<typeof FlywayConfig>[0]>;
  };
}

/**
 * Create a StandardProject composite — returns declarable instances for
 * a FlywayProject, two Environment resources (dev and prod), and a FlywayConfig.
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
export const StandardProject = Composite<StandardProjectProps>((props) => {
  const {
    name,
    databaseType,
    devUrl,
    prodUrl,
    schemas = ["public"],
    locations = ["filesystem:sql"],
    defaultSchema,
    defaults: defs,
  } = props;

  const resolvedDefaultSchema = defaultSchema ?? schemas[0];

  const project = new FlywayProject(mergeDefaults({
    name,
  }, defs?.project));

  const dev = new Environment(mergeDefaults({
    displayName: "dev",
    url: devUrl,
    schemas,
    provisioner: "clean",
  }, defs?.dev));

  const prod = new Environment(mergeDefaults({
    displayName: "prod",
    url: prodUrl,
    schemas,
  }, defs?.prod));

  const config = new FlywayConfig(mergeDefaults({
    defaultSchema: resolvedDefaultSchema,
    locations,
    databaseType,
    validateMigrationNaming: true,
    baselineOnMigrate: false,
  }, defs?.config));

  return { project, dev, prod, config };
}, "StandardProject");
