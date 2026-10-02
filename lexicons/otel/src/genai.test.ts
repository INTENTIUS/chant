/**
 * The GenAI preset: content removal unless the caller opts in, agent RED and
 * token metrics, and the GenAI semconv pin in the topology.
 *
 * The `otelcol` tests run when `otelcol-contrib` is on PATH (or `OTELCOL_BIN`
 * names a contrib build) and skip otherwise; CI does not install it. One of
 * them runs the collector, sends GenAI spans and events through it, and reads
 * what comes out. The structural tests run everywhere.
 */

import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { collectorYaml, buildCollectorConfig } from "./collector";
import { COLLECTOR_PIN, GENAI_SEMCONV_PIN, defineComponent } from "./define";
import { collectorTopology, collectorTopologyOf } from "./topology";
import { validateCollectorConfig, validateCollectorEntities } from "./validate-config";
import type { CollectorConfig } from "./model";
import { DebugExporter, FilterProcessor, OtlpExporter, PrometheusExporter, SumConnector } from "./components";
import {
  GENAI_CLIENT_DURATION_BUCKETS,
  GENAI_CLIENT_METRIC_ATTRIBUTES,
  GENAI_CLIENT_TOKEN_BUCKETS,
  GENAI_CONTENT_ATTRIBUTES,
  GENAI_SPAN_METRIC_DIMENSIONS,
  genAiComponents,
  genAiMetrics,
  genAiPipeline,
  type GenAiPipelineOptions,
} from "./genai";
import { semconvUsage } from "./semconv";
import { otlpCollector } from "./platform";

function findOtelcol(): string | undefined {
  const candidates = [process.env.OTELCOL_BIN, "otelcol-contrib"].filter((c): c is string => !!c);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return bin;
  }
  return undefined;
}

const OTELCOL = findOtelcol();

