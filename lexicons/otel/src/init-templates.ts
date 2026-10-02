/**
 * `chant init --lexicon otel` scaffolds.
 *
 * - default: OTLP in, `memory_limiter` and `batch`, traces to an OTLP
 *   backend and logs to `debug`, with a `health_check`.
 * - `k8s-agent`: the config a per-node agent runs as a Kubernetes DaemonSet
 *   (`NodeAgent`): OTLP from the node's pods, host metrics and container
 *   logs, Kubernetes metadata on all of it, traces and logs on to a gateway
 *   and metrics served for Prometheus to scrape on each node.
 * - `genai`: a collector for an agent service instrumented with the
 *   OpenTelemetry GenAI conventions (`genAiPipeline`): prompt and completion
 *   content removed, RED and token metrics and the conventions' client
 *   metrics derived from every GenAI span, traces to Tempo.
 *
 * Each template builds with the otel lexicon alone, which is all
 * `chant init --lexicon otel` installs.
 */
import type { InitTemplateSet } from "@intentius/chant/lexicon";

// ── default ────────────────────────────────────────────────────────────

const DEFAULT_COLLECTOR = `/**
 * A collector: OTLP in, batched, traces out to an OTLP backend and logs to
 * the collector's own output. \`chant build\` writes the config
 * \`otelcol --config\` reads.
 *
 * Nested settings are named consts typed with the lexicon's config types, so
 * each constructor stays flat.
 */
import {
  OtlpReceiver,
  MemoryLimiterProcessor,
  BatchProcessor,
  OtlpExporter,
  DebugExporter,
  HealthCheckExtension,
  Pipeline,
  type OtlpReceiverConfig,
  type TLSClientSettings,
  type QueueSettings,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = {
  grpc: { endpoint: "0.0.0.0:4317" },
  http: { endpoint: "0.0.0.0:4318" },
};
const otlp = new OtlpReceiver({ protocols });

const memoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const batch = new BatchProcessor({ timeout: "5s" });

// Point this at your tracing backend. \`otlp/backend\`: the instance name leaves room for a second otlp exporter.
const plaintext: TLSClientSettings = { insecure: true };
const queue: QueueSettings = { enabled: true, queue_size: 5000 };
const backend = new OtlpExporter({ name: "backend", endpoint: "tempo:4317", tls: plaintext, sending_queue: queue });

const debug = new DebugExporter({ verbosity: "basic" });

const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors: [memoryLimiter, batch], exporters: [backend] });
const logs = new Pipeline({ signal: "logs", receivers: [otlp], processors: [memoryLimiter, batch], exporters: [debug] });

export { otlp, memoryLimiter, batch, backend, debug, health, traces, logs };
`;

// ── k8s-agent ──────────────────────────────────────────────────────────

const AGENT_EXPORTERS = `/**
 * Where the agent sends what it collects: traces and logs to the gateway
 * collectors, metrics served on each node for Prometheus to scrape.
 */
import { OtlpExporter, PrometheusExporter, type RetrySettings, type TLSClientSettings } from "@intentius/chant-lexicon-otel";

// The gateway Service. With the k8s lexicon's OtelCollectorGateway, use its gatewayExporter() instead.
const inCluster: TLSClientSettings = { insecure: true };
const retry: RetrySettings = { enabled: true, max_elapsed_time: "300s" };
const gateway = new OtlpExporter({ name: "gateway", endpoint: "otel-gateway.observability.svc:4317", tls: inCluster, retry_on_failure: retry });

// Resource attributes (k8s.namespace.name, k8s.pod.name, ...) become metric labels.
const asLabels = { enabled: true };
const scrape = new PrometheusExporter({ endpoint: "0.0.0.0:8889", resource_to_telemetry_conversion: asLabels });

export { gateway, scrape };
`;

const AGENT = `/**
 * The config each node's collector runs. The pod needs the node name in
 * K8S_NODE_NAME (from spec.nodeName), the host root mounted read-only at
 * /hostfs, /var/log/pods mounted read-only, and a service account that can
 * read pods, namespaces, nodes and replicasets (and nodes/stats, for kubelet
 * stats). Pass \`Object.values(agent.members)\` as the k8s lexicon's
 * OtelCollector \`config\` to run it as a DaemonSet: it adds all of these,
 * worked out from the config.
 */
import { NodeAgent } from "@intentius/chant-lexicon-otel";
import { gateway, scrape } from "./exporters";

export const agent = NodeAgent({
  exporters: [gateway],
  metricExporters: [scrape],
  clusterName: "my-cluster",
  kubeletStats: true,
});
`;

// ── genai ──────────────────────────────────────────────────────────────

const GENAI_COLLECTOR = `/**
 * A collector for an agent service instrumented with the OpenTelemetry GenAI
 * conventions. Prompts, completions and tool payloads are removed before
 * anything leaves the collector. Every GenAI span also becomes call, error,
 * duration and token metrics, and the conventions' own client metrics
 * (gen_ai.client.operation.duration, gen_ai.client.token.usage), served for
 * Prometheus to scrape. Traces go to Tempo.
 */
import { genAiPipeline, OtlpExporter, PrometheusExporter, type TLSClientSettings } from "@intentius/chant-lexicon-otel";

const plaintext: TLSClientSettings = { insecure: true };
const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: plaintext });

const prometheus = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });

// Content stays out unless keepContent: true is set here. Card-number-like values are masked in whatever is left.
const cardNumbers = ["\\\\b[0-9]{13,16}\\\\b"];

export const collector = genAiPipeline({
  traceExporters: [tempo],
  metricExporters: [prometheus],
  clientMetrics: "derive",
  maskValues: cardNumbers,
});
`;

export const DEFAULT_TEMPLATE: InitTemplateSet = {
  src: { "collector.ts": DEFAULT_COLLECTOR },
};

export const K8S_AGENT_TEMPLATE: InitTemplateSet = {
  src: { "exporters.ts": AGENT_EXPORTERS, "agent.ts": AGENT },
};

export const GENAI_TEMPLATE: InitTemplateSet = {
  src: { "collector.ts": GENAI_COLLECTOR },
};

/** The template names `chant init --lexicon otel --template <name>` takes, besides the default. */
export const TEMPLATE_NAMES = ["k8s-agent", "genai"] as const;
