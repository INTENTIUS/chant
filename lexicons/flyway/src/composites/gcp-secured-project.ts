/**
 * GcpSecuredProject composite — Project + GCP Secret Manager resolver +
 * environments with `${googlesecrets.*}` references + config.
 *
 * A higher-level construct for Flyway projects that retrieve database
 * credentials from Google Cloud Secret Manager.
 */

export interface GcpEnvironmentEntry {
  /** Environment name (e.g., "staging", "prod"). */
  name: string;
  /** JDBC URL for this environment. */
  url: string;
  /** GCP secret name for the database user (default: `"<project>-<name>-db-user"`). */
  userSecret?: string;
  /** GCP secret name for the database password (default: `"<project>-<name>-db-password"`). */
  passwordSecret?: string;
  /** Schemas managed in this environment. */
  schemas?: string[];
}

export interface GcpSecuredProjectProps {
  /** Project name — used as the Flyway project identifier. */
  name: string;
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /** GCP project ID where secrets are stored. */
  gcpProject: string;
  /** List of environments to create. */
  environments: GcpEnvironmentEntry[];
  /** Default schemas applied to environments that don't specify their own. */
  schemas?: string[];
  /** Migration locations (default: ["filesystem:sql"]). */
  locations?: string[];
}

export interface GcpSecuredProjectResult {
  /** Props for a FlywayProject resource. */
  project: Record<string, unknown>;
  /** Props for a GcpResolver property. */
  gcpResolver: Record<string, unknown>;
  /** Props for each Environment resource, keyed by environment name. */
  environments: Record<string, Record<string, unknown>>;
  /** Props for a FlywayConfig resource. */
  config: Record<string, unknown>;
}

/**
 * Create a GcpSecuredProject composite — returns props for a FlywayProject,
 * a GcpResolver, N Environment resources with `${googlesecrets.*}` credential
 * references, and a FlywayConfig.
 *
 * @example
 * ```ts
 * import { GcpSecuredProject } from "@intentius/chant-lexicon-flyway";
 *
 * const { project, gcpResolver, environments, config } = GcpSecuredProject({
 *   name: "orders-db",
 *   databaseType: "postgresql",
 *   gcpProject: "my-gcp-project-123",
 *   environments: [
 *     { name: "staging", url: "jdbc:postgresql://staging:5432/orders" },
 *     { name: "prod", url: "jdbc:postgresql://prod:5432/orders" },
 *   ],
 * });
 *
 * export { project, gcpResolver, environments, config };
 * ```
 */
export function GcpSecuredProject(props: GcpSecuredProjectProps): GcpSecuredProjectResult {
  const {
    name,
    databaseType,
    gcpProject,
    environments: envEntries,
    schemas = ["public"],
    locations = ["filesystem:sql"],
  } = props;

  const project: Record<string, unknown> = {
    name,
  };

  const gcpResolver: Record<string, unknown> = {
    projectId: gcpProject,
  };

  const environments: Record<string, Record<string, unknown>> = {};
  for (const entry of envEntries) {
    const userSecret = entry.userSecret ?? `${name}-${entry.name}-db-user`;
    const passwordSecret = entry.passwordSecret ?? `${name}-${entry.name}-db-password`;

    environments[entry.name] = {
      name: entry.name,
      url: entry.url,
      user: `\${googlesecrets.${userSecret}}`,
      password: `\${googlesecrets.${passwordSecret}}`,
      schemas: entry.schemas ?? schemas,
    };
  }

  const config: Record<string, unknown> = {
    defaultSchema: schemas[0],
    locations,
    databaseType,
    validateMigrationNaming: true,
  };

  return { project, gcpResolver, environments, config };
}
