/**
 * Cloud SQL PostgreSQL instance with database, user, and private networking.
 */

import {
  SQLInstance, SQLDatabase, SQLUser,
  ComputeAddress,
  GCP, defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const dbInstance = new SQLInstance({
  metadata: {
    name: "app-db",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  databaseVersion: "POSTGRES_15",
  settings: {
    tier: "db-custom-2-7680",
    diskSize: 20,
    diskAutoresize: true,
    availabilityType: "REGIONAL",
    backupConfiguration: {
      enabled: true,
      startTime: "03:00",
    },
  },
});

export const database = new SQLDatabase({
  metadata: {
    name: "appdata",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  instanceRef: { name: "app-db" },
});

export const dbUser = new SQLUser({
  metadata: {
    name: "app-db-appuser",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  instanceRef: { name: "app-db" },
  password: {
    valueFrom: {
      secretKeyRef: {
        name: "app-db-db-password",
        key: "password",
      },
    },
  },
});

export const privateIpRange = new ComputeAddress({
  metadata: {
    name: "sql-private-ip-range",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  location: GCP.Region,
  addressType: "INTERNAL",
  purpose: "VPC_PEERING",
  prefixLength: 16,
  networkRef: { name: "default" },
});
