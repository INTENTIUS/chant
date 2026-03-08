// K8s workloads: GKE Fluent Bit + OTel Collector for Cloud Logging and Monitoring.

import {
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

export const fbDaemonSet = fb.daemonSet;
export const fbClusterRole = fb.clusterRole;
export const fbClusterRoleBinding = fb.clusterRoleBinding;
export const fbConfig = fb.configMap;
export const fbServiceAccount = fb.serviceAccount;

// ── OTel Collector (Cloud Trace + Cloud Monitoring) ──────────────

const otel = GkeOtelCollector({
  clusterName: config.clusterName,
  projectId: config.projectId,
  gcpServiceAccountEmail: config.otelGsaEmail,
});

export const otelDaemonSet = otel.daemonSet;
export const otelClusterRole = otel.clusterRole;
export const otelClusterRoleBinding = otel.clusterRoleBinding;
export const otelConfig = otel.configMap;
export const otelServiceAccount = otel.serviceAccount;
