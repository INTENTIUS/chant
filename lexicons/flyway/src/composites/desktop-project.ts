/**
 * DesktopProject composite — Flyway Desktop workflow with development,
 * shadow, optional downstream environments, and [flywayDesktop] config.
 *
 * Mirrors the canonical Redgate `fw_auto_pilot` pattern: a development
 * database, a shadow database (provisioner=clean), and zero or more
 * downstream environments (test, prod, etc.).
 */

export interface DesktopProjectEnvironment {
  /** Environment name (e.g., "test", "prod"). */
  name: string;
  /** JDBC URL for this downstream environment. */
  url: string;
  /** Schemas (overrides project-level schemas). */
  schemas?: string[];
}

export interface DesktopProjectProps {
  /** Project name — used as the Flyway project identifier. */
  name: string;
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /** JDBC URL for the development environment. */
  devUrl: string;
  /** JDBC URL for the shadow environment. */
  shadowUrl: string;
  /** Schemas managed by Flyway (default: ["public"]). */
  schemas?: string[];

  /** Optional downstream environments (test, prod, etc.). */
  environments?: DesktopProjectEnvironment[];

  /** Schema model folder location (default: "./schema-model"). */
  schemaModelLocation?: string;
  /** Generate undo scripts — requires Enterprise tier (default: true). */
  undoScripts?: boolean;
  /** Redgate Compare filter file — omit to skip [redgateCompare] section. */
  filterFile?: string;
  /** Migration locations (default: ["filesystem:migrations"]). */
  locations?: string[];
}

export interface DesktopProjectResult {
  /** Props for a FlywayProject resource. */
  project: Record<string, unknown>;
  /** Props for a FlywayConfig resource (includes schemaModelLocation). */
  config: Record<string, unknown>;
  /** Props for a FlywayDesktopConfig resource. */
  desktop: Record<string, unknown>;
  /** Props for a RedgateCompareConfig resource (only if filterFile provided). */
  compare?: Record<string, unknown>;
  /** Props for the "development" Environment resource. */
  development: Record<string, unknown>;
  /** Props for the "shadow" Environment resource. */
  shadow: Record<string, unknown>;
  /** Props for downstream Environment resources, keyed by name. */
  environments: Record<string, Record<string, unknown>>;
}

/**
 * Create a DesktopProject composite — returns props for the Flyway Desktop
 * workflow: project, config, desktop, development env, shadow env, and
 * optional downstream environments.
 *
 * @example
 * ```ts
 * import { DesktopProject } from "@intentius/chant-lexicon-flyway";
 *
 * const result = DesktopProject({
 *   name: "my-project",
 *   databaseType: "postgresql",
 *   devUrl: "jdbc:postgresql://localhost:5432/devdb",
 *   shadowUrl: "jdbc:postgresql://localhost:5432/shadowdb",
 *   schemas: ["public"],
 *   environments: [
 *     { name: "test", url: "jdbc:postgresql://test:5432/db" },
 *     { name: "prod", url: "jdbc:postgresql://prod:5432/db" },
 *   ],
 * });
 * ```
 */
export function DesktopProject(props: DesktopProjectProps): DesktopProjectResult {
  const {
    name,
    databaseType,
    devUrl,
    shadowUrl,
    schemas = ["public"],
    environments: envEntries = [],
    schemaModelLocation = "./schema-model",
    undoScripts = true,
    filterFile,
    locations = ["filesystem:migrations"],
  } = props;

  const project: Record<string, unknown> = {
    name,
  };

  const config: Record<string, unknown> = {
    databaseType,
    locations,
    defaultSchema: schemas[0],
    validateMigrationNaming: true,
    schemaModelLocation,
  };

  const desktop: Record<string, unknown> = {
    developmentEnvironment: "development",
    shadowEnvironment: "shadow",
    generate: { undoScripts },
  };

  const development: Record<string, unknown> = {
    name: "development",
    url: devUrl,
    schemas,
  };

  const shadow: Record<string, unknown> = {
    name: "shadow",
    url: shadowUrl,
    schemas,
    provisioner: "clean",
  };

  const environments: Record<string, Record<string, unknown>> = {};
  for (const entry of envEntries) {
    environments[entry.name] = {
      name: entry.name,
      url: entry.url,
      schemas: entry.schemas ?? schemas,
    };
  }

  const result: DesktopProjectResult = {
    project,
    config,
    desktop,
    development,
    shadow,
    environments,
  };

  if (filterFile !== undefined) {
    result.compare = { filterFile };
  }

  return result;
}