function withConfigFile<T>(yaml: string, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chant-genai-"));
  try {
    const file = join(dir, "config.yaml");
    writeFileSync(file, yaml);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function otelcolValidate(yaml: string): { ok: boolean; output: string } {
  return withConfigFile(yaml, (file) => {
    const r = spawnSync(OTELCOL!, ["validate", `--config=${file}`], { encoding: "utf-8", timeout: 60_000 });
    return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  });
}

function parsed(entities: Declarable[]): any {
  return load(collectorYaml(entities));
}

/** Not a chant built-in; declared the way a project would. */
const RemoteWriteExporter = defineComponent<{ endpoint: string }>()({
  kind: "exporter",
  type: "prometheusremotewrite",
  pin: { source: "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/prometheusremotewriteexporter", version: "v0.130.0" },
});

describe("genAiPipeline: content", () => {
  test("content keys are deleted from spans, span events and log records by default", () => {
    const config = parsed(genAiPipeline());
    const transform = config.processors["transform/genai_content"];
    expect(transform.error_mode).toBe("ignore");
    const [span, spanevent] = transform.trace_statements;
    const [log] = transform.log_statements;
    expect(span.context).toBe("span");
    expect(spanevent.context).toBe("spanevent");
    expect(log.context).toBe("log");
    for (const key of GENAI_CONTENT_ATTRIBUTES) {
      expect(span.statements).toContain(`delete_key(span.attributes, "${key}")`);
      expect(spanevent.statements).toContain(`delete_key(spanevent.attributes, "${key}")`);
      expect(log.statements).toContain(`delete_key(log.attributes, "${key}")`);
    }
    // The newer message attributes and the event-based content are both covered.
    expect(GENAI_CONTENT_ATTRIBUTES).toEqual(
      expect.arrayContaining(["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions"]),
    );
    expect(log.statements.some((s: string) => s.startsWith("delete_matching_keys(log.body,") && s.includes("gen_ai"))).toBe(true);
  });

  test("the transform runs before redaction, which masks the same keys as a backstop", () => {
    const config = parsed(genAiPipeline());
    for (const id of ["traces", "logs"]) {
      expect(config.service.pipelines[id].processors).toEqual([
        "memory_limiter",
        "transform/genai_content",
        "redaction/genai_content",
        "batch",
      ]);
    }
    const redaction = config.processors["redaction/genai_content"];
    expect(redaction.allow_all_keys).toBe(true);
    const pattern = new RegExp(redaction.blocked_key_patterns[0]);
    for (const key of GENAI_CONTENT_ATTRIBUTES) expect(pattern.test(key)).toBe(true);
    // Convention attributes that are not content survive.
    for (const key of ["gen_ai.prompt.name", "gen_ai.request.model", "gen_ai.operation.name"]) {
      expect(redaction.blocked_key_patterns.some((p: string) => new RegExp(p).test(key))).toBe(false);
    }
    expect(redaction.blocked_key_patterns.some((p: string) => new RegExp(p).test("gen_ai.prompt.0.content"))).toBe(true);
  });

  test("keepContent: true is the only way content stays", () => {
    const config = parsed(genAiPipeline({ keepContent: true }));
    expect(Object.keys(config.processors)).toEqual(["memory_limiter", "batch", "filter/genai_spans"]);
    expect(config.service.pipelines.traces.processors).toEqual(["memory_limiter", "batch"]);
    const parts = genAiComponents({ keepContent: true });
    expect(parts.contentRemoval).toBeUndefined();
    expect(parts.redaction).toBeUndefined();
    expect(parts.processors).toEqual([]);
  });

  test("maskValues masks values whether content is kept or not", () => {
    const kept = parsed(genAiPipeline({ keepContent: true, maskValues: ["[0-9]{16}"], hashFunction: "sha3" }));
    expect(kept.processors["redaction/genai_content"]).toEqual({
      allow_all_keys: true,
      blocked_values: ["[0-9]{16}"],
      hash_function: "sha3",
    });
    expect(kept.processors["transform/genai_content"]).toBeUndefined();
    const removed = parsed(genAiPipeline({ maskValues: ["[0-9]{16}"] }));
    expect(removed.processors["redaction/genai_content"].blocked_values).toEqual(["[0-9]{16}"]);
  });

  test("contentAttributes adds keys to delete", () => {
    const config = parsed(genAiPipeline({ contentAttributes: ["llm.input_messages"] }));
    expect(config.processors["transform/genai_content"].trace_statements[0].statements).toContain(
      'delete_key(span.attributes, "llm.input_messages")',
    );
    expect(new RegExp(config.processors["redaction/genai_content"].blocked_key_patterns[0]).test("llm.input_messages")).toBe(true);
  });
});

describe("genAiPipeline: metrics", () => {
  test("a traces/genai branch feeds spanmetrics and sum from every GenAI span", () => {
    const config = parsed(genAiPipeline());
    expect(config.service.pipelines).toEqual({
      traces: {
        receivers: ["otlp"],
        processors: ["memory_limiter", "transform/genai_content", "redaction/genai_content", "batch"],
        exporters: ["debug", "forward/genai"],
      },
      "traces/genai": {
        receivers: ["forward/genai"],
        processors: ["filter/genai_spans"],
        exporters: ["spanmetrics/genai", "sum/genai_tokens"],
      },
      "metrics/genai": { receivers: ["spanmetrics/genai", "sum/genai_tokens"], processors: ["batch"], exporters: ["debug"] },
      logs: {
        receivers: ["otlp"],
        processors: ["memory_limiter", "transform/genai_content", "redaction/genai_content", "batch"],
        exporters: ["debug"],
      },
    });
    expect(config.processors["filter/genai_spans"].traces.span).toEqual(['attributes["gen_ai.operation.name"] == nil']);
  });

  test("spanmetrics carries the GenAI dimensions", () => {
    const sm = parsed(genAiPipeline()).connectors["spanmetrics/genai"];
    expect(sm.namespace).toBe("genai");
    expect(sm.dimensions.map((d: { name: string }) => d.name)).toEqual([
      "gen_ai.operation.name",
      "gen_ai.request.model",
      "gen_ai.tool.name",
      "error.type",
    ]);
    expect(sm.histogram.unit).toBe("s");
  });

  test("sum adds up input and output tokens per model, skipping in-process agent spans", () => {
    const sum = parsed(genAiPipeline()).connectors["sum/genai_tokens"];
    expect(Object.keys(sum.spans)).toEqual(["genai.tokens.input", "genai.tokens.output"]);
    expect(sum.spans["genai.tokens.input"].source_attribute).toBe("gen_ai.usage.input_tokens");
    expect(sum.spans["genai.tokens.output"].source_attribute).toBe("gen_ai.usage.output_tokens");
    expect(sum.spans["genai.tokens.input"].attributes).toEqual([{ key: "gen_ai.request.model", default_value: "unknown" }]);
    expect(sum.spans["genai.tokens.input"].conditions[0]).toContain('"invoke_agent"');
  });

  test("genAiMetrics names what the pipeline emits, and follows the namespace", () => {
    const m = genAiMetrics();
    expect([m.calls.prometheus, m.duration.prometheus, m.inputTokens.prometheus, m.outputTokens.prometheus]).toEqual([
      "genai_calls_total",
      "genai_duration_seconds",
      "genai_tokens_input_total",
      "genai_tokens_output_total",
    ]);
    expect(m.calls.dimensions).toEqual(["service.name", "span.name", "span.kind", "status.code", ...GENAI_SPAN_METRIC_DIMENSIONS]);

    const renamed = genAiMetrics({ namespace: "agents.support" });
    expect(renamed.duration.prometheus).toBe("agents_support_duration_seconds");
    const config = parsed(genAiPipeline({ namespace: "agents.support" }));
    expect(config.connectors["spanmetrics/genai"].namespace).toBe("agents.support");
    expect(Object.keys(config.connectors["sum/genai_tokens"].spans)).toEqual([
      renamed.inputTokens.name,
      renamed.outputTokens.name,
    ]);
  });

  test("sampling processors run in traces/sampled, after the metrics branch", () => {
    const keepErrors = new FilterProcessor({ name: "sampler", traces: { span: ["status.code != STATUS_CODE_ERROR"] } });
    const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });
    const config = parsed(genAiPipeline({ sampling: [keepErrors], traceExporters: [tempo] }));
    expect(config.service.pipelines.traces).toEqual({
      receivers: ["otlp"],
      processors: ["memory_limiter", "transform/genai_content", "redaction/genai_content"],
      exporters: ["forward/genai", "forward/sampled"],
    });
    expect(config.service.pipelines["traces/sampled"]).toEqual({
      receivers: ["forward/sampled"],
      processors: ["filter/sampler", "batch"],
      exporters: ["otlp/tempo"],
    });
  });

  test("deltaToCumulative unset or false leaves the output as it was, whatever the exporters", () => {
    const remoteWrite = new RemoteWriteExporter({ endpoint: "http://mimir:9009/api/v1/push" });
    for (const metricExporters of [undefined, [remoteWrite], [new OtlpExporter({ endpoint: "backend:4317" })]]) {
      const before = collectorYaml(genAiPipeline({ metricExporters }));
      expect(before).not.toContain("deltatocumulative");
      expect(collectorYaml(genAiPipeline({ metricExporters, deltaToCumulative: false }))).toBe(before);
    }
  });

  test('deltaToCumulative "auto" puts deltatocumulative before batch unless every exporter takes deltas', () => {
    const remoteWrite = new RemoteWriteExporter({ endpoint: "http://mimir:9009/api/v1/push" });
    const prometheus = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
    const withRemote = parsed(genAiPipeline({ metricExporters: [prometheus, remoteWrite], deltaToCumulative: "auto" }));
    expect(withRemote.service.pipelines["metrics/genai"]).toEqual({
      receivers: ["spanmetrics/genai", "sum/genai_tokens"],
      processors: ["deltatocumulative/genai", "batch"],
      exporters: ["prometheus", "prometheusremotewrite"],
    });
    expect(withRemote.processors).toHaveProperty("deltatocumulative/genai");
    for (const p of ["traces", "traces/genai", "logs"]) {
      expect(withRemote.service.pipelines[p].processors).not.toContain("deltatocumulative/genai");
    }

    const promOnly = genAiPipeline({ metricExporters: [prometheus], deltaToCumulative: "auto" });
    expect(collectorYaml(promOnly)).toBe(collectorYaml(genAiPipeline({ metricExporters: [prometheus] })));
    expect(collectorYaml(genAiPipeline({ deltaToCumulative: "auto" }))).toBe(collectorYaml(genAiPipeline()));
    const otlp = parsed(genAiPipeline({ metricExporters: [new OtlpExporter({ endpoint: "backend:4317" })], deltaToCumulative: "auto" }));
    expect(otlp.service.pipelines["metrics/genai"].processors).toEqual(["deltatocumulative/genai", "batch"]);
  });

  test("deltaToCumulative: true inserts it for any exporter, such as otlp to a cumulative backend", () => {
    const config = parsed(genAiPipeline({ metricExporters: [new OtlpExporter({ endpoint: "backend:4317" })], deltaToCumulative: true }));
    expect(config.service.pipelines["metrics/genai"].processors).toEqual(["deltatocumulative/genai", "batch"]);
  });

  test("deltaToCumulative rejects other values", () => {
    expect(() => genAiPipeline({ deltaToCumulative: "yes" as never })).toThrow(/deltaToCumulative/);
  });

  test("logs: false leaves the logs pipeline out", () => {
    expect(Object.keys(parsed(genAiPipeline({ logs: false })).service.pipelines)).toEqual([
      "traces",
      "traces/genai",
      "metrics/genai",
    ]);
  });
});

