/**
 * k3d composite validation helper.
 *
 * Imports each composite, creates k3d-safe instances, serializes via
 * emitYAML from @intentius/chant/yaml, and outputs YAML to stdout in dependency order.
 *
 * Usage: npx tsx scripts/k3d-composite-helper.ts
 */
import { emitYAML } from "@intentius/chant/yaml";
import { AutoscaledService } from "../src/composites/autoscaled-service";
import { WorkerPool } from "../src/composites/worker-pool";
import { NamespaceEnv } from "../src/composites/namespace-env";
import { NodeAgent } from "../src/composites/node-agent";

/**
 * Wrap a plain props object into a K8s manifest and emit as YAML.
 */
function toYAMLDoc(apiVersion: string, kind: string, props: Record<string, unknown>): string {
  const manifest: Record<string, unknown> = { apiVersion, kind };
  for (const [key, value] of Object.entries(props)) {
    manifest[key] = value;
  }
  return emitYAML(manifest, 0).replace(/^\n/, "");
}

// --- Create composite instances with k3d-safe parameters ---

const NS = "composite-test";

// 1. NamespaceEnv — creates the namespace first
const nsEnv = NamespaceEnv({
  name: NS,
  cpuQuota: "4",
  memoryQuota: "8Gi",
  maxPods: 100,
  defaultCpuRequest: "50m",
  defaultMemoryRequest: "64Mi",
  defaultCpuLimit: "500m",
  defaultMemoryLimit: "256Mi",
  defaultDenyIngress: true,
  defaultDenyEgress: false,
});

// 2. AutoscaledService — nginx with autoscaling (nginx doesn't serve /healthz)
const autoscaled = AutoscaledService({
  name: "autoscaled-svc",
  image: "nginx:1.25",
  port: 80,
  minReplicas: 1,
  maxReplicas: 3,
  targetCPUPercent: 70,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  livenessPath: "/",
  readinessPath: "/",
  namespace: NS,
});

// 3. WorkerPool — busybox sleeping worker
const worker = WorkerPool({
  name: "test-worker",
  image: "busybox:1.36",
  command: ["sleep", "3600"],
  replicas: 1,
  config: { QUEUE: "default", LOG_LEVEL: "info" },
  namespace: NS,
});

// 4. NodeAgent — busybox sleeping agent with /var/log mount
const agent = NodeAgent({
  name: "test-agent",
  image: "busybox:1.36",
  hostPaths: [{ name: "varlog", hostPath: "/var/log", mountPath: "/var/log" }],
  rbacRules: [
    { apiGroups: [""], resources: ["pods", "nodes"], verbs: ["get", "list", "watch"] },
  ],
  tolerateAllTaints: true,
  namespace: NS,
});

// --- Output YAML in dependency order ---

const docs: string[] = [];

// 1. Namespace
docs.push(toYAMLDoc("v1", "Namespace", nsEnv.namespace));

// 2. ServiceAccounts
if (worker.serviceAccount) docs.push(toYAMLDoc("v1", "ServiceAccount", worker.serviceAccount));
docs.push(toYAMLDoc("v1", "ServiceAccount", agent.serviceAccount));

// 3. ConfigMaps
if (worker.configMap) docs.push(toYAMLDoc("v1", "ConfigMap", worker.configMap));

// 4. ClusterRole/ClusterRoleBinding (NodeAgent)
docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "ClusterRole", agent.clusterRole));
docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "ClusterRoleBinding", agent.clusterRoleBinding));

// 5. Role/RoleBinding (WorkerPool)
if (worker.role) docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "Role", worker.role));
if (worker.roleBinding) docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "RoleBinding", worker.roleBinding));

// 6. ResourceQuota, LimitRange, NetworkPolicy (NamespaceEnv)
if (nsEnv.resourceQuota) docs.push(toYAMLDoc("v1", "ResourceQuota", nsEnv.resourceQuota));
if (nsEnv.limitRange) docs.push(toYAMLDoc("v1", "LimitRange", nsEnv.limitRange));
if (nsEnv.networkPolicy) docs.push(toYAMLDoc("networking.k8s.io/v1", "NetworkPolicy", nsEnv.networkPolicy));

// 7. Deployments / DaemonSet
docs.push(toYAMLDoc("apps/v1", "Deployment", autoscaled.deployment));
docs.push(toYAMLDoc("apps/v1", "Deployment", worker.deployment));
docs.push(toYAMLDoc("apps/v1", "DaemonSet", agent.daemonSet));

// 8. Service, HPA, PDB
docs.push(toYAMLDoc("v1", "Service", autoscaled.service));
docs.push(toYAMLDoc("autoscaling/v2", "HorizontalPodAutoscaler", autoscaled.hpa));
docs.push(toYAMLDoc("policy/v1", "PodDisruptionBudget", autoscaled.pdb));

// Output as multi-document YAML
console.log(docs.join("\n---\n"));
