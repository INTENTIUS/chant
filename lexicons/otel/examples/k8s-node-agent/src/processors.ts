/**
 * A per-node agent config for Kubernetes, one file per concern: host metrics
 * and container logs from the node, OTLP from pods, Kubernetes metadata on
 * everything, metrics served for Prometheus to scrape, and traces and logs
 * forwarded to a gateway. This file: the processors.
 */
import {
  MemoryLimiterProcessor,
  K8sAttributesProcessor,
  ResourceDetectionProcessor,
  ResourceProcessor,
  AttributesProcessor,
  BatchProcessor,
  type K8sAttributesProcessorConfig,
  type AttributeAction,
} from "@intentius/chant-lexicon-otel";

const memoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_mib: 400, spike_limit_mib: 100 });

const thisNode: K8sAttributesProcessorConfig["filter"] = { node_from_env_var: "K8S_NODE_NAME" };
const podMetadata: K8sAttributesProcessorConfig["extract"] = {
  metadata: ["k8s.namespace.name", "k8s.pod.name", "k8s.deployment.name", "k8s.node.name"],
  labels: [{ tag_name: "app", key: "app.kubernetes.io/name", from: "pod" }],
};
const byPodIp: K8sAttributesProcessorConfig["pod_association"] = [
  { sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }] },
  { sources: [{ from: "connection" }] },
];
const k8sMetadata = new K8sAttributesProcessor({
  auth_type: "serviceAccount",
  filter: thisNode,
  extract: podMetadata,
  pod_association: byPodIp,
});

const detect = new ResourceDetectionProcessor({ detectors: ["env", "system"], timeout: "5s", override: false });

const clusterName: AttributeAction = { key: "k8s.cluster.name", value: "prod-eu-1", action: "upsert" };
const cluster = new ResourceProcessor({ attributes: [clusterName] });

/** Drop request bodies some SDKs attach to spans, and hash user emails. */
const dropBody: AttributeAction = { key: "http.request.body", action: "delete" };
const hashEmail: AttributeAction = { key: "user.email", action: "hash" };
const redact = new AttributesProcessor({ actions: [dropBody, hashEmail] });

const batch = new BatchProcessor({ timeout: "10s" });

export { memoryLimiter, k8sMetadata, detect, cluster, redact, batch };