describe("genAiPipeline: the conventions' client metrics", () => {
  // Rendered from the preset before clientMetrics and providerDimensions existed.
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, "testdata", name), "utf-8");
  const configured = (extra: GenAiPipelineOptions = {}): GenAiPipelineOptions => ({
    namespace: "agents.support",
    dimensions: [{ name: "gen_ai.agent.name" }],
    sampling: [new FilterProcessor({ name: "sampler", traces: { span: ["status.code != STATUS_CODE_ERROR"] } })],
    traceExporters: [new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } })],
    metricExporters: [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })],
    maskValues: ["secret-[a-z]+"],
    ...extra,
  });
  const prometheus = () => [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })];

  test("without the options the YAML is byte for byte what it was", () => {
    expect(collectorYaml(genAiPipeline())).toBe(fixture("genai-default.yaml"));
    expect(collectorYaml(genAiPipeline({ clientMetrics: undefined, providerDimensions: false }))).toBe(fixture("genai-default.yaml"));
    expect(collectorYaml(genAiPipeline(configured()))).toBe(fixture("genai-configured.yaml"));
    expect(genAiMetrics()).not.toHaveProperty("client");
    const parts = genAiComponents();
    expect(parts).not.toHaveProperty("clientMetrics");
    expect(parts).not.toHaveProperty("sdkClientMetricsFilter");
  });

  test('clientMetrics: "derive" emits both metrics with the attributes, units and buckets of v1.41.1', () => {
    const config = parsed(genAiPipeline({ clientMetrics: "derive", metricExporters: prometheus() }));
    const [duration, input, output] = config.connectors["signaltometrics/genai_client"].spans;
    const optional = GENAI_CLIENT_METRIC_ATTRIBUTES.slice(1).map((key) => ({ key, optional: true }));
    expect(duration).toEqual({
      name: "gen_ai.client.operation.duration",
      description: "GenAI operation duration.",
      unit: "s",
      attributes: [{ key: "gen_ai.operation.name" }, ...optional],
      histogram: {
        buckets: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92],
        value: "Double(Microseconds(end_time - start_time)) / 1000000.0",
      },
    });
    expect(GENAI_CLIENT_METRIC_ATTRIBUTES).toEqual([
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.response.model",
      "server.address",
      "server.port",
      "error.type",
    ]);
    for (const [entry, type, source] of [
      [input, "input", "gen_ai.usage.input_tokens"],
      [output, "output", "gen_ai.usage.output_tokens"],
    ] as const) {
      expect(entry.name).toBe("gen_ai.client.token.usage");
      expect(entry.unit).toBe("{token}");
      // One metric: the connector merges entries with the same name, unit and description.
      expect(entry.description).toBe("Number of input and output tokens used.");
      expect(entry.attributes).toEqual([{ key: "gen_ai.operation.name" }, ...optional, { key: "gen_ai.token.type", default_value: type }]);
      expect(entry.histogram).toEqual({
        buckets: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864],
        value: `attributes["${source}"]`,
      });
      // Numeric counts only, and not the in-process agent and workflow spans the sum connector skips too.
      expect(entry.conditions).toHaveLength(1);
      expect(entry.conditions[0]).toContain(`IsInt(attributes["${source}"]) or IsDouble(attributes["${source}"])`);
      expect(entry.conditions[0]).toContain(config.connectors["sum/genai_tokens"].spans["genai.tokens.input"].conditions[0].split(" and ").slice(1).join(" and "));
    }
    expect([...GENAI_CLIENT_DURATION_BUCKETS]).toEqual(duration.histogram.buckets);
    expect([...GENAI_CLIENT_TOKEN_BUCKETS]).toEqual(input.histogram.buckets);
  });

  test('clientMetrics: "derive" wires the connector into the metrics branch and passes the SDK\'s metrics through without its copies', () => {
    const config = parsed(genAiPipeline({ clientMetrics: "derive", metricExporters: prometheus() }));
    const p = config.service.pipelines;
    expect(p["traces/genai"].exporters).toEqual(["spanmetrics/genai", "sum/genai_tokens", "signaltometrics/genai_client"]);
    expect(p["metrics/genai"].receivers).toEqual(["spanmetrics/genai", "sum/genai_tokens", "signaltometrics/genai_client"]);
    expect(p.metrics).toEqual({
      receivers: ["otlp"],
      processors: ["memory_limiter", "filter/genai_sdk_client", "batch"],
      exporters: ["prometheus"],
    });
    expect(config.processors["filter/genai_sdk_client"]).toEqual({
      error_mode: "ignore",
      metrics: { metric: ['name == "gen_ai.client.operation.duration"', 'name == "gen_ai.client.token.usage"'] },
    });
    // The genai.* metrics are unchanged.
    const plain = parsed(genAiPipeline({ metricExporters: prometheus() }));
    expect(config.connectors["spanmetrics/genai"]).toEqual(plain.connectors["spanmetrics/genai"]);
    expect(config.connectors["sum/genai_tokens"]).toEqual(plain.connectors["sum/genai_tokens"]);
  });

  test('clientMetrics: "passthrough" derives nothing and passes the SDK\'s metrics through', () => {
    const tempo = new OtlpExporter({ name: "mimir", endpoint: "mimir:4317" });
    const config = parsed(genAiPipeline({ clientMetrics: "passthrough", metricExporters: [tempo] }));
    expect(Object.keys(config.connectors)).toEqual(["forward/genai", "spanmetrics/genai", "sum/genai_tokens"]);
    expect(config.processors["filter/genai_sdk_client"]).toBeUndefined();
    expect(config.service.pipelines.metrics).toEqual({ receivers: ["otlp"], processors: ["memory_limiter", "batch"], exporters: ["otlp/mimir"] });
    const parts = genAiComponents({ clientMetrics: "passthrough" });
    expect(parts.clientMetrics).toBeUndefined();
    expect(parts.metrics.client?.source).toBe("passthrough");
  });

  test("genAiMetrics reports the conventions' names, Prometheus names and attributes", () => {
    for (const source of ["derive", "passthrough"] as const) {
      const m = genAiMetrics({ clientMetrics: source, namespace: "agents" });
      expect(m.client).toEqual({
        source,
        operationDuration: {
          name: "gen_ai.client.operation.duration",
          prometheus: "gen_ai_client_operation_duration_seconds",
          type: "histogram",
          unit: "s",
          dimensions: [...GENAI_CLIENT_METRIC_ATTRIBUTES],
        },
        tokenUsage: {
          name: "gen_ai.client.token.usage",
          prometheus: "gen_ai_client_token_usage",
          type: "histogram",
          unit: "{token}",
          dimensions: [...GENAI_CLIENT_METRIC_ATTRIBUTES, "gen_ai.token.type"],
        },
      });
      // The preset's own metrics keep their namespace and shape.
      const { client: _client, ...rest } = m;
      expect(rest).toEqual(genAiMetrics({ namespace: "agents" }));
    }
    expect(genAiComponents({ clientMetrics: "derive" }).metrics).toEqual(genAiMetrics({ clientMetrics: "derive" }));
  });

  test('clientMetrics: "derive" converts its deltas for exporters other than prometheus and debug', () => {
    const otlp = new OtlpExporter({ name: "mimir", endpoint: "mimir:4317" });
    const config = parsed(genAiPipeline({ clientMetrics: "derive", metricExporters: [otlp] }));
    expect(config.service.pipelines["metrics/genai"]).toEqual({
      receivers: ["spanmetrics/genai", "sum/genai_tokens", "signaltometrics/genai_client"],
      processors: ["deltatocumulative/genai", "batch"],
      exporters: ["otlp/mimir"],
    });
    // The SDK's own metrics carry the SDK's temporality and are left alone.
    expect(config.service.pipelines.metrics.processors).not.toContain("deltatocumulative/genai");

    const prom = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
    expect(collectorYaml(genAiPipeline({ clientMetrics: "derive", metricExporters: [prom] }))).not.toContain("deltatocumulative");
    expect(collectorYaml(genAiPipeline({ clientMetrics: "derive" }))).not.toContain("deltatocumulative");
    const off = parsed(genAiPipeline({ clientMetrics: "derive", metricExporters: [otlp], deltaToCumulative: false }));
    expect(off.service.pipelines["metrics/genai"].processors).toEqual(["batch"]);
    expect(collectorYaml(genAiPipeline({ clientMetrics: "passthrough", metricExporters: [otlp] }))).not.toContain("deltatocumulative");
    expect(() => genAiPipeline({ clientMetrics: "semconv" as never })).toThrow(/"derive" or "passthrough"/);
  });

  test("providerDimensions adds the provider and response model to genai.calls and genai.duration only", () => {
    const config = parsed(genAiPipeline({ providerDimensions: true, dimensions: [{ name: "gen_ai.agent.name" }] }));
    expect(config.connectors["spanmetrics/genai"].dimensions.map((d: { name: string }) => d.name)).toEqual([
      ...GENAI_SPAN_METRIC_DIMENSIONS,
      "gen_ai.provider.name",
      "gen_ai.response.model",
      "gen_ai.agent.name",
    ]);
    expect(config.connectors["sum/genai_tokens"]).toEqual(parsed(genAiPipeline()).connectors["sum/genai_tokens"]);
    const m = genAiMetrics({ providerDimensions: true });
    expect(m.calls.dimensions).toEqual(expect.arrayContaining(["gen_ai.provider.name", "gen_ai.response.model"]));
    expect(m.duration.dimensions).toEqual(m.calls.dimensions);
    expect(m.inputTokens.dimensions).toEqual(["gen_ai.request.model"]);
  });
});

