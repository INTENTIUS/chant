/**
 * `NodeAgent`: the collector config a per-node agent runs on Kubernetes.
 *
 * One collector per node (a DaemonSet) takes OTLP from the pods on its node,
 * reads the node's own telemetry, puts Kubernetes metadata on all of it, and
 * hands it on, usually to a gateway tier. This composite declares that
 * config:
 *
 * - receivers: `otlp` (gRPC on 4317, HTTP on 4318), and by default
 *   `hostmetrics` (CPU, memory, load, filesystem, network of the node, read
 *   under `/hostfs`) and `filelog` (container logs under `/var/log/pods`,
 *   parsed by the `container` operator). `kubeletstats` (pod and container
 *   resource metrics from the local kubelet) is opt-in.
 * - processors, in order: `memory_limiter`; `k8sattributes`, filtered to
 *   pods on this node and matching by pod IP, pod UID or the connection;
 *   `resourcedetection` (`env`, `system`); a `resource` processor setting
 *   `k8s.cluster.name` when `clusterName` is given; `batch`.
 * - a `traces`, a `metrics` and a `logs` pipeline, each through those
 *   processors to the given exporters.
 * - a `health_check` extension on 0.0.0.0:13133.
 *
 * Tail sampling is left out on purpose: an agent sees only its node's
 * spans of a trace, so a sampling decision there is made on partial traces.
 * Sample on the gateway.
 *
 * What the pod has to provide: the node name in an environment variable
 * (`K8S_NODE_NAME` by default, from `spec.nodeName`), the host root mounted
 * read-only at `/hostfs` for `hostmetrics`, `/var/log/pods` mounted
 * read-only for `filelog`, and a service account that may get, list and
 * watch pods, namespaces and nodes (and replicasets, for
 * `k8s.deployment.name`). The k8s lexicon's `OtelCollector` takes this
 * composite's entities as its `config` and derives the RBAC and ports from
 * them.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import type { Duration } from "../components/common";
import { OtlpReceiver, HostMetricsReceiver, FileLogReceiver, type HostMetricsReceiverConfig } from "../components/receivers";
import { KubeletStatsReceiver } from "../components/k8s-receivers";
import {
  BatchProcessor,
  K8sAttributesProcessor,
  MemoryLimiterProcessor,
  ResourceDetectionProcessor,
  ResourceProcessor,
  type K8sAttributesProcessorConfig,
} from "../components/processors";
import { HealthCheckExtension } from "../components/extensions";
import type { OTelComponent } from "../define";
import { Pipeline, type PipelineEntity } from "../pipeline";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exporter = OTelComponent<"exporter", string, any>;
type Component<K extends "receiver" | "processor" | "extension"> = OTelComponent<K, string, object>;

export interface NodeAgentProps {
  /**
   * Where traces and logs go: usually the gateway (the k8s lexicon's
   * `gatewayExporter()`), or an OTLP backend. Also where metrics go, unless
   * `metricExporters` is set.
   */
  exporters: Exporter[];
  /** Where metrics go, e.g. a `prometheus` exporter for a scrape on each node. Default: `exporters`. */
  metricExporters?: Exporter[];
  /** Sets `k8s.cluster.name` on everything the agent sends. */
  clusterName?: string;
  /** The environment variable holding this node's name, set from `spec.nodeName` (default `K8S_NODE_NAME`). */
  nodeNameEnv?: string;
  /** Node CPU, memory, load, filesystem and network from the host root at `/hostfs` (default: on, every 30s). */
  hostMetrics?: boolean | { interval?: Duration; rootPath?: string };
  /**
   * Container logs from `/var/log/pods` (default: on). The agent's own
   * container is left out so the agent doesn't read its own log lines; name
   * it with `selfContainer` (default `otel-collector`, the k8s
   * `OtelCollector`'s default).
   */
  containerLogs?: boolean | { selfContainer?: string };
  /** Pod and container resource metrics from this node's kubelet (default: off). The service account then needs get on `nodes/stats`. */
  kubeletStats?: boolean | { interval?: Duration };
  /** `memory_limiter`'s hard limit in MiB (default 400; the spike limit is a quarter of it). */
  memoryLimitMib?: number;
  /** Serve `health_check` on 0.0.0.0:13133 (default: on). */
  healthCheck?: boolean;
}

// A type alias, not an interface: a composite's members type needs the implicit index signature.
export type NodeAgentMembers = {
  otlp: Component<"receiver">;
  hostMetrics?: Component<"receiver">;
  containerLogs?: Component<"receiver">;
  kubeletStats?: Component<"receiver">;
  memoryLimiter: Component<"processor">;
  k8sAttributes: Component<"processor">;
  resourceDetection: Component<"processor">;
  cluster?: Component<"processor">;
  batch: Component<"processor">;
  health?: Component<"extension">;
  traces: PipelineEntity;
  metrics: PipelineEntity;
  logs: PipelineEntity;
};

export type NodeAgentInstance = CompositeInstance<NodeAgentMembers> & NodeAgentMembers;

const HOST_SCRAPERS: HostMetricsReceiverConfig["scrapers"] = { cpu: {}, memory: {}, load: {}, filesystem: {}, network: {} };

