// K8s workloads: GKE Fluent Bit + OTel Collector for Cloud Logging and Monitoring.

import {
  DaemonSet,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  ConfigMap,
  Namespace,
  GkeFluentBitAgent,
  GkeOtelCollector,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// ── Agent Namespaces ─────────────────────────────────────────────

export const loggingNamespace = new Namespace({
  metadata: { name: "gke-logging", labels: { "app.kubernetes.io/managed-by": "chant" } },
});

export const monitoringNamespace = new Namespace({
  metadata: { name: "gke-monitoring", labels: { "app.kubernetes.io/managed-by": "chant" } },
});

// ── Fluent Bit (Cloud Logging) ───────────────────────────────────

const fb = GkeFluentBitAgent({
  clusterName: config.clusterName,
  projectId: config.projectId,
  gcpServiceAccountEmail: config.fluentBitGsaEmail,
});

export const fbDaemonSet = new DaemonSet(fb.daemonSet);
export const fbClusterRole = new ClusterRole(fb.clusterRole);
export const fbClusterRoleBinding = new ClusterRoleBinding(fb.clusterRoleBinding);
export const fbConfig = new ConfigMap(fb.configMap);
export const fbServiceAccount = new ServiceAccount(fb.serviceAccount);

// ── OTel Collector (Cloud Trace + Cloud Monitoring) ──────────────

const otel = GkeOtelCollector({
  clusterName: config.clusterName,
  projectId: config.projectId,
  gcpServiceAccountEmail: config.otelGsaEmail,
});

export const otelDaemonSet = new DaemonSet(otel.daemonSet);
export const otelClusterRole = new ClusterRole(otel.clusterRole);
export const otelClusterRoleBinding = new ClusterRoleBinding(otel.clusterRoleBinding);
export const otelConfig = new ConfigMap(otel.configMap);
export const otelServiceAccount = new ServiceAccount(otel.serviceAccount);