describe("genAiPipeline: checks and topology", () => {
  const optionSets: Array<[string, GenAiPipelineOptions]> = [
    ["default", {}],
    ["keepContent", { keepContent: true }],
    ["masked and sampled", { maskValues: ["secret-[a-z]+"], sampling: [new FilterProcessor({ name: "s", traces: { span: ["false"] } })] }],
    ["prometheus", { metricExporters: [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })], logs: false, healthCheck: false }],
    [
      "remote write with deltatocumulative",
      { metricExporters: [new RemoteWriteExporter({ endpoint: "http://mimir:9009/api/v1/push" })], deltaToCumulative: "auto" },
    ],
    ["client metrics derived", { clientMetrics: "derive", providerDimensions: true, metricExporters: [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })] }],
    ["client metrics passed through", { clientMetrics: "passthrough" }],
    [
      "client metrics derived to remote write",
      { clientMetrics: "derive", metricExporters: [new RemoteWriteExporter({ endpoint: "http://mimir:9009/api/v1/push" })] },
    ],
  ];

  test.each(optionSets)("%s passes the lexicon's own checks", (_label, options) => {
    const entities = genAiPipeline(options);
    expect(validateCollectorEntities(entities)).toEqual([]);
    expect(validateCollectorConfig(load(collectorYaml(entities)) as CollectorConfig)).toEqual([]);
  });

  test("collectorTopology reports the GenAI semconv pin for the components that use it", () => {
    const topo = collectorTopologyOf(genAiPipeline());
    expect(topo.semconv).toEqual([
      {
        namespace: "gen_ai",
        source: GENAI_SEMCONV_PIN.source,
        version: GENAI_SEMCONV_PIN.version,
        components: ["transform/genai_content", "redaction/genai_content", "filter/genai_spans", "spanmetrics/genai", "sum/genai_tokens"],
      },
    ]);
    expect(GENAI_SEMCONV_PIN).toEqual({ source: "github.com/open-telemetry/semantic-conventions", version: "v1.41.1" });
    // Component types keep the collector pin.
    expect(topo.components.find((c) => c.id === "sum/genai_tokens")?.schema).toEqual(COLLECTOR_PIN);
    // With content kept the metrics still use the vocabulary.
    expect(collectorTopologyOf(genAiPipeline({ keepContent: true })).semconv[0].components).toEqual([
      "filter/genai_spans",
      "spanmetrics/genai",
      "sum/genai_tokens",
    ]);
  });

  test("a parsed YAML file gives the same topology as the declaration", () => {
    for (const options of [{}, { clientMetrics: "derive" }] satisfies GenAiPipelineOptions[]) {
      const entities = genAiPipeline(options);
      expect(collectorTopology(load(collectorYaml(entities)) as CollectorConfig)).toEqual(collectorTopologyOf(entities));
    }
  });

  test("the YAML says which semconv version its keys follow", () => {
    const yaml = collectorYaml(genAiPipeline());
    expect(yaml.split("\n")[0]).toBe(
      "# chant: semconv gen_ai github.com/open-telemetry/semantic-conventions@v1.41.1 (transform/genai_content, redaction/genai_content, filter/genai_spans, spanmetrics/genai, sum/genai_tokens)",
    );
  });

  test("a config without gen_ai keys has no semconv entry and no header", () => {
    const entities = otlpCollector();
    expect(collectorTopologyOf(entities).semconv).toEqual([]);
    expect(buildCollectorConfig(entities).header).toEqual([]);
    expect(semconvUsage({ processors: { "attributes/x": { actions: [{ key: "my_gen_ai.x", action: "delete" }] } } })).toEqual([]);
  });
});

