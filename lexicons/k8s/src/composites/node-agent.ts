/**
 * NodeAgent composite — DaemonSet + ServiceAccount + ClusterRole + ClusterRoleBinding + optional ConfigMap.
 *
 * A higher-level construct for per-node agents (Fluentd, Prometheus Node Exporter,
 * security scanners) that need cluster-wide RBAC and tolerations.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, ConfigMap } from "../generated";
import type { ContainerSecurityContext } from "./security-context";

export interface NodeAgentProps {
  /** Agent name — used in metadata and labels. */
  name: string;
  /** Container image. */
  image: string;
  /** Metrics port (optional). */
  port?: number;
  /** Host path mounts. */
  hostPaths?: Array<{
    name: string;
    hostPath: string;
    mountPath: string;
    readOnly?: boolean;
  }>;
  /** Config data — creates a ConfigMap mounted at /etc/{name}/. */
  config?: Record<string, string>;
  /** ClusterRole RBAC rules (required). */
  rbacRules: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
  /** Tolerate all taints so agent runs on every node (default: true). */
  tolerateAllTaints?: boolean;
  /** Namespace for namespaced resources (DaemonSet, ServiceAccount, ConfigMap). */
  namespace?: string;
  /** Additional labels to apply to all resources. */
  labels?: Record<string, string>;
  /** CPU request (default: "50m"). */
  cpuRequest?: string;
  /** Memory request (default: "64Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "200m"). */
  cpuLimit?: string;
  /** Memory limit (default: "128Mi"). */
  memoryLimit?: string;
  /** Environment variables for the container. */
  env?: Array<{ name: string; value: string }>;
  /** Container security context (supports PSS restricted fields). */
  securityContext?: ContainerSecurityContext;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    daemonSet?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
  };
}

export interface NodeAgentResult {
  daemonSet: InstanceType<typeof DaemonSet>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
  configMap?: InstanceType<typeof ConfigMap>;
}

/**
 * Create a NodeAgent composite — returns prop objects for
 * a DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, and optional ConfigMap.
 *
 * @example
 * ```ts
 * import { NodeAgent } from "@intentius/chant-lexicon-k8s";
 *
 * const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding } = NodeAgent({
 *   name: "log-collector",
 *   image: "fluentd:v1.16",
 *   hostPaths: [{ name: "varlog", hostPath: "/var/log", mountPath: "/var/log" }],
 *   rbacRules: [
 *     { apiGroups: [""], resources: ["pods", "namespaces"], verbs: ["get", "list", "watch"] },
 *   ],
 * });
 * ```
 */
export const NodeAgent = Composite<NodeAgentProps>((props) => {
  const {
    name,
    image,
    port,
    hostPaths = [],
    config,
    rbacRules,
    tolerateAllTaints = true,
    namespace,
    cpuRequest = "50m",
    memoryRequest = "64Mi",
    cpuLimit = "200m",
    memoryLimit = "128Mi",
    labels: extraLabels = {},
    env,
    securityContext,
    defaults: defs,
  } = props;

  const saName = `${name}-sa`;
  const clusterRoleName = `${name}-role`;
  const bindingName = `${name}-binding`;
  const configMapName = `${name}-config`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // Build volumes and volumeMounts from hostPaths
  const volumes: Array<Record<string, unknown>> = [];
  const volumeMounts: Array<Record<string, unknown>> = [];

  for (const hp of hostPaths) {
    volumes.push({
      name: hp.name,
      hostPath: { path: hp.hostPath },
    });
    volumeMounts.push({
      name: hp.name,
      mountPath: hp.mountPath,
      readOnly: hp.readOnly !== false,
    });
  }

  // ConfigMap volume
  if (config) {
    volumes.push({
      name: "config",
      configMap: { name: configMapName },
    });
    volumeMounts.push({
      name: "config",
      mountPath: `/etc/${name}`,
      readOnly: true,
    });
  }

  const container: Record<string, unknown> = {
    name,
    image,
    ...(port && { ports: [{ containerPort: port, name: "metrics" }] }),
    resources: {
      requests: { cpu: cpuRequest, memory: memoryRequest },
      limits: { cpu: cpuLimit, memory: memoryLimit },
    },
    ...(env && { env }),
    ...(volumeMounts.length > 0 && { volumeMounts }),
    ...(securityContext && { securityContext }),
  };

  const podSpec: Record<string, unknown> = {
    serviceAccountName: saName,
    containers: [container],
    ...(volumes.length > 0 && { volumes }),
    ...(tolerateAllTaints && {
      tolerations: [{ operator: "Exists" }],
    }),
  };

  const daemonSet = new DaemonSet(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
    },
    spec: {
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: podSpec,
      },
    },
  }, defs?.daemonSet));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    metadata: {
      name: saName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
    },
  }, defs?.serviceAccount));

  // ClusterRole — cluster-scoped, no namespace
  const clusterRole = new ClusterRole(mergeDefaults({
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: rbacRules,
  }, defs?.clusterRole));

  // ClusterRoleBinding — cluster-scoped, no namespace
  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    metadata: {
      name: bindingName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRoleName,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: saName,
        ...(namespace && { namespace }),
      },
    ],
  }, defs?.clusterRoleBinding));

  const result: Record<string, any> = {
    daemonSet,
    serviceAccount,
    clusterRole,
    clusterRoleBinding,
  };

  if (config) {
    result.configMap = new ConfigMap(mergeDefaults({
      metadata: {
        name: configMapName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
      },
      data: config,
    }, defs?.configMap));
  }

  return result;
}, "NodeAgent");
