/**
 * k3d composite validation helper.
 *
 * Imports each composite, creates k3d-safe instances, serializes via
 * k8sSerializer, and outputs YAML to stdout in dependency order.
 *
 * Usage: bun run scripts/k3d-composite-helper.ts
 */
import { AutoscaledService } from "../src/composites/autoscaled-service";
import { WorkerPool } from "../src/composites/worker-pool";
import { NamespaceEnv } from "../src/composites/namespace-env";
import { NodeAgent } from "../src/composites/node-agent";

/**
 * Wrap a plain props object into a minimal Declarable-like shape
 * that the serializer can consume. Since composites return raw prop bags
 * (not class instances), we emit YAML directly using simple serialization.
 */
function toYAMLDoc(apiVersion: string, kind: string, props: Record<string, unknown>): string {
  // Build the K8s manifest by adding apiVersion + kind, then spreading the composite's props.
  // Composites already return the correct structure (metadata, spec, rules, etc.)
  const manifest: Record<string, unknown> = {
    apiVersion,
    kind,
  };

  // Copy all props into the manifest in the right order
  for (const [key, value] of Object.entries(props)) {
    manifest[key] = value;
  }

  return serializeToYAML(manifest);
}

function serializeToYAML(obj: unknown, indent = 0): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") {
    // Quote strings that could be confused with other YAML types
    if (/^[0-9]/.test(obj) || obj === "true" || obj === "false" || obj === "null" || obj === "" || obj.includes(":") || obj.includes("#") || obj.includes("\n")) {
      return JSON.stringify(obj);
    }
    return obj;
  }
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);

  const prefix = "  ".repeat(indent);
  const childPrefix = "  ".repeat(indent + 1);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of obj) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length > 0) {
          const renderVal = (v: unknown): string => {
            if (Array.isArray(v)) return serializeToYAML(v, indent + 2);
            if (typeof v === "object" && v !== null) return "\n" + serializeObject(v as Record<string, unknown>, indent + 2);
            return " " + serializeToYAML(v, indent + 2);
          };
          const [firstKey, firstVal] = entries[0];
          lines.push(`${prefix}- ${firstKey}:${renderVal(firstVal)}`);
          for (let i = 1; i < entries.length; i++) {
            const [k, v] = entries[i];
            lines.push(`${childPrefix}${k}:${renderVal(v)}`);
          }
        } else {
          lines.push(`${prefix}- {}`);
        }
      } else {
        lines.push(`${prefix}- ${serializeToYAML(item, indent + 1)}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof obj === "object") {
    return "\n" + serializeObject(obj as Record<string, unknown>, indent);
  }

  return String(obj);
}

function serializeObject(obj: Record<string, unknown>, indent: number): string {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${prefix}${key}: []`);
      } else {
        lines.push(`${prefix}${key}:${serializeToYAML(value, indent + 1)}`);
      }
    } else if (typeof value === "object" && value !== null) {
      if (Object.keys(value as object).length === 0) {
        lines.push(`${prefix}${key}: {}`);
      } else {
        lines.push(`${prefix}${key}:${serializeToYAML(value, indent + 1)}`);
      }
    } else {
      lines.push(`${prefix}${key}: ${serializeToYAML(value, indent + 1)}`);
    }
  }
  return lines.join("\n");
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

// 2. AutoscaledService — nginx with autoscaling
const autoscaled = AutoscaledService({
  name: "autoscaled-svc",
  image: "nginx:1.25",
  port: 80,
  minReplicas: 1,
  maxReplicas: 3,
  targetCPUPercent: 70,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
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
docs.push(toYAMLDoc("v1", "ServiceAccount", worker.serviceAccount));
docs.push(toYAMLDoc("v1", "ServiceAccount", agent.serviceAccount));

// 3. ConfigMaps
if (worker.configMap) docs.push(toYAMLDoc("v1", "ConfigMap", worker.configMap));

// 4. ClusterRole/ClusterRoleBinding (NodeAgent)
docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "ClusterRole", agent.clusterRole));
docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "ClusterRoleBinding", agent.clusterRoleBinding));

// 5. Role/RoleBinding (WorkerPool)
docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "Role", worker.role));
docs.push(toYAMLDoc("rbac.authorization.k8s.io/v1", "RoleBinding", worker.roleBinding));

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
