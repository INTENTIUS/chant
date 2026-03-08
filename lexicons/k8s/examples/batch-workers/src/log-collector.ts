// NodeAgent: per-node log collector with hostPaths, config, and cluster-wide RBAC.

import { NodeAgent } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "batch-workers";

const agent = NodeAgent({
  name: "log-collector",
  image: "busybox:1.36",
  port: 9100,
  namespace: NAMESPACE,
  hostPaths: [
    { name: "varlog", hostPath: "/var/log", mountPath: "/var/log", readOnly: true },
    { name: "containers", hostPath: "/var/lib/docker/containers", mountPath: "/var/lib/docker/containers", readOnly: true },
  ],
  config: { "fluent.conf": "[INPUT]\n    Name tail\n    Path /var/log/containers/*.log" },
  rbacRules: [{ apiGroups: [""], resources: ["pods", "namespaces", "nodes"], verbs: ["get", "list", "watch"] }],
  tolerateAllTaints: true,
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  },
});

export const logDaemonSet = agent.daemonSet;
export const logSa = agent.serviceAccount;
export const logClusterRole = agent.clusterRole;
export const logClusterRoleBinding = agent.clusterRoleBinding;
export const logConfigMap = agent.configMap!;
