// CronWorkload: nightly database cleanup with RBAC.

import { CronWorkload } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "batch-workers";

const cron = CronWorkload({
  name: "db-cleanup",
  image: "busybox:1.36",
  schedule: "0 2 * * *",
  command: ["sh", "-c", "echo Cleaning; sleep 10"],
  namespace: NAMESPACE,
  rbacRules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
    { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list"] },
  ],
  successfulJobsHistoryLimit: 3,
  failedJobsHistoryLimit: 2,
  env: [{ name: "RETENTION_DAYS", value: "90" }],
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  },
});

export const cronJob = cron.cronJob;
export const cronSa = cron.serviceAccount;
export const cronRole = cron.role;
export const cronRoleBinding = cron.roleBinding;
