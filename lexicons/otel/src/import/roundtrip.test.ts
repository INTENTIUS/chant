/**
 * Round trips through `chant import`.
 *
 * YAML -> TypeScript -> `chant build` -> YAML must give back the same config
 * (key order and quoting aside) for every fixture: the otel examples' built
 * output, a gateway with tail_sampling, loadbalancing and spanmetrics,
 * `genAiPipeline()` output, the two collector configs of
 * examples/agent-observability, and collector-contrib example configs at the
 * pinned release. The generated source must lint clean.
 *
 * The other direction too: a config using every built-in's typed fields
 * survives TypeScript -> YAML -> TypeScript -> YAML.
 *
 * Where `otelcol-contrib` is on PATH (or `OTELCOL_BIN` names a contrib
 * build) the re-emitted configs are also checked by `otelcol validate`.
 */

import { describe, expect, test } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { load } from "js-yaml";
import * as ts from "typescript";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { Declarable } from "@intentius/chant/declarable";
import { importFromContent } from "@intentius/chant/cli/commands/import";
import { otelSerializer } from "../serializer";
import { collectorYaml } from "../collector";
import { registeredDefinitions } from "../define";
import { genAiPipeline } from "../genai";
import { Pipeline, Service } from "../pipeline";
import { SECTION_OF, type CollectorConfig, type ComponentKind } from "../model";
import * as c from "../components";
import { OtelCollectorParser } from "./parser";
import { OtelCollectorGenerator } from "./generator";

const pkgDir = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(pkgDir, "../..");
const testdata = join(import.meta.dirname, "testdata");
const read = (...p: string[]) => readFileSync(join(testdata, ...p), "utf-8");

// ── helpers ─────────────────────────────────────────────────────────

/** A parsed config with the differences the collector does not see taken out. */
function normalize(yaml: string): CollectorConfig {
  const doc = (load(yaml) ?? {}) as CollectorConfig;
  for (const section of Object.values(SECTION_OF)) {
    const s = doc[section];
    if (!s) continue;
    for (const id of Object.keys(s)) if (s[id] === null) s[id] = {};
    if (Object.keys(s).length === 0) delete doc[section];
  }
  const service = doc.service;
  if (service) {
    if (service.extensions?.length === 0) delete service.extensions;
    for (const p of Object.values(service.pipelines ?? {})) {
      p.receivers ??= [];
      p.exporters ??= [];
      if (!p.processors || p.processors.length === 0) delete p.processors;
    }
    if (Object.keys(service).length === 0) delete doc.service;
  }
  return doc;
}

/**
 * The `# chant:` header lines, with the component list of a semconv line
 * sorted: the rebuilt config lists components in the order the build
 * discovers them, which within a module is export-name order.
 */
function headerLines(yaml: string): string[] {
  return yaml
    .split("\n")
    .filter((l) => /^#\s*chant:/.test(l))
    .map((l) => l.replace(/\(([^)]*)\)$/, (_, list: string) => `(${list.split(", ").sort().join(", ")})`));
}

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

interface Imported {
  source: string;
  warnings: string[];
  yaml: string;
  buildErrors: unknown[];
  lint: { errorCount: number; warningCount: number; output: string };
}

/** A chant project dir inside the package, so the lexicon resolves as it does for a user. */
function projectDir(): string {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["otel"] };\n');
  writeFileSync(join(dir, "package.json"), '{ "name": "otel-import-roundtrip", "private": true, "type": "module" }\n');
  return dir;
}

