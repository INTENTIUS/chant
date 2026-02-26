/**
 * DockerDevEnvironment composite — Environment props with a Docker
 * provisioner and localhost JDBC URL.
 *
 * A higher-level construct for local development environments where
 * Flyway provisions a database container via Docker.
 */

/** Map of database types to their default ports. */
const DEFAULT_PORTS: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  oracle: 1521,
  cockroachdb: 26257,
};

/** Map of database types to their JDBC URL scheme. */
const JDBC_SCHEMES: Record<string, string> = {
  postgresql: "jdbc:postgresql",
  mysql: "jdbc:mysql",
  mariadb: "jdbc:mariadb",
  sqlserver: "jdbc:sqlserver",
  oracle: "jdbc:oracle:thin:@",
  cockroachdb: "jdbc:postgresql",
};

export interface DockerDevEnvironmentProps {
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /** Host port to expose (default: database-type-specific default port). */
  port?: number;
  /** Database name (default: "flyway_dev"). */
  dbName?: string;
  /** Environment name (default: "dev"). */
  name?: string;
  /** Docker image override (e.g., "postgres:16"). */
  dockerImage?: string;
  /** Schemas managed by Flyway (default: ["public"]). */
  schemas?: string[];
}

export interface DockerDevEnvironmentResult {
  /** Props for an Environment resource with Docker provisioner. */
  environment: Record<string, unknown>;
}

/**
 * Create a DockerDevEnvironment composite — returns props for an Environment
 * resource configured with a Docker provisioner and a localhost JDBC URL.
 *
 * @example
 * ```ts
 * import { DockerDevEnvironment } from "@intentius/chant-lexicon-flyway";
 *
 * const { environment } = DockerDevEnvironment({
 *   databaseType: "postgresql",
 *   port: 5433,
 *   dbName: "myapp_dev",
 * });
 *
 * export { environment };
 * ```
 */
export function DockerDevEnvironment(
  props: DockerDevEnvironmentProps,
): DockerDevEnvironmentResult {
  const {
    databaseType,
    dbName = "flyway_dev",
    name = "dev",
    dockerImage,
    schemas = ["public"],
  } = props;

  const port = props.port ?? DEFAULT_PORTS[databaseType] ?? 5432;
  const scheme = JDBC_SCHEMES[databaseType] ?? `jdbc:${databaseType}`;

  let url: string;
  if (databaseType === "sqlserver") {
    url = `${scheme}://localhost:${port};databaseName=${dbName};trustServerCertificate=true`;
  } else if (databaseType === "oracle") {
    url = `${scheme}localhost:${port}/${dbName}`;
  } else {
    url = `${scheme}://localhost:${port}/${dbName}`;
  }

  const environment: Record<string, unknown> = {
    displayName: name,
    url,
    schemas,
    provisioner: "docker",
    ...(dockerImage && { dockerImage }),
  };

  return { environment };
}
