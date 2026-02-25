/**
 * CiPipelineProject composite — Project + environment with `${env.*}`
 * references + strict validation config.
 *
 * A higher-level construct for Flyway projects running in CI/CD pipelines
 * where database credentials and URLs are supplied via environment variables.
 */

export interface CiPipelineProjectProps {
  /** Project name — used as the Flyway project identifier. */
  name: string;
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /**
   * Prefix for environment variable names (default: "FLYWAY").
   * Variables resolved: `${env.<prefix>_URL}`, `${env.<prefix>_USER}`,
   * `${env.<prefix>_PASSWORD}`.
   */
  envVarPrefix?: string;
  /** Environment name (default: "ci"). */
  environmentName?: string;
  /** Schemas managed by Flyway (default: ["public"]). */
  schemas?: string[];
  /** Migration locations (default: ["filesystem:sql"]). */
  locations?: string[];
}

export interface CiPipelineProjectResult {
  /** Props for a FlywayProject resource. */
  project: Record<string, unknown>;
  /** Props for the CI Environment resource with `${env.*}` references. */
  environment: Record<string, unknown>;
  /** Props for a FlywayConfig resource with strict validation settings. */
  config: Record<string, unknown>;
}

/**
 * Create a CiPipelineProject composite — returns props for a FlywayProject,
 * an Environment resource with `${env.*}` credential references, and a
 * FlywayConfig with strict validation suitable for CI pipelines.
 *
 * @example
 * ```ts
 * import { CiPipelineProject } from "@intentius/chant-lexicon-flyway";
 *
 * const { project, environment, config } = CiPipelineProject({
 *   name: "my-service",
 *   databaseType: "postgresql",
 *   envVarPrefix: "DB",
 * });
 * // environment.url  → "${env.DB_URL}"
 * // environment.user → "${env.DB_USER}"
 *
 * export { project, environment, config };
 * ```
 */
export function CiPipelineProject(props: CiPipelineProjectProps): CiPipelineProjectResult {
  const {
    name,
    databaseType,
    envVarPrefix = "FLYWAY",
    environmentName = "ci",
    schemas = ["public"],
    locations = ["filesystem:sql"],
  } = props;

  const project: Record<string, unknown> = {
    name,
  };

  const environment: Record<string, unknown> = {
    name: environmentName,
    url: `\${env.${envVarPrefix}_URL}`,
    user: `\${env.${envVarPrefix}_USER}`,
    password: `\${env.${envVarPrefix}_PASSWORD}`,
    schemas,
  };

  const config: Record<string, unknown> = {
    defaultSchema: schemas[0],
    locations,
    databaseType,
    validateMigrationNaming: true,
    validateOnMigrate: true,
    cleanDisabled: true,
    baselineOnMigrate: false,
    outOfOrder: false,
  };

  return { project, environment, config };
}