/** YAML -> IR -> TypeScript -> `chant build` -> YAML, and `chant lint` over the source. */
async function importAndBuild(yaml: string): Promise<Imported> {
  const ir = new OtelCollectorParser().parse(yaml);
  const files = new OtelCollectorGenerator().generate(ir);
  const dir = projectDir();
  try {
    const srcDir = join(dir, "src");
    for (const file of files) writeFileSync(join(srcDir, file.path), file.content);
    const result = await build(srcDir, [otelSerializer]);
    const lint = await lintCommand({ path: srcDir, format: "stylish" });
    return {
      source: files.map((f) => `// ${f.path}\n${f.content}`).join("\n"),
      warnings: ir.warnings ?? [],
      yaml: primary(result.outputs.get("otel")),
      buildErrors: result.errors,
      lint: { errorCount: lint.errorCount, warningCount: lint.warningCount, output: lint.output },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every import is expected to rebuild equal and lint clean; a fixture may name lint rules it expects to fire. */
async function expectRoundTrip(yaml: string, opts: { lintRules?: string[] } = {}): Promise<Imported> {
  const out = await importAndBuild(yaml);
  expect(out.buildErrors).toEqual([]);
  expect(normalize(out.yaml)).toEqual(normalize(yaml));
  if (opts.lintRules) {
    for (const rule of opts.lintRules) expect(out.lint.output).toContain(rule);
  } else {
    if (out.lint.errorCount + out.lint.warningCount > 0) console.log(out.lint.output);
    expect(out.lint.errorCount).toBe(0);
    expect(out.lint.warningCount).toBe(0);
  }
  return out;
}

function findOtelcol(): string | undefined {
  const candidates = [process.env.OTELCOL_BIN, "otelcol-contrib"].filter((b): b is string => !!b);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return bin;
  }
  return undefined;
}

const OTELCOL = findOtelcol();

function otelcolValidate(yaml: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-otelcol-import-"));
  try {
    const file = join(dir, "config.yaml");
    writeFileSync(file, yaml);
    const r = spawnSync(OTELCOL!, ["validate", `--config=${file}`], {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, TEMPO_TOKEN: "t", DEPLOY_ENV: "test", SPLUNK_HEC_TOKEN: "t", K8S_NODE_NAME: "node-1" },
    });
    return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── fixtures ────────────────────────────────────────────────────────

/** Each otel example's `chant build` output. */
async function exampleOutputs(): Promise<Array<[string, string]>> {
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
    expect(result.errors).toEqual([]);
    out.push([name, primary(result.outputs.get("otel"))]);
  }
  return out;
}

const UPSTREAM_BUILTIN_ONLY = [
  "kubernetes-filelog.yaml",
  "logline-filter-in.yaml",
  "logline-filter-out.yaml",
  "secure-tracing.yaml",
  "loadbalancing-backend.yaml",
];

describe("YAML -> TypeScript -> YAML", () => {
  test("the otel examples' built output", async () => {
    const outputs = await exampleOutputs();
    expect(outputs.map(([n]) => n)).toEqual(["custom-component", "genai-agent", "getting-started", "k8s-node-agent"]);
    for (const [name, yaml] of outputs) {
      const out = await expectRoundTrip(yaml);
      // The `# chant:` header comes back too: the custom component's pin, the semconv line.
      expect(headerLines(out.yaml), name).toEqual(headerLines(yaml));
    }
  });

  test("a gateway with tail_sampling, loadbalancing and spanmetrics", async () => {
    const yaml = read("gateway.yaml");
    const out = await expectRoundTrip(yaml);
    expect(out.source).toContain("new TailSamplingProcessor(");
    expect(out.source).toContain("new LoadBalancingExporter(");
    expect(out.source).toContain("const spanmetrics = new SpanMetricsConnector(");
    // The connector is one entity, on both sides of the join.
    expect(out.source).toContain("exporters: [otlpTempo, spanmetrics]");
    expect(out.source).toContain("receivers: [spanmetrics]");
    // ${env:VAR} stays a reference.
    expect(out.source).toContain('authorization: "Bearer ${env:TEMPO_TOKEN}"');
    expect(out.source).toContain('default: "${env:DEPLOY_ENV}"');
    // pprof is declared but not enabled, so the Service lists what is.
    expect(out.source).toContain("extensions: [zpages, healthCheck]");
    expect(out.source).toContain("const telemetry: ServiceTelemetry = {");
    // Nested config is lifted into named consts typed by the component's config type (COR001).
    expect(out.source).toContain('const tailSamplingPolicies: TailSamplingProcessorConfig["policies"] = [');
    expect(out.warnings).toEqual([]);
  });

  test("genAiPipeline() output", async () => {
    const tempo = new c.OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });
    const sampler = new c.ProbabilisticSamplerProcessor({ sampling_percentage: 25 });
    for (const entities of [
      genAiPipeline(),
      genAiPipeline({ traceExporters: [tempo], sampling: [sampler], keepContent: true, logs: false }),
      genAiPipeline({ maskValues: ["\\b[0-9]{13,16}\\b"], hashFunction: "sha3", healthCheck: false }),
    ]) {
      const yaml = collectorYaml(entities);
      const out = await expectRoundTrip(yaml);
      expect(headerLines(out.yaml)).toEqual(headerLines(yaml));
    }
  });

  test("the collector configs of examples/agent-observability", async () => {
    for (const file of ["agent-observability-agent.yaml", "agent-observability-gateway.yaml"]) {
      await expectRoundTrip(read(file));
    }
  });

  for (const file of UPSTREAM_BUILTIN_ONLY) {
    test(`collector-contrib v0.130.0: ${file}`, async () => {
      const out = await expectRoundTrip(read("upstream", file));
      expect(out.source).not.toContain("defineComponent");
    });
  }

  test.skipIf(!OTELCOL)("otelcol validate accepts every re-emitted config", async () => {
    // Not the agent-observability agent: its k8s resolver needs a cluster to build (that example's own tests swap it for dns).
    const yamls: Array<[string, string]> = [
      ["gateway.yaml", read("gateway.yaml")],
      ["agent-observability-gateway.yaml", read("agent-observability-gateway.yaml")],
      ["genAiPipeline()", collectorYaml(genAiPipeline())],
      ...UPSTREAM_BUILTIN_ONLY.map((f): [string, string] => [f, read("upstream", f)]),
      // hostmetrics' root_path is accepted on linux only, which is where the node agent runs.
      ...(await exampleOutputs()).filter(([n]) => n !== "k8s-node-agent" || process.platform === "linux"),
    ];
    for (const [name, yaml] of yamls) {
      const { yaml: rebuilt } = await importAndBuild(yaml);
      const { ok, output } = otelcolValidate(rebuilt);
      expect(ok, `${name}: ${output}`).toBe(true);
    }
  });

});

