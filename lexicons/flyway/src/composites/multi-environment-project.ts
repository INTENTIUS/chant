/**
 * MultiEnvironmentProject composite — Project + N environments + shadow + config.
 *
 * A higher-level construct for Flyway setups with an arbitrary number of
 * named environments (e.g., dev, staging, prod) plus a shadow database
 * for diff-based development workflows.
 */

export interface EnvironmentEntry {
  /** Environment name (e.g., "dev", "staging", "prod"). */
  name: string;
  /** JDBC URL for this environment. */
  url: string;
  /** Schemas managed in this environment (overrides project-level schemas). */
  schemas?: string[];
  /** Provisioner type for this environment (e.g., "clean", "docker"). */
  provisioner?: string;
}

export interface MultiEnvironmentProjectProps {
  /** Project name — used as the Flyway project identifier. */
  name: string;
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /** List of environments to create. */
  environments: EnvironmentEntry[];
  /** Default schemas applied to environments that don't specify their own. */
  schemas?: string[];
  /** Migration locations (default: ["filesystem:sql"]). */
  locations?: string[];
  /** Whether to include a shadow database environment (default: true). */
  includeShadow?: boolean;
  /** JDBC URL for the shadow database (required if includeShadow is true). */
  shadowUrl?: string;
}

export interface MultiEnvironmentProjectResult {
  /** Props for a FlywayProject resource. */
  project: Record<string, unknown>;
  /** Props for each Environment resource, keyed by environment name. */
  environments: Record<string, Record<string, unknown>>;
  /** Props for the shadow Environment resource (if included). */
  shadow?: Record<string, unknown>;
  /** Props for a FlywayConfig resource. */
  config: Record<string, unknown>;
}

/**
 * Create a MultiEnvironmentProject composite — returns props for a FlywayProject,
 * N Environment resources, an optional shadow environment, and a FlywayConfig.
 *
 * @example
 * ```ts
 * import { MultiEnvironmentProject } from "@intentius/chant-lexicon-flyway";
 *
 * const { project, environments, shadow, config } = MultiEnvironmentProject({
 *   name: "my-service",
 *   databaseType: "postgresql",
 *   environments: [
 *     { name: "dev", url: "jdbc:postgresql://localhost:5432/dev" },
 *     { name: "staging", url: "jdbc:postgresql://staging:5432/app" },
 *     { name: "prod", url: "jdbc:postgresql://prod:5432/app" },
 *   ],
 *   shadowUrl: "jdbc:postgresql://localhost:5432/shadow",
 * });
 *
 * export { project, environments, shadow, config };
 * ```
 */
export function MultiEnvironmentProject(
  props: MultiEnvironmentProjectProps,
): MultiEnvironmentProjectResult {
  const {
    name,
    databaseType,
    environments: envEntries,
    schemas = ["public"],
    locations = ["filesystem:sql"],
    includeShadow = true,
    shadowUrl,
  } = props;

  const project: Record<string, unknown> = {
    name,
  };

  const environments: Record<string, Record<string, unknown>> = {};
  for (const entry of envEntries) {
    environments[entry.name] = {
      displayName: entry.name,
      url: entry.url,
      schemas: entry.schemas ?? schemas,
      ...(entry.provisioner && { provisioner: entry.provisioner }),
    };
  }

  const config: Record<string, unknown> = {
    defaultSchema: schemas[0],
    locations,
    databaseType,
    validateMigrationNaming: true,
  };

  const result: MultiEnvironmentProjectResult = {
    project,
    environments,
    config,
  };

  if (includeShadow && shadowUrl) {
    result.shadow = {
      displayName: "shadow",
      url: shadowUrl,
      schemas,
      provisioner: "clean",
    };
  }

  return result;
}
