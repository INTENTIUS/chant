/**
 * NodeAgent composite — DaemonSet + ServiceAccount + ClusterRole + ClusterRoleBinding + optional ConfigMap.
 *
 * A higher-level construct for per-node agents (Fluentd, Prometheus Node Exporter,
 * security scanners) that need cluster-wide RBAC and tolerations.
 */

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
}

export interface NodeAgentResult {
  daemonSet: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  clusterRole: Record<string, unknown>;
  clusterRoleBinding: Record<string, unknown>;
  configMap?: Record<string, unknown>;
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
export function NodeAgent(props: NodeAgentProps): NodeAgentResult {
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

  const daemonSetProps: Record<string, unknown> = {
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
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name: saName,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
    },
  };

  // ClusterRole — cluster-scoped, no namespace
  const clusterRoleProps: Record<string, unknown> = {
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: rbacRules,
  };

  // ClusterRoleBinding — cluster-scoped, no namespace
  const clusterRoleBindingProps: Record<string, unknown> = {
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
  };

  const result: NodeAgentResult = {
    daemonSet: daemonSetProps,
    serviceAccount: serviceAccountProps,
    clusterRole: clusterRoleProps,
    clusterRoleBinding: clusterRoleBindingProps,
  };

  if (config) {
    result.configMap = {
      metadata: {
        name: configMapName,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
      },
      data: config,
    };
  }

  return result;
}