describe("components chant does not ship", () => {
  test("go through defineComponent with their config as data, and survive the round trip", async () => {
    const out = await expectRoundTrip(read("upstream", "fault-tolerant-logs.yaml"));
    expect(out.source).toContain("const FileStorageExtension = defineComponent<Record<string, unknown>>()({");
    expect(out.source).toContain("pin: COLLECTOR_PIN,");
    expect(out.source).toMatch(/\/\/ extension "file_storage" is not a component chant ships/);
    expect(out.source).toContain('const fileStorageFilelogreceiver = new FileStorageExtension({');
    expect(out.source).toContain('import { FileStorageExtension } from "./custom-components";');
    // The typed built-ins keep referring to the storage extension by id, as data.
    expect(out.source).toContain('storage: "file_storage/filelogreceiver"');
  });

  test("an unknown receiver and exporter in the loadbalancing agent example", async () => {
    const out = await expectRoundTrip(read("upstream", "loadbalancing-agent.yaml"));
    expect(out.source).toContain('type: "fluentforward"');
    expect(out.source).toContain("new LoadBalancingExporter(");
  });

  test("nop receivers and exporters around a servicegraph connector", async () => {
    const out = await expectRoundTrip(read("upstream", "servicegraph-nop.yaml"));
    expect(out.source).toContain("const NopReceiver = defineComponent");
    expect(out.source).toContain("const NopExporter = defineComponent");
    expect(out.source).toContain("const servicegraph = new ServiceGraphConnector(");
  });

  test("a literal credential is imported as found and reported by OTEL002", async () => {
    const out = await expectRoundTrip(read("upstream", "couchbase.yaml"), { lintRules: ["OTEL002"] });
    expect(out.source).toContain('password: "otelpassword"');
    expect(out.source).toContain("const MetricstransformProcessor = defineComponent");
  });

  test("a pin from the `# chant:` header is carried back into defineComponent", async () => {
    const yaml = [
      "# chant: exporter datadog/eu schema github.com/open-telemetry/opentelemetry-collector-contrib/exporter/datadogexporter@v0.129.0 sha256:abc",
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc: {}",
      "exporters:",
      "  datadog/eu:",
      "    api:",
      "      key: ${env:DD_API_KEY}",
      "      site: datadoghq.eu",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [datadog/eu]",
      "",
    ].join("\n");
    const out = await expectRoundTrip(yaml);
    expect(out.source).toContain('version: "v0.129.0"');
    expect(out.source).toContain('digest: "sha256:abc"');
    expect(out.source).not.toContain("COLLECTOR_PIN,");
    expect(headerLines(out.yaml)).toEqual(headerLines(yaml));
  });
});