describe("SumConnector", () => {
  const problems = (c: InstanceType<typeof SumConnector>) =>
    validateCollectorEntities([c]).filter((i) => i.code === "OTEL107").map((i) => i.message);

  test("needs a source attribute and at least one metric", () => {
    expect(problems(new SumConnector({}))).toEqual(['connector "sum": no metric is configured, so the connector emits nothing']);
    expect(problems(new SumConnector({ spans: { x: { source_attribute: "" } } }))).toEqual([
      'connector "sum": spans.x: source_attribute is missing',
    ]);
    expect(
      problems(new SumConnector({ datapoints: { y: { source_attribute: "v" } }, metrics: { z: { source_attribute: "v", attributes: [{ key: "k" }] } } })),
    ).toEqual(['connector "sum": metrics.z: attributes are not supported when summing metrics']);
    expect(problems(new SumConnector({ spans: { t: { source_attribute: "v", attributes: [{ key: "a" }, { key: "b" }] } } }))).toEqual([
      'connector "sum": spans.t: more than one attribute multiplies each sum by the number of attributes in the pinned collector; split by one attribute',
    ]);
  });

  test("connects traces, metrics and logs to metrics", () => {
    expect(SumConnector.definition.connects).toEqual([
      { from: "traces", to: "metrics" },
      { from: "metrics", to: "metrics" },
      { from: "logs", to: "metrics" },
    ]);
    expect(SumConnector.definition.pin).toBe(COLLECTOR_PIN);
  });
});

