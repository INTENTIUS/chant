/**
 * Cloud SQL PostgreSQL instance with database, user, and private networking.
 */

import { CloudSqlInstance, PrivateService, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const { instance, database, user } = CloudSqlInstance({
  name: "app-db",
  databaseVersion: "POSTGRES_15",
  tier: "db-custom-2-7680",
  databaseName: "appdata",
  userName: "appuser",
  diskSize: 20,
  diskAutoresize: true,
  backupEnabled: true,
  highAvailability: true,
});

export const { globalAddress, serviceConnection } = PrivateService({
  name: "sql-private",
  networkName: "default",
  prefixLength: 16,
});
