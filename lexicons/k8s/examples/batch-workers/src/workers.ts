// WorkerPool: queue consumer with autoscaling, config, and RBAC.

import {
  Deployment,
  ServiceAccount,
  Role,
  RoleBinding,
  ConfigMap,
  HorizontalPodAutoscaler,
  PodDisruptionBudget,
  WorkerPool,
} from "@intentius/chant-lexicon-k8s";

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

export const workerDeployment = new Deployment(worker.deployment);
export const workerSa = new ServiceAccount(worker.serviceAccount!);
export const workerRole = new Role(worker.role!);
export const workerRoleBinding = new RoleBinding(worker.roleBinding!);
export const workerConfigMap = new ConfigMap(worker.configMap!);
export const workerHpa = new HorizontalPodAutoscaler(worker.hpa!);
export const workerPdb = new PodDisruptionBudget(worker.pdb!);
