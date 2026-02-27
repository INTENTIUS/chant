/**
 * CloudSqlInstance composite — SQLInstance + SQLDatabase + SQLUser.
 */

export interface CloudSqlInstanceProps {
  /** Instance name. */
  name: string;
  /** Database version (default: "POSTGRES_15"). */
  databaseVersion?: string;
  /** Machine tier (default: "db-f1-micro"). */
  tier?: string;
  /** GCP region. */
  region?: string;
  /** Database name to create (default: same as instance name). */
  databaseName?: string;
  /** User name (default: "admin"). */
  userName?: string;
  /** Disk size in GB (default: 10). */
  diskSize?: number;
  /** Disk autoresize (default: true). */
  diskAutoresize?: boolean;
  /** Enable backups (default: true). */
  backupEnabled?: boolean;
  /** Enable high availability (default: false). */
  highAvailability?: boolean;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface CloudSqlInstanceResult {
  instance: Record<string, unknown>;
  database: Record<string, unknown>;
  user: Record<string, unknown>;
}

/**
 * Create a CloudSqlInstance composite.
 *
 * @example
 * ```ts
 * import { CloudSqlInstance } from "@intentius/chant-lexicon-gcp";
 *
 * const { instance, database, user } = CloudSqlInstance({
 *   name: "my-db",
 *   databaseVersion: "POSTGRES_15",
 *   tier: "db-custom-2-7680",
 * });
 * ```
 */
export function CloudSqlInstance(props: CloudSqlInstanceProps): CloudSqlInstanceResult {
  const {
    name,
    databaseVersion = "POSTGRES_15",
    tier = "db-f1-micro",
    region,
    databaseName = name,
    userName = "admin",
    diskSize = 10,
    diskAutoresize = true,
    backupEnabled = true,
    highAvailability = false,
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const settings: Record<string, unknown> = {
    tier,
    diskSize,
    diskAutoresize,
    ...(highAvailability && { availabilityType: "REGIONAL" }),
  };

  if (backupEnabled) {
    settings.backupConfiguration = {
      enabled: true,
      startTime: "03:00",
    };
  }

  const instance: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    databaseVersion,
    ...(region && { region }),
    settings,
  };

  const database: Record<string, unknown> = {
    metadata: {
      name: databaseName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    instanceRef: { name },
  };

  const user: Record<string, unknown> = {
    metadata: {
      name: `${name}-${userName}`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    instanceRef: { name },
    password: {
      valueFrom: {
        secretKeyRef: {
          name: `${name}-db-password`,
          key: "password",
        },
      },
    },
  };

  return { instance, database, user };
}