describe.skipIf(!OTELCOL)(`otelcol${OTELCOL ? "" : " (skipped: no otelcol-contrib on PATH and no OTELCOL_BIN)"}`, () => {
  test.each(variants())("otelcol validate accepts the %s preset", (_label, options) => {
    const { ok, output } = otelcolValidate(collectorYaml(genAiPipeline(options)));
    expect(output).toBe("");
    expect(ok).toBe(true);
  });

  test("the running collector drops content unless kept, and emits the named metrics", async () => {
    const removed = await runCollector({});
    for (const secret of SECRETS) expect(removed.output).not.toContain(secret);
    expect(removed.output).toContain("gen_ai.prompt.name: Str(keep-me)");
    const m = genAiMetrics();
    expect(removed.metrics).toMatch(new RegExp(`^${m.calls.prometheus}\\{.*gen_ai_tool_name="search".*status_code="STATUS_CODE_ERROR".*\\} 1$`, "m"));
    expect(removed.metrics).toMatch(new RegExp(`^${m.duration.prometheus}_count\\{.*gen_ai_operation_name="chat".*\\} 1$`, "m"));
    // 120 from the chat span; the in-process invoke_agent span's aggregate is not added again.
    expect(removed.metrics).toMatch(new RegExp(`^${m.inputTokens.prometheus}\\{.*gen_ai_request_model="m1".*\\} 120$`, "m"));
    expect(removed.metrics).toMatch(new RegExp(`^${m.outputTokens.prometheus}\\{.*\\} 30$`, "m"));
    // Spans without gen_ai.operation.name are not counted.
    expect(removed.metrics).not.toContain('span_name="GET /health"');

    const kept = await runCollector({ keepContent: true });
    for (const secret of SECRETS) expect(kept.output).toContain(secret);
  }, 60_000);

  test("derived client metrics split tokens by provider and model without doubling, and skip agent aggregates", async () => {
    const { metrics } = await runCollector({ clientMetrics: "derive" }, clientPayload());
    const client = genAiMetrics({ clientMetrics: "derive" }).client!;
    const value = (series: string, labels: Record<string, string>): number[] =>
      metrics
        .split("\n")
        .filter((l) => l.startsWith(`${series}{`) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
        .map((l) => Number(l.slice(l.lastIndexOf(" ") + 1)));
    const tokens = `${client.tokenUsage.prometheus}_sum`;
    // Two openai m1 calls of 100 and 10, one anthropic m2 call of 50 and 5; the invoke_agent span's 1000 are not added.
    expect(value(tokens, { gen_ai_provider_name: "openai", gen_ai_request_model: "m1", gen_ai_token_type: "input" })).toEqual([200]);
    expect(value(tokens, { gen_ai_provider_name: "openai", gen_ai_request_model: "m1", gen_ai_token_type: "output" })).toEqual([20]);
    expect(value(tokens, { gen_ai_provider_name: "anthropic", gen_ai_request_model: "m2", gen_ai_token_type: "input" })).toEqual([50]);
    expect(value(tokens, { gen_ai_token_type: "input" }).reduce((a, b) => a + b, 0)).toBe(250);
    expect(value(tokens, { gen_ai_operation_name: "invoke_agent" })).toEqual([]);
    const count = `${client.operationDuration.prometheus}_count`;
    expect(value(count, { gen_ai_provider_name: "openai", gen_ai_request_model: "m1", gen_ai_response_model: "m1-2025", server_port: "443" })).toEqual([2]);
    // A span without a provider is still timed, and the agent span is timed as its own operation.
    expect(value(count, { gen_ai_operation_name: "execute_tool", error_type: "timeout" })).toEqual([1]);
    expect(value(count, { gen_ai_operation_name: "invoke_agent" })).toEqual([1]);
    expect(value(`${client.operationDuration.prometheus}_bucket`, { gen_ai_request_model: "m2", le: "0.04" })).toEqual([1]);
  }, 60_000);
});

function variants(): Array<[string, GenAiPipelineOptions]> {
  return [
    ["default", {}],
    ["keepContent", { keepContent: true }],
    ["masked", { maskValues: ["secret-[a-z]+"], hashFunction: "sha3" }],
    ["sampled", { sampling: [new FilterProcessor({ name: "sampler", traces: { span: ["status.code != STATUS_CODE_ERROR"] } })] }],
    ["namespaced", { namespace: "agents.support", dimensions: [{ name: "gen_ai.agent.name" }], logs: false }],
    ["client metrics derived", { clientMetrics: "derive", providerDimensions: true }],
    ["client metrics passed through", { clientMetrics: "passthrough" }],
  ];
}

// ── A live run ───────────────────────────────────────────────────────

const SECRETS = ["SECRET-PROMPT", "SECRET-ANSWER", "SECRET-SYS", "SECRET-LEGACY", "SECRET-EVENT", "SECRET-ARGS", "SECRET-USER-EVENT", "SECRET-DETAILS"];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

function payloads() {
  const now = BigInt(Date.now()) * 1_000_000n;
  const span = (spanId: string, name: string, kind: number, attributes: unknown[], extra: Record<string, unknown> = {}) => ({
    traceId: "5b8efff798038103d269b633813fc60c",
    spanId,
    name,
    kind,
    startTimeUnixNano: String(now),
    endTimeUnixNano: String(now + 1_500_000_000n),
    attributes,
    ...extra,
  });
  const traces = {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "agent-demo")] },
        scopeSpans: [
          {
            scope: { name: "test" },
            spans: [
              span("eee19b7ec3c1b174", "invoke_agent planner", 1, [
                str("gen_ai.operation.name", "invoke_agent"),
                str("gen_ai.request.model", "m1"),
                int("gen_ai.usage.input_tokens", 1000),
                int("gen_ai.usage.output_tokens", 1000),
                str("gen_ai.input.messages", "SECRET-PROMPT"),
              ]),
              span(
                "eee19b7ec3c1b175",
                "chat m1",
                3,
                [
                  str("gen_ai.operation.name", "chat"),
                  str("gen_ai.request.model", "m1"),
                  str("gen_ai.prompt.name", "keep-me"),
                  str("gen_ai.prompt.0.content", "SECRET-LEGACY"),
                  int("gen_ai.usage.input_tokens", 120),
                  int("gen_ai.usage.output_tokens", 30),
                  str("gen_ai.output.messages", "SECRET-ANSWER"),
                  str("gen_ai.system_instructions", "SECRET-SYS"),
                ],
                {
                  parentSpanId: "eee19b7ec3c1b174",
                  events: [
                    {
                      name: "gen_ai.client.inference.operation.details",
                      timeUnixNano: String(now),
                      attributes: [str("gen_ai.input.messages", "SECRET-EVENT")],
                    },
                  ],
                },
              ),
              span(
                "eee19b7ec3c1b176",
                "execute_tool search",
                1,
                [
                  str("gen_ai.operation.name", "execute_tool"),
                  str("gen_ai.tool.name", "search"),
                  str("error.type", "timeout"),
                  str("gen_ai.tool.call.arguments", "SECRET-ARGS"),
                ],
                { parentSpanId: "eee19b7ec3c1b174", status: { code: 2 } },
              ),
              span("eee19b7ec3c1b177", "GET /health", 2, []),
            ],
          },
        ],
      },
    ],
  };
  const logs = {
    resourceLogs: [
      {
        resource: { attributes: [str("service.name", "agent-demo")] },
        scopeLogs: [
          {
            scope: { name: "test" },
            logRecords: [
              {
                timeUnixNano: String(now),
                eventName: "gen_ai.user.message",
                body: { kvlistValue: { values: [str("role", "user"), str("content", "SECRET-USER-EVENT")] } },
              },
              {
                timeUnixNano: String(now),
                eventName: "gen_ai.client.inference.operation.details",
                attributes: [str("gen_ai.output.messages", "SECRET-DETAILS")],
              },
            ],
          },
        ],
      },
    ],
  };
  return { traces, logs };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the collector");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Spans for the client metrics: known token counts across two providers, an agent aggregate and a tool call. */
