// K8s workloads: Azure Monitor Collector for metrics, traces, and logs.

import {
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

export const monitorDaemonSet = monitor.daemonSet;
export const monitorClusterRole = monitor.clusterRole;
export const monitorClusterRoleBinding = monitor.clusterRoleBinding;
export const monitorConfig = monitor.configMap;
export const monitorServiceAccount = monitor.serviceAccount;
