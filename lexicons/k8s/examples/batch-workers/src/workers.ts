// WorkerPool: queue consumer with autoscaling, config, and RBAC.

import { WorkerPool } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "batch-workers";

const worker = WorkerPool({
  name: "queue-worker",
  image: "busybox:1.36",
  command: ["sh", "-c", "echo Processing; sleep 3600"],
  namespace: NAMESPACE,
  config: { REDIS_URL: "redis://redis:6379", CONCURRENCY: "4" },
  rbacRules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }],
  autoscaling: { minReplicas: 2, maxReplicas: 10, targetCPUPercent: 75 },
  minAvailable: 1,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  cpuLimit: "1",
  memoryLimit: "512Mi",
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  },
});

export const workerDeployment = worker.deployment;
export const workerSa = worker.serviceAccount!;
export const workerRole = worker.role!;
export const workerRoleBinding = worker.roleBinding!;
export const workerConfigMap = worker.configMap!;
export const workerHpa = worker.hpa!;
export const workerPdb = worker.pdb!;