// ── TypeScript -> YAML -> TypeScript -> YAML ────────────────────────

/** One instance of every built-in, each using its typed fields, wired into pipelines the connectors accept. */
function everyBuiltin(): Declarable[] {
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
    health,
    pprof,
    zpages,
    new Pipeline({
      signal: "traces",
      receivers: [otlp],
      processors: [memoryLimiter, k8sattributes, resourcedetection, resource, attributes, filter, transform, redaction, probabilistic],
      exporters: [spanmetrics, servicegraph, count, sum, forward, routing, loadbalancing],
    }),
    new Pipeline({ signal: "traces", name: "acme", receivers: [routing], processors: [tailSampling, batch], exporters: [otlpOut] }),
    new Pipeline({ signal: "traces", name: "rest", receivers: [routing, forward], processors: [batch], exporters: [googlecloud, debug] }),
    new Pipeline({
      signal: "metrics",
      receivers: [otlp, prometheusIn, hostmetrics, cluster, kubelet, spanmetrics, servicegraph, count, sum],
      processors: [memoryLimiter, filter, batch],
      exporters: [prometheusOut, otlphttp],
    }),
    new Pipeline({ signal: "logs", receivers: [otlp, filelog], processors: [memoryLimiter, redaction, batch], exporters: [otlphttp, debug] }),
    new Service({
      extensions: [health, zpages, pprof],
      telemetry: { logs: { level: "warn", encoding: "json" }, metrics: { level: "normal" }, resource: { "service.name": "gw" } },
    }),
  ];
}

describe("TypeScript -> YAML -> TypeScript -> YAML", () => {
  test("every built-in, each using its typed fields", async () => {
    const entities = everyBuiltin();
    const first = collectorYaml(entities);

    // The fixture covers every built-in this package registers.
    const config = load(first) as CollectorConfig;
    const used = new Set<string>();
    for (const [kind, section] of Object.entries(SECTION_OF) as Array<[ComponentKind, keyof CollectorConfig]>) {
      for (const id of Object.keys((config[section] as Record<string, unknown>) ?? {})) used.add(`${kind}:${id.split("/")[0]}`);
    }
    const builtins = registeredDefinitions().filter((d) => d.builtin).map((d) => `${d.kind}:${d.type}`);
    expect([...used].sort()).toEqual([...new Set(builtins)].sort());

    const out = await expectRoundTrip(first);
    expect(out.source).not.toContain("defineComponent");
    // Importing is a fixed point from there: the rebuilt YAML (components now in
    // export-name order within each section) gives the same TypeScript and YAML, text for text.
    const again = await importAndBuild(out.yaml);
    const third = await importAndBuild(again.yaml);
    expect(third.source).toBe(again.source);
    expect(third.yaml).toBe(again.yaml);
  });
});

