// K8s workloads: Azure Monitor Collector for metrics, traces, and logs.

import {
  DaemonSet,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  ConfigMap,
  Namespace,
  AzureMonitorCollector,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// ── Agent Namespace ──────────────────────────────────────────────

export const monitorNamespace = new Namespace({
  metadata: { name: "azure-monitor", labels: { "app.kubernetes.io/managed-by": "chant" } },
});

// ── Azure Monitor Collector ──────────────────────────────────────

const monitor = AzureMonitorCollector({
  workspaceId: "placeholder-workspace-id",
  clusterName: config.clusterName,
  clientId: config.monitorClientId,
});

export const monitorDaemonSet = new DaemonSet(monitor.daemonSet);
export const monitorClusterRole = new ClusterRole(monitor.clusterRole);
export const monitorClusterRoleBinding = new ClusterRoleBinding(monitor.clusterRoleBinding);
export const monitorConfig = new ConfigMap(monitor.configMap);
export const monitorServiceAccount = new ServiceAccount(monitor.serviceAccount);