/** Pod metadata for every signal. `k8s.pod.uid` is what the `container` log parser sets on log records. */
const POD_METADATA: K8sAttributesProcessorConfig["extract"] = {
  metadata: ["k8s.namespace.name", "k8s.pod.name", "k8s.pod.uid", "k8s.deployment.name", "k8s.node.name"],
};
const POD_ASSOCIATION: K8sAttributesProcessorConfig["pod_association"] = [
  { sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }] },
  { sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] },
  { sources: [{ from: "connection" }] },
];

function option<T extends object>(value: boolean | T | undefined, onByDefault: boolean): T | undefined {
  if (value === undefined) return onByDefault ? ({} as T) : undefined;
  if (value === false) return undefined;
  return value === true ? ({} as T) : value;
}

/** Why a set of `NodeAgent` props can't build, or undefined when they can. */
export function nodeAgentPropsProblem(props: NodeAgentProps): string | undefined {
  if (!Array.isArray(props.exporters) || props.exporters.length === 0) return "exporters must name at least one exporter";
  if (props.metricExporters !== undefined && props.metricExporters.length === 0) return "metricExporters must name at least one exporter when set";
  if (props.memoryLimitMib !== undefined && !(Number.isInteger(props.memoryLimitMib) && props.memoryLimitMib > 0)) {
    return "memoryLimitMib must be a positive whole number";
  }
  if (props.nodeNameEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(props.nodeNameEnv)) {
    return `nodeNameEnv "${props.nodeNameEnv}" is not an environment variable name`;
  }
  return undefined;
}

/**
 * The collector config of a per-node Kubernetes agent: OTLP from the node's
 * pods, host metrics and container logs from the node itself, Kubernetes
 * metadata on everything, sent on to the given exporters.
 *
 * @example
 * ```ts
 * import { NodeAgent, OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * const gateway = new OtlpExporter({ name: "gateway", endpoint: "otel-gateway.observability.svc:4317", tls: { insecure: true } });
 * export const agent = NodeAgent({ exporters: [gateway], clusterName: "prod-eu-1" });
 * ```
 */
export const NodeAgent = Composite<NodeAgentProps, NodeAgentMembers>((props) => {
  const problem = nodeAgentPropsProblem(props);
  if (problem) throw new Error(`NodeAgent: ${problem}`);

  const nodeNameEnv = props.nodeNameEnv ?? "K8S_NODE_NAME";
  const limit = props.memoryLimitMib ?? 400;
  const host = option(props.hostMetrics, true);
  const logFiles = option(props.containerLogs, true);
  const kubelet = option(props.kubeletStats, false);

  const otlp = new OtlpReceiver({
    protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } },
  });
  const hostMetrics = host
    ? new HostMetricsReceiver({ collection_interval: host.interval ?? "30s", root_path: host.rootPath ?? "/hostfs", scrapers: HOST_SCRAPERS })
    : undefined;
  const containerLogs = logFiles
    ? new FileLogReceiver({
        include: ["/var/log/pods/*/*/*.log"],
        exclude: [`/var/log/pods/*/${logFiles.selfContainer ?? "otel-collector"}/*.log`],
        start_at: "end",
        include_file_path: true,
        operators: [{ type: "container", id: "container-parser" }],
      })
    : undefined;
  const kubeletStats = kubelet
    ? new KubeletStatsReceiver({
        collection_interval: kubelet.interval ?? "30s",
        auth_type: "serviceAccount",
        endpoint: `https://\${env:${nodeNameEnv}}:10250`,
        insecure_skip_verify: true,
        node: `\${env:${nodeNameEnv}}`,
      })
    : undefined;

  const memoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_mib: limit, spike_limit_mib: Math.ceil(limit / 4) });
  const k8sAttributes = new K8sAttributesProcessor({
    auth_type: "serviceAccount",
    filter: { node_from_env_var: nodeNameEnv },
    extract: POD_METADATA,
    pod_association: POD_ASSOCIATION,
  });
  const resourceDetection = new ResourceDetectionProcessor({ detectors: ["env", "system"], timeout: "5s", override: false });
  const cluster = props.clusterName
    ? new ResourceProcessor({ attributes: [{ key: "k8s.cluster.name", value: props.clusterName, action: "upsert" }] })
    : undefined;
  const batch = new BatchProcessor({ timeout: "10s" });
  const processors = [memoryLimiter, k8sAttributes, resourceDetection, ...(cluster ? [cluster] : []), batch];

  const exporters = props.exporters;
  const metricExporters = props.metricExporters ?? exporters;
  const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors, exporters });
  const metrics = new Pipeline({
    signal: "metrics",
    receivers: [otlp, ...(hostMetrics ? [hostMetrics] : []), ...(kubeletStats ? [kubeletStats] : [])],
    processors,
    exporters: metricExporters,
  });
  const logs = new Pipeline({ signal: "logs", receivers: [...(containerLogs ? [containerLogs] : []), otlp], processors, exporters });

  const health = props.healthCheck === false ? undefined : new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

  // A composite member must be a declarable, so the components that are off are left out rather than undefined.
  const members: NodeAgentMembers = { otlp, memoryLimiter, k8sAttributes, resourceDetection, batch, traces, metrics, logs };
  if (hostMetrics) members.hostMetrics = hostMetrics;
  if (containerLogs) members.containerLogs = containerLogs;
  if (kubeletStats) members.kubeletStats = kubeletStats;
  if (cluster) members.cluster = cluster;
  if (health) members.health = health;
  return members;
}, "NodeAgent");