// ── the generated source type-checks ────────────────────────────────

/** Type errors in generated projects, compiled together against the lexicon's source with the repo's compiler options. */
function typeErrors(projects: Record<string, Array<{ path: string; content: string }>>): string[] {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  try {
    const files: string[] = [];
    for (const [name, generated] of Object.entries(projects)) {
      const sub = join(dir, name.replace(/[^A-Za-z0-9]+/g, "-"));
      mkdirSync(sub);
      for (const f of generated) {
        writeFileSync(join(sub, f.path), f.content);
        files.push(join(sub, f.path));
      }
    }
    const configFile = ts.readConfigFile(join(repoRoot, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
    const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
    const real = (f: string) => ts.sys.realpath?.(f) ?? f;
    const fileSet = new Set(files.map(real));
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file && fileSet.has(real(d.file.fileName)));
    // A program that saw none of the files would pass vacuously.
    expect(files.every((f) => program.getSourceFile(f) !== undefined)).toBe(true);
    return diagnostics.map((d) => {
      const at = real(d.file!.fileName).slice(real(dir).length + 1);
      return `${at}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const generate = (yaml: string) => new OtelCollectorGenerator().generate(new OtelCollectorParser().parse(yaml));

describe("the generated source type-checks against the lexicon's config types", () => {
  test("for every fixture whose config stays within the typed fields", async () => {
    const projects: Record<string, Array<{ path: string; content: string }>> = {
      gateway: generate(read("gateway.yaml")),
      agent: generate(read("agent-observability-agent.yaml")),
      agentGateway: generate(read("agent-observability-gateway.yaml")),
      genai: generate(collectorYaml(genAiPipeline())),
      everyBuiltin: generate(collectorYaml(everyBuiltin())),
      faultTolerant: generate(read("upstream", "fault-tolerant-logs.yaml")),
      ...Object.fromEntries(UPSTREAM_BUILTIN_ONLY.map((f) => [f, generate(read("upstream", f))])),
      ...Object.fromEntries((await exampleOutputs()).map(([n, y]) => [n, generate(y)])),
    };
    expect(typeErrors(projects)).toEqual([]);
  }, 120_000);

  test("a value outside a built-in's typed config is carried as found, and tsc points at it", () => {
    // couchbase uses the filter processor's legacy match syntax and a scrape job's basic_auth,
    // neither of which the lexicon's config types cover.
    const couchbase = typeErrors({ couchbase: generate(read("upstream", "couchbase.yaml")) });
    expect(couchbase).toEqual([
      expect.stringMatching(/^couchbase\/processors\.ts: .*'exclude' does not exist/),
      expect.stringMatching(/^couchbase\/receivers\.ts: .*'basic_auth' does not exist in type 'PrometheusScrapeConfig'/),
    ]);
    // The servicegraph test config writes bucket durations as bare integers (nanoseconds); Duration is a string.
    const servicegraph = typeErrors({ servicegraph: generate(read("upstream", "servicegraph-nop.yaml")) });
    expect(servicegraph).toEqual(Array(5).fill("servicegraph/connectors.ts: Type 'number' is not assignable to type 'string'."));
  }, 120_000);
});

// ── through core's import command ───────────────────────────────────

test("importFromContent writes one module per section through the otel plugin", async () => {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  try {
    const output = join(dir, "src");
    const result = await importFromContent({ content: read("gateway.yaml"), lexicon: "otel", output });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("otel");
    expect(result.generatedFiles).toEqual([
      "receivers.ts",
      "processors.ts",
      "exporters.ts",
      "connectors.ts",
      "extensions.ts",
      "pipelines.ts",
      "service.ts",
    ]);
    const built = await build(output, [otelSerializer]);
    expect(built.errors).toEqual([]);
    expect(normalize(primary(built.outputs.get("otel")))).toEqual(normalize(read("gateway.yaml")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
