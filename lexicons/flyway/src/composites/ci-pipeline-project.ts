/**
 * CiPipelineProject composite — Project + environment with `${env.*}`
 * references + strict validation config.
 *
 * A higher-level construct for Flyway projects running in CI/CD pipelines
 * where database credentials and URLs are supplied via environment variables.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { FlywayProject, FlywayConfig, Environment } from "../generated";

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
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    project?: Partial<ConstructorParameters<typeof FlywayProject>[0]>;
    environment?: Partial<ConstructorParameters<typeof Environment>[0]>;
    config?: Partial<ConstructorParameters<typeof FlywayConfig>[0]>;
  };
}

/**
 * Create a CiPipelineProject composite — returns declarable instances for
 * a FlywayProject, an Environment resource with `${env.*}` credential
 * references, and a FlywayConfig with strict validation suitable for CI pipelines.
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
export const CiPipelineProject = Composite<CiPipelineProjectProps>((props) => {
  const {
    name,
    databaseType,
    envVarPrefix = "FLYWAY",
    environmentName = "ci",
    schemas = ["public"],
    locations = ["filesystem:sql"],
    defaults: defs,
  } = props;

  const project = new FlywayProject(mergeDefaults({
    name,
  }, defs?.project));

  const environment = new Environment(mergeDefaults({
    displayName: environmentName,
    url: `\${env.${envVarPrefix}_URL}`,
    user: `\${env.${envVarPrefix}_USER}`,
    password: `\${env.${envVarPrefix}_PASSWORD}`,
    schemas,
  }, defs?.environment));

  const config = new FlywayConfig(mergeDefaults({
    defaultSchema: schemas[0],
    locations,
    databaseType,
    validateMigrationNaming: true,
    validateOnMigrate: true,
    cleanDisabled: true,
    baselineOnMigrate: false,
    outOfOrder: false,
  }, defs?.config));

  return { project, environment, config };
}, "CiPipelineProject");
