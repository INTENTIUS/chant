/**
 * Built-in Kubernetes receivers: k8s_cluster (cluster-level object metrics,
 * one instance per cluster) and kubeletstats (node, pod and container
 * resource metrics from each node's kubelet, one instance per node).
 */

import { defineBuiltin } from "../define";
import type { Duration } from "./common";

/** How a receiver authenticates to the Kubernetes API or the kubelet. */
export type K8sAuthType = "none" | "serviceAccount" | "kubeConfig" | "tls";

/** Turns one generated metric or resource attribute on or off. */
export interface MetricToggle {
  enabled: boolean;
}

// ── k8s_cluster ──────────────────────────────────────────────────────

export type K8sAllocatableType = "cpu" | "memory" | "ephemeral-storage" | "storage" | "pods";

export type K8sNodeCondition = "Ready" | "MemoryPressure" | "DiskPressure" | "PIDPressure" | "NetworkUnavailable";

export interface K8sClusterReceiverConfig {
  /** Default `serviceAccount`. */
  auth_type?: K8sAuthType;
  /** Default `10s`. */
  collection_interval?: Duration;
  /** Default `[Ready]`. */
  node_conditions_to_report?: Array<K8sNodeCondition | (string & {})>;
  allocatable_types_to_report?: K8sAllocatableType[];
  /** Default `kubernetes`. `openshift` adds cluster quota metrics. */
  distribution?: "kubernetes" | "openshift";
  /** Exporter ids that receive entity metadata updates. */
  metadata_exporters?: string[];
  metadata_collection_interval?: Duration;
  /** The id of a `k8s_leader_elector` extension, so only the leader among replicas collects. */
  k8s_leader_elector?: string;
  /** Watch one namespace instead of the whole cluster. */
  namespace?: string;
  metrics?: Record<string, MetricToggle>;
  resource_attributes?: Record<string, MetricToggle>;
}

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

export interface KubeletStatsReceiverConfig {
  /** Default `10s`. */
  collection_interval?: Duration;
  initial_delay?: Duration;
  /** Default `tls`, which needs `cert_file` and `key_file`. In a pod, use `serviceAccount`. */
  auth_type?: K8sAuthType;
  /** The kubelet, e.g. `https://${env:K8S_NODE_NAME}:10250`. */
  endpoint?: string;
  insecure_skip_verify?: boolean;
  ca_file?: string;
  cert_file?: string;
  key_file?: string;
  /** Default `[container, pod, node]`. */
  metric_groups?: KubeletMetricGroup[];
  /** Extra labels on container and volume metrics. */
  extra_metadata_labels?: Array<"container.id" | "k8s.volume.type">;
  /** Kubernetes API access, for persistent volume claim metadata. */
  k8s_api_config?: { auth_type: K8sAuthType; context?: string };
  /** The node name, for the limit and request utilization metrics; usually `${env:K8S_NODE_NAME}`. */
  node?: string;
  collect_all_network_interfaces?: { pod?: boolean; node?: boolean };
  metrics?: Record<string, MetricToggle>;
  resource_attributes?: Record<string, MetricToggle>;
}

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
