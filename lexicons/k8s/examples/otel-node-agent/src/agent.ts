/**
 * A per-node OpenTelemetry Collector agent that reads its node.
 *
 * The otel lexicon's NodeAgent declares the config: OTLP from the node's
 * pods, host metrics from the host root at /hostfs, container logs from
 * /var/log/pods, kubelet stats, and Kubernetes metadata from a k8sattributes
 * processor filtered to this node. OtelCollector runs it as a DaemonSet and
 * reads back from the config what the pod needs: K8S_NODE_NAME from
 * spec.nodeName, the host root and /var/log/pods mounted read-only, group 0
 * to read the root-owned log files, and nodes/stats for kubeletstats.
 *
 * Everything goes to the debug exporter here, so `kubectl logs` shows what
 * the agent collected. In a real cluster, pass a gateway or backend
 * exporter instead (see the otel-gateway example).
 */
import { OtelCollector } from "@intentius/chant-lexicon-k8s";
import { DebugExporter, NodeAgent } from "@intentius/chant-lexicon-otel";

const debug = new DebugExporter({ verbosity: "detailed" });

const agent = NodeAgent({ exporters: [debug], clusterName: "example", kubeletStats: true });

export const collector = OtelCollector({ config: Object.values(agent.members) });
