/**
 * Fixtures shared by the import round-trip tests (roundtrip.test.ts) and the
 * type-check of the generated source (generated-types.e2e.test.ts).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { Declarable } from "@intentius/chant/declarable";
import { otelSerializer } from "../../serializer";
import { Pipeline, Service } from "../../pipeline";
import * as c from "../../components";

export const pkgDir = resolve(import.meta.dirname, "../../..");
export const repoRoot = resolve(pkgDir, "../..");
export const read = (...p: string[]) => readFileSync(join(import.meta.dirname, ...p), "utf-8");

export function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

/** Each otel example's `chant build` output. */
export async function exampleOutputs(): Promise<Array<[string, string]>> {
  const examplesDir = join(pkgDir, "examples");
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const srcDir = join(examplesDir, name, "src");
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const result = await build(srcDir, [otelSerializer]);
    if (result.errors.length > 0) throw new Error(`${name}: ${result.errors.map(String).join("; ")}`);
    out.push([name, primary(result.outputs.get("otel"))]);
  }
  return out;
}

export const UPSTREAM_BUILTIN_ONLY = [
  "kubernetes-filelog.yaml",
  "logline-filter-in.yaml",
  "logline-filter-out.yaml",
  "secure-tracing.yaml",
  "loadbalancing-backend.yaml",
];

