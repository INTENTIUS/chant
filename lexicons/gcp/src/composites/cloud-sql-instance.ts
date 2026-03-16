/**
 * CloudSqlInstance composite — SQLInstance + SQLDatabase + SQLUser.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { SQLInstance, SQLDatabase, SQLUser } from "../generated";

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
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    instance?: Partial<ConstructorParameters<typeof SQLInstance>[0]>;
    database?: Partial<ConstructorParameters<typeof SQLDatabase>[0]>;
    user?: Partial<ConstructorParameters<typeof SQLUser>[0]>;
  };
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
export const CloudSqlInstance = Composite<CloudSqlInstanceProps>((props) => {
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
    defaults: defs,
  } = props;

  // K8s metadata name must be a valid DNS subdomain (no underscores).
  // When databaseName differs from the instance name, prefix with instance name
  // to guarantee uniqueness across instances sharing the same databaseName.
  const sanitizedDbName = databaseName.replace(/_/g, "-");
  const databaseK8sName = databaseName === name ? sanitizedDbName : `${name}-${sanitizedDbName}`;

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

  const instance = new SQLInstance(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    databaseVersion,
    ...(region && { region }),
    settings,
  } as Record<string, unknown>, defs?.instance));

  const database = new SQLDatabase(mergeDefaults({
    metadata: {
      name: databaseK8sName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "database" },
    },
    instanceRef: { name },
    // resourceID sets the actual Cloud SQL database name when the K8s-safe name differs
    ...(databaseName !== sanitizedDbName && { resourceID: databaseName }),
  } as Record<string, unknown>, defs?.database));

  const user = new SQLUser(mergeDefaults({
    metadata: {
      // K8s name scoped to the instance for uniqueness (e.g. "mydb-admin").
      // Without resourceID, Config Connector uses metadata.name as the actual
      // Cloud SQL username — so the PG username IS the K8s resource name.
      // Callers can override via defaults.user.resourceID if a shorter name is needed.
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
  } as Record<string, unknown>, defs?.user));

  return { instance, database, user };
}, "CloudSqlInstance");