function clientPayload() {
  const { traces } = payloads();
  const [base] = traces.resourceSpans[0]!.scopeSpans[0]!.spans as Array<Record<string, any>>;
  const now = BigInt(base!.startTimeUnixNano);
  let id = 0;
  const span = (name: string, kind: number, attributes: unknown[], ms: number, extra: Record<string, unknown> = {}) => ({
    traceId: "6b8efff798038103d269b633813fc60c",
    spanId: (0xeee19b7ec3c1b200n + BigInt(id++)).toString(16),
    name,
    kind,
    startTimeUnixNano: String(now),
    endTimeUnixNano: String(now + BigInt(ms) * 1_000_000n),
    attributes,
    ...extra,
  });
  const chat = (provider: string, model: string, input: number, output: number, ms: number) =>
    span(`chat ${model}`, 3, [
      str("gen_ai.operation.name", "chat"),
      str("gen_ai.provider.name", provider),
      str("gen_ai.request.model", model),
      str("gen_ai.response.model", `${model}-2025`),
      str("server.address", "api.example.com"),
      int("server.port", 443),
      int("gen_ai.usage.input_tokens", input),
      int("gen_ai.usage.output_tokens", output),
    ], ms);
  const spans = [
    span("invoke_agent planner", 1, [
      str("gen_ai.operation.name", "invoke_agent"),
      str("gen_ai.provider.name", "openai"),
      str("gen_ai.request.model", "m1"),
      int("gen_ai.usage.input_tokens", 1000),
      int("gen_ai.usage.output_tokens", 1000),
    ], 5000),
    chat("openai", "m1", 100, 10, 1500),
    chat("openai", "m1", 100, 10, 300),
    chat("anthropic", "m2", 50, 5, 30),
    span("execute_tool search", 1, [str("gen_ai.operation.name", "execute_tool"), str("gen_ai.tool.name", "search"), str("error.type", "timeout")], 70, {
      status: { code: 2 },
    }),
  ];
  return { resourceSpans: [{ resource: { attributes: [str("service.name", "agent-demo")] }, scopeSpans: [{ scope: { name: "test" }, spans }] }] };
}

