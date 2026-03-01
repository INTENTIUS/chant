// BatchJob: one-shot data migration with retry and TTL.

import {
  Job,
  ServiceAccount,
  Role,
  RoleBinding,
  BatchJob,
} from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "batch-workers";

const migration = BatchJob({
  name: "data-migration",
  image: "busybox:1.36",
  command: ["sh", "-c", "echo Migrating; sleep 5"],
  namespace: NAMESPACE,
  backoffLimit: 3,
  ttlSecondsAfterFinished: 3600,
  rbacRules: [{ apiGroups: [""], resources: ["secrets", "configmaps"], verbs: ["get"] }],
  env: [{ name: "MIGRATION_VERSION", value: "42" }],
  cpuRequest: "250m",
  memoryRequest: "512Mi",
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  },
});

export const migrationJob = new Job(migration.job);
export const migrationSa = new ServiceAccount(migration.serviceAccount!);
export const migrationRole = new Role(migration.role!);
export const migrationRoleBinding = new RoleBinding(migration.roleBinding!);
