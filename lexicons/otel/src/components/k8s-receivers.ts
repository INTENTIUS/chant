/**
 * Built-in Kubernetes receivers: k8s_cluster (cluster-level object metrics,
 * one instance per cluster) and kubeletstats (node, pod and container
 * resource metrics from each node's kubelet, one instance per node).
 */

import { defineBuiltin } from "../define";
import type { K8sClusterReceiverSchemaConfig, KubeletStatsReceiverSchemaConfig } from "../generated/index";

/** How a receiver authenticates to the Kubernetes API or the kubelet. */
export type K8sAuthType = "none" | "serviceAccount" | "kubeConfig" | "tls";

/** Turns one generated metric or resource attribute on or off. */
export interface MetricToggle {
  enabled: boolean;
}

// ── k8s_cluster ──────────────────────────────────────────────────────

export type K8sAllocatableType = "cpu" | "memory" | "ephemeral-storage" | "storage" | "pods";

export type K8sNodeCondition = "Ready" | "MemoryPressure" | "DiskPressure" | "PIDPressure" | "NetworkUnavailable";

export type K8sClusterReceiverConfig = K8sClusterReceiverSchemaConfig;

/**
 * Cluster-level metrics and entity events from the Kubernetes API. Run one
 * instance per cluster (a single-replica Deployment, or behind
 * `k8s_leader_elector`); on every node it reports each object once per node.
 */
export const K8sClusterReceiver = defineBuiltin<K8sClusterReceiverConfig, "receiver", "k8s_cluster">({
  kind: "receiver",
  type: "k8s_cluster",
  description: "Cluster-level metrics from the Kubernetes API; run one instance per cluster",
  validate: (c) =>
    c.distribution !== undefined && c.distribution !== "kubernetes" && c.distribution !== "openshift"
      ? [`distribution "${String(c.distribution)}" is not kubernetes or openshift`]
      : [],
});

// ── kubeletstats ─────────────────────────────────────────────────────

export type KubeletMetricGroup = "container" | "pod" | "node" | "volume";

export type KubeletStatsReceiverConfig = KubeletStatsReceiverSchemaConfig;

/** Node, pod, container and volume resource metrics from the local kubelet. Run one instance per node. */
export const KubeletStatsReceiver = defineBuiltin<KubeletStatsReceiverConfig, "receiver", "kubeletstats">({
  kind: "receiver",
  type: "kubeletstats",
  description: "Node, pod and container resource metrics from the kubelet; run one instance per node",
  validate: (c) => {
    const problems: string[] = [];
    if ((c.auth_type ?? "tls") === "tls" && (!c.cert_file || !c.key_file)) {
      problems.push(
        `auth_type ${c.auth_type ? "tls" : "defaults to tls, which"} needs cert_file and key_file; in a pod set auth_type: serviceAccount`,
      );
    }
    if (c.metric_groups !== undefined && c.metric_groups.length === 0) {
      problems.push("metric_groups is empty, so no kubelet metric is collected");
    }
    return problems;
  },
  endpoints: (c) => (c.endpoint ? [c.endpoint] : []),
});