async function runCollector(options: GenAiPipelineOptions, tracesOverride?: unknown): Promise<{ output: string; metrics: string }> {
  const [grpc, http, prom] = [await freePort(), await freePort(), await freePort()];
  const detail = new DebugExporter({ name: "detail", verbosity: "detailed" });
  const yaml = collectorYaml(
    genAiPipeline({
      ...options,
      traceExporters: [detail],
      logExporters: [detail],
      metricExporters: [new PrometheusExporter({ endpoint: `127.0.0.1:${prom}` })],
      metricsFlushInterval: "500ms",
      healthCheck: false,
    }),
  )
    .replace("0.0.0.0:4317", `127.0.0.1:${grpc}`)
    .replace("0.0.0.0:4318", `127.0.0.1:${http}`);
  const dir = mkdtempSync(join(tmpdir(), "chant-genai-run-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, yaml);
  const child = spawn(OTELCOL!, [`--config=${file}`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += String(d)));
  child.stderr.on("data", (d) => (output += String(d)));
  try {
    const { traces: defaultTraces, logs } = payloads();
    const traces = tracesOverride ?? defaultTraces;
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${http}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await waitFor(async () => ((await post("/v1/traces", traces)).ok ? true : undefined), 20_000);
    await post("/v1/logs", logs);
    const metrics = await waitFor(async () => {
      const text = await (await fetch(`http://127.0.0.1:${prom}/metrics`)).text();
      // The prometheus exporter serves a new cumulative series at 0 on its first scrape.
      return /^genai_calls_total\{[^}]*span_name="execute_tool search"[^}]*\} 1$/m.test(text) &&
        text.includes("genai_tokens_output_total")
        ? text
        : undefined;
    }, 20_000);
    await waitFor(async () => (output.includes("gen_ai.user.message") ? true : undefined), 10_000);
    return { output, metrics };
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