/** One instance of every built-in, each using its typed fields, wired into pipelines the connectors accept. */
export function everyBuiltin(): Declarable[] {
  const otlp = new c.OtlpReceiver({
    protocols: {
      grpc: { endpoint: "0.0.0.0:4317", max_recv_msg_size_mib: 16, keepalive: { server_parameters: { time: "30s" } } },
      http: { endpoint: "0.0.0.0:4318", cors: { allowed_origins: ["https://*.example.com"] }, traces_url_path: "/v1/traces" },
    },
  });
  const prometheusIn = new c.PrometheusReceiver({
    name: "self",
    config: {
      global: { scrape_interval: "30s" },
      scrape_configs: [{ job_name: "collector", scrape_interval: "10s", static_configs: [{ targets: ["localhost:8888"], labels: { tier: "gw" } }] }],
    },
    trim_metric_suffixes: true,
  });
  const hostmetrics = new c.HostMetricsReceiver({
    collection_interval: "30s",
    root_path: "/hostfs",
    scrapers: { cpu: {}, memory: {}, filesystem: { exclude_mount_points: { match_type: "regexp", mount_points: ["/dev/.*"] } } },
  });
  const filelog = new c.FileLogReceiver({
    include: ["/var/log/pods/*/*/*.log"],
    exclude: ["/var/log/pods/*/otel-collector/*.log"],
    start_at: "end",
    include_file_path: true,
    storage: "file_storage",
    operators: [{ type: "container", id: "container-parser" }],
    retry_on_failure: { enabled: true, initial_interval: "1s" },
  });
  const cluster = new c.K8sClusterReceiver({
    auth_type: "serviceAccount",
    collection_interval: "30s",
    node_conditions_to_report: ["Ready", "MemoryPressure"],
    allocatable_types_to_report: ["cpu", "memory"],
    metrics: { "k8s.pod.phase": { enabled: false } },
  });
  const kubelet = new c.KubeletStatsReceiver({
    auth_type: "serviceAccount",
    endpoint: "https://${env:K8S_NODE_NAME}:10250",
    insecure_skip_verify: true,
    metric_groups: ["node", "pod", "container"],
    extra_metadata_labels: ["container.id"],
  });

  const batch = new c.BatchProcessor({ timeout: "5s", send_batch_size: 1024, send_batch_max_size: 2048, metadata_keys: ["tenant"] });
  const memoryLimiter = new c.MemoryLimiterProcessor({ check_interval: "1s", limit_mib: 1024, spike_limit_mib: 256 });
  const resource = new c.ResourceProcessor({
    attributes: [
      { key: "deployment.environment", value: "${env:DEPLOY_ENV}", action: "upsert" },
      { key: "host.id", action: "delete" },
    ],
  });
  const attributes = new c.AttributesProcessor({
    name: "scrub",
    actions: [
      { key: "user.email", action: "hash" },
      { key: "http.status_code", action: "convert", converted_type: "int" },
    ],
    include: { match_type: "strict", services: ["checkout"] },
  });
  const k8sattributes = new c.K8sAttributesProcessor({
    auth_type: "serviceAccount",
    passthrough: false,
    filter: { node_from_env_var: "K8S_NODE_NAME" },
    extract: { metadata: ["k8s.pod.name", "k8s.namespace.name"], labels: [{ tag_name: "app", key: "app.kubernetes.io/name", from: "pod" }] },
    pod_association: [{ sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }] }, { sources: [{ from: "connection" }] }],
  });
  const resourcedetection = new c.ResourceDetectionProcessor({
    detectors: ["env", "system", "gcp"],
    timeout: "2s",
    override: false,
    system: { hostname_sources: ["os"] },
  });
  const filter = new c.FilterProcessor({
    name: "health",
    error_mode: "ignore",
    traces: { span: ['attributes["http.route"] == "/healthz"'] },
    metrics: { datapoint: ['metric.name == "up" and value_int == 1'] },
    logs: { log_record: ["severity_number < SEVERITY_NUMBER_INFO"] },
  });
  const transform = new c.TransformProcessor({
    error_mode: "ignore",
    trace_statements: [{ context: "span", conditions: ["kind == SPAN_KIND_SERVER"], statements: ['set(attributes["tier"], "edge")'] }],
    metric_statements: ['delete_key(datapoint.attributes, "pod_ip")'],
    log_statements: [{ context: "log", statements: ['set(severity_text, "WARN") where severity_number == 13'] }],
  });
  const redaction = new c.RedactionProcessor({
    allow_all_keys: true,
    blocked_key_patterns: ["^gen_ai\\.(prompt|completion)"],
    blocked_values: ["4[0-9]{12}(?:[0-9]{3})?"],
    hash_function: "sha3",
    summary: "silent",
  });
  const tailSampling = new c.TailSamplingProcessor({
    decision_wait: "10s",
    num_traces: 50000,
    sample_on_first_match: true,
    policies: [
      { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } },
      { name: "slow", type: "latency", latency: { threshold_ms: 1000, upper_threshold_ms: 60000 } },
      { name: "vip", type: "boolean_attribute", boolean_attribute: { key: "vip", value: true } },
      { name: "sized", type: "span_count", span_count: { min_spans: 2, max_spans: 500 } },
      { name: "both", type: "and", and: { and_sub_policy: [{ name: "a", type: "rate_limiting", rate_limiting: { spans_per_second: 100 } }, { name: "b", type: "always_sample" }] } },
      { name: "rest", type: "probabilistic", probabilistic: { sampling_percentage: 5, hash_salt: "s" } },
    ],
  });
  const probabilistic = new c.ProbabilisticSamplerProcessor({ sampling_percentage: 12.5, mode: "proportional", sampling_precision: 4 });

  const otlpOut = new c.OtlpExporter({
    name: "backend",
    endpoint: "backend:4317",
    compression: "zstd",
    headers: { "x-api-key": "${env:BACKEND_KEY}" },
    tls: { insecure: false, ca_file: "/etc/ca.pem", min_version: "1.3" },
    balancer_name: "round_robin",
    timeout: "10s",
    retry_on_failure: { enabled: true, max_elapsed_time: "2m" },
    sending_queue: { enabled: true, num_consumers: 4, queue_size: 2000, sizer: "requests" },
  });
  const otlphttp = new c.OtlpHttpExporter({ endpoint: "https://otlp.example.com", encoding: "json", logs_endpoint: "https://logs.example.com/v1/logs" });
  const debug = new c.DebugExporter({ verbosity: "detailed", sampling_initial: 5, sampling_thereafter: 200 });
  const prometheusOut = new c.PrometheusExporter({
    endpoint: "0.0.0.0:8889",
    namespace: "otel",
    const_labels: { cluster: "prod" },
    metric_expiration: "5m",
    resource_to_telemetry_conversion: { enabled: true },
  });
  const googlecloud = new c.GoogleCloudExporter({
    project: "my-project",
    metric: { prefix: "custom.googleapis.com", resource_filters: [{ prefix: "k8s." }] },
    trace: { attribute_mappings: [{ key: "http.route", replacement: "/http/route" }] },
    log: { default_log_name: "otel" },
  });
  const loadbalancing = new c.LoadBalancingExporter({
    routing_key: "service",
    protocol: { otlp: { timeout: "1s", tls: { insecure: true } } },
    resolver: { k8s: { service: "sampling.observability", ports: [4317], return_hostnames: true } },
  });

  const spanmetrics = new c.SpanMetricsConnector({
    namespace: "span.metrics",
    dimensions: [{ name: "http.route" }, { name: "env", default: "dev" }],
    histogram: { unit: "s", exponential: { max_size: 160 } },
    exemplars: { enabled: true, max_per_data_point: 5 },
    metrics_flush_interval: "15s",
    aggregation_temporality: "AGGREGATION_TEMPORALITY_DELTA",
  });
  const servicegraph = new c.ServiceGraphConnector({
    latency_histogram_buckets: ["10ms", "100ms", "1s"],
    dimensions: ["k8s.cluster.name"],
    store: { ttl: "2s", max_items: 1000 },
    virtual_node_peer_attributes: ["db.name"],
  });
  const routing = new c.RoutingConnector({
    table: [{ context: "resource", condition: 'attributes["tenant"] == "acme"', pipelines: ["traces/acme"] }],
    default_pipelines: ["traces/rest"],
    error_mode: "ignore",
  });
  const forward = new c.ForwardConnector({});
  const count = new c.CountConnector({
    spans: { "span.count": { description: "Spans by service", attributes: [{ key: "service.name", default_value: "unknown" }] } },
  });
  const sum = new c.SumConnector({
    spans: { "span.bytes": { source_attribute: "bytes", description: "Bytes by route", conditions: ['attributes["bytes"] != nil'] } },
  });
  const signalToMetrics = new c.SignalToMetricsConnector({
    spans: [
      {
        name: "span.duration",
        unit: "ms",
        attributes: [{ key: "http.route", default_value: "none" }, { key: "error.type", optional: true }],
        include_resource_attributes: [{ key: "service.name" }],
        conditions: ["kind == SPAN_KIND_SERVER"],
        histogram: { buckets: [5, 50, 500], value: "Milliseconds(end_time - start_time)" },
      },
    ],
    logs: [{ name: "logrecord.count", sum: { value: "1" } }],
  });

  const health = new c.HealthCheckExtension({ endpoint: "0.0.0.0:13133", path: "/health", response_body: { healthy: "ok" } });
  const pprof = new c.PprofExtension({ endpoint: "localhost:1777", block_profile_fraction: 3 });
  const zpages = new c.ZPagesExtension({ endpoint: "localhost:55679" });

  return [
    otlp,
    prometheusIn,
    hostmetrics,
    filelog,
    cluster,
    kubelet,
    batch,
    memoryLimiter,
    resource,
    attributes,
    k8sattributes,
    resourcedetection,
    filter,
    transform,
    redaction,
    tailSampling,
    probabilistic,
    otlpOut,
    otlphttp,
    debug,
    prometheusOut,
    googlecloud,
    loadbalancing,
    spanmetrics,
    servicegraph,
    routing,
    forward,
    count,
    sum,
    signalToMetrics,
    health,
    pprof,
    zpages,
    new Pipeline({
      signal: "traces",
      receivers: [otlp],
      processors: [memoryLimiter, k8sattributes, resourcedetection, resource, attributes, filter, transform, redaction, probabilistic],
      exporters: [spanmetrics, servicegraph, count, sum, signalToMetrics, forward, routing, loadbalancing],
    }),
    new Pipeline({ signal: "traces", name: "acme", receivers: [routing], processors: [tailSampling, batch], exporters: [otlpOut] }),
    new Pipeline({ signal: "traces", name: "rest", receivers: [routing, forward], processors: [batch], exporters: [googlecloud, debug] }),
    new Pipeline({
      signal: "metrics",
      receivers: [otlp, prometheusIn, hostmetrics, cluster, kubelet, spanmetrics, servicegraph, count, sum, signalToMetrics],
      processors: [memoryLimiter, filter, batch],
      exporters: [prometheusOut, otlphttp],
    }),
    new Pipeline({
      signal: "logs",
      receivers: [otlp, filelog],
      processors: [memoryLimiter, redaction, batch],
      exporters: [otlphttp, debug, signalToMetrics],
    }),
    new Service({
      extensions: [health, zpages, pprof],
      telemetry: { logs: { level: "warn", encoding: "json" }, metrics: { level: "normal" }, resource: { "service.name": "gw" } },
    }),
  ];
}
