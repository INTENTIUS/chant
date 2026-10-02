import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import {
  BatchProcessor,
  CountConnector,
  DebugExporter,
  ForwardConnector,
  OtlpReceiver,
  PrometheusExporter,
  RoutingConnector,
  ServiceGraphConnector,
  SignalToMetricsConnector,
  SpanMetricsConnector,
  SumConnector,
  signalToMetricsEntries,
  type SignalToMetricsConnectorConfig,
} from "./components";
import { collectorYaml } from "./collector";
import { COLLECTOR_PIN, componentEntityType, defineComponent } from "./define";
import { COMPONENT_KINDS, SECTION_OF, type CollectorConfig } from "./model";
import { Pipeline } from "./pipeline";
import { collectorTopology, collectorTopologyOf } from "./topology";
import { validateCollectorConfig, validateCollectorEntities } from "./validate-config";
import { otel101 } from "./lint/post-synth/otel101";
import { otel103 } from "./lint/post-synth/otel103";
import { otel112 } from "./lint/post-synth/otel112";

/** A traces pipeline feeding a metrics pipeline through spanmetrics: the issue's acceptance case. */
function spanMetricsCollector(): Declarable[] {
  const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
  const batch = new BatchProcessor({});
  const spanmetrics = new SpanMetricsConnector({
    dimensions: [{ name: "http.route" }],
    histogram: { unit: "ms", explicit: { buckets: ["5ms", "50ms", "500ms", "5s"] } },
    metrics_flush_interval: "15s",
  });
  const tempo = new DebugExporter({ name: "traces", verbosity: "basic" });
  const prom = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
  return [
    otlp,
    batch,
    spanmetrics,
    tempo,
    prom,
    new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch], exporters: [tempo, spanmetrics] }),
    new Pipeline({ signal: "metrics", name: "spanmetrics", receivers: [spanmetrics], processors: [batch], exporters: [prom] }),
  ];
}

function ctxFor(yaml: string) {
  return makePostSynthCtx("otel", yaml);
}

describe("connector as a component kind", () => {
  test("connector is a kind with its own section", () => {
    expect(COMPONENT_KINDS).toContain("connector");
    expect(SECTION_OF.connector).toBe("connectors");
    expect(componentEntityType("connector", "spanmetrics")).toBe("OTel::Connector::spanmetrics");
  });

  test("the built-ins are connectors pinned to the collector release", () => {
    for (const Cls of [
      SpanMetricsConnector,
      ServiceGraphConnector,
      RoutingConnector,
      ForwardConnector,
      CountConnector,
      SumConnector,
      SignalToMetricsConnector,
    ]) {
      expect(Cls.definition.kind).toBe("connector");
      expect(Cls.definition.builtin).toBe(true);
      expect(Cls.definition.pin).toEqual(COLLECTOR_PIN);
      expect(Cls.definition.connects?.length).toBeGreaterThan(0);
    }
    expect(SpanMetricsConnector.definition.connects).toEqual([{ from: "traces", to: "metrics" }]);
    expect(new ForwardConnector().componentId).toBe("forward");
  });

  test("serializes under connectors and on both sides of the pipelines it joins", () => {
    const yaml = collectorYaml(spanMetricsCollector());
    const config = load(yaml) as CollectorConfig;
    expect(Object.keys(config)).toEqual(["receivers", "processors", "exporters", "connectors", "service"]);
    expect(config.connectors).toEqual({
      spanmetrics: {
        dimensions: [{ name: "http.route" }],
        histogram: { unit: "ms", explicit: { buckets: ["5ms", "50ms", "500ms", "5s"] } },
        metrics_flush_interval: "15s",
      },
    });
    expect(config.service?.pipelines).toEqual({
      traces: { receivers: ["otlp"], processors: ["batch"], exporters: ["debug/traces", "spanmetrics"] },
      "metrics/spanmetrics": { receivers: ["spanmetrics"], processors: ["batch"], exporters: ["prometheus"] },
    });
    expect(validateCollectorConfig(config)).toEqual([]);
    expect(validateCollectorEntities(spanMetricsCollector())).toEqual([]);
  });

  test("collectorTopology returns the connector edge with the signal on each side", () => {
    const topo = collectorTopologyOf(spanMetricsCollector());
    expect(topo.edges).toEqual([
      { connector: "spanmetrics", from: "traces", fromSignal: "traces", to: "metrics/spanmetrics", toSignal: "metrics" },
    ]);
    const c = topo.components.find((x) => x.id === "spanmetrics")!;
    expect(c.kind).toBe("connector");
    expect(c.pipelines).toEqual(["traces", "metrics/spanmetrics"]);
    // A connector is not an exporter in the "where does telemetry go" list.
    expect(topo.exporters.map((e) => e.id)).toEqual(["debug/traces", "prometheus"]);
  });

  test("topology keeps only the signal pairs a connector supports", () => {
    const topo = collectorTopology({
      receivers: { otlp: {} },
      exporters: { debug: {} },
      connectors: { count: {}, "someconnector/x": {} },
      service: {
        pipelines: {
          traces: { receivers: ["otlp"], exporters: ["count", "someconnector/x"] },
          metrics: { receivers: ["count", "someconnector/x"], exporters: ["debug"] },
          logs: { receivers: ["count", "someconnector/x"], exporters: ["debug"] },
        },
      },
    });
    expect(topo.edges.map((e) => [e.connector, e.from, e.to])).toEqual([
      ["count", "traces", "metrics"],
      // No definition in this process: every pair is reported.
      ["someconnector/x", "traces", "metrics"],
      ["someconnector/x", "traces", "logs"],
    ]);
  });

  test("a custom connector comes in through defineComponent", () => {
    const Tee = defineComponent<{ copies?: number }>()({
      kind: "connector",
      type: "tee2895",
      pin: { source: "github.com/acme/teeconnector", version: "v1.2.0" },
      connects: [{ from: "logs", to: "logs" }],
    });
    const tee = new Tee({ copies: 2 });
    expect(tee.componentKind).toBe("connector");
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const debug = new DebugExporter({});
    const yaml = collectorYaml([
      new Pipeline({ signal: "logs", receivers: [otlp], exporters: [tee] }),
      new Pipeline({ signal: "logs", name: "copy", receivers: [tee], exporters: [debug] }),
    ]);
    expect(yaml).toContain("# chant: connector tee2895 schema github.com/acme/teeconnector@v1.2.0");
    expect(validateCollectorConfig(load(yaml) as CollectorConfig)).toEqual([]);
  });
});

describe("OTEL101 with connectors", () => {
  const base = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
connectors:
  spanmetrics: {}
service:
  pipelines:
`;

  test("a connector used on both sides is used", () => {
    const yaml = `${base}    traces:
      receivers: [otlp]
      exporters: [spanmetrics]
    metrics:
      receivers: [spanmetrics]
      exporters: [debug]
`;
    expect(otel101.check(ctxFor(yaml))).toEqual([]);
    expect(otel103.check(ctxFor(yaml))).toEqual([]);
  });

  test("a connector used only as an exporter fails", () => {
    const yaml = `${base}    traces:
      receivers: [otlp]
      exporters: [spanmetrics, debug]
`;
    const diags = otel101.check(ctxFor(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("spanmetrics");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("no pipeline lists it as a receiver");
  });

  test("a connector used only as a receiver fails", () => {
    const yaml = `${base}    metrics:
      receivers: [otlp, spanmetrics]
      exporters: [debug]
`;
    const diags = otel101.check(ctxFor(yaml));
    expect(diags.map((d) => d.entity)).toEqual(["spanmetrics"]);
    expect(diags[0].message).toContain("no pipeline lists it as an exporter");
  });

  test("a connector no pipeline lists is an OTEL103 warning", () => {
    const yaml = `${base}    traces:
      receivers: [otlp]
      exporters: [debug]
`;
    expect(otel101.check(ctxFor(yaml))).toEqual([]);
    expect(otel103.check(ctxFor(yaml)).map((d) => [d.entity, d.severity])).toEqual([["spanmetrics", "warning"]]);
  });
});

describe("OTEL112 connector signals", () => {
  test("spanmetrics cannot be the receiver of a traces pipeline", () => {
    const yaml = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
connectors:
  spanmetrics: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [spanmetrics]
    traces/out:
      receivers: [spanmetrics]
      exporters: [debug]
`;
    const diags = otel112.check(ctxFor(yaml));
    expect(diags.map((d) => d.message)).toEqual([
      'connector "spanmetrics" is an exporter in traces pipeline "traces", but no pipeline it feeds carries a signal spanmetrics makes from traces (it supports traces to metrics); the collector refuses to start',
      'connector "spanmetrics" is a receiver in traces pipeline "traces/out", but no pipeline feeding it carries a signal spanmetrics turns into traces (it supports traces to metrics); the collector refuses to start',
    ]);
    expect(diags.every((d) => d.severity === "error" && d.checkId === "OTEL112")).toBe(true);
    // One-sided use is OTEL101's, not this rule's.
    expect(otel101.check(ctxFor(yaml))).toEqual([]);
  });

  test("flags only the pipeline that pairs with nothing", () => {
    const yaml = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
connectors:
  servicegraph: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [servicegraph]
    logs:
      receivers: [otlp]
      exporters: [servicegraph]
    metrics:
      receivers: [servicegraph]
      exporters: [debug]
`;
    expect(otel112.check(ctxFor(yaml)).map((d) => [d.entity, d.message.split(",")[0]])).toEqual([
      ["servicegraph", 'connector "servicegraph" is an exporter in logs pipeline "logs"'],
    ]);
  });

  test("routing and forward keep the signal; count turns any signal into metrics", () => {
    const yaml = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
connectors:
  forward: {}
  count: {}
  routing:
    table:
      - condition: 'attributes["tenant"] == "a"'
        pipelines: [logs/a]
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [routing, count]
    logs/a:
      receivers: [routing]
      exporters: [forward]
    logs/b:
      receivers: [forward]
      exporters: [debug]
    metrics:
      receivers: [count]
      exporters: [debug]
`;
    expect(otel112.check(ctxFor(yaml))).toEqual([]);
    expect(otel101.check(ctxFor(yaml))).toEqual([]);
  });

  test("a connector with no definition in this process is not checked", () => {
    const config: CollectorConfig = {
      receivers: { otlp: {} },
      exporters: { debug: {} },
      connectors: { unknownconnector: {} },
      service: {
        pipelines: {
          traces: { receivers: ["otlp"], exporters: ["unknownconnector"] },
          logs: { receivers: ["unknownconnector"], exporters: ["debug"] },
        },
      },
    };
    expect(validateCollectorConfig(config)).toEqual([]);
  });
});

describe("connector config rules (OTEL107)", () => {
  test("routing needs a table whose routes each have a condition or statement and pipelines", () => {
    const routing = new RoutingConnector({
      table: [{ pipelines: [] }, { condition: "true", statement: "route()", pipelines: ["logs/a"] }],
    });
    const messages = validateCollectorEntities([routing]).map((i) => i.message);
    expect(messages).toEqual([
      'connector "routing": table[0]: set a condition or a statement',
      'connector "routing": table[0]: no pipelines',
      'connector "routing": table[1]: set a condition or a statement, not both',
    ]);
    expect(validateCollectorEntities([new RoutingConnector({ table: [] })]).map((i) => i.message)).toEqual([
      'connector "routing": table is empty',
    ]);
  });

  test("spanmetrics rejects both histogram kinds and a duplicate default dimension", () => {
    const sm = new SpanMetricsConnector({
      dimensions: [{ name: "span.kind" }],
      histogram: { explicit: {}, exponential: { max_size: 160 } },
    });
    expect(validateCollectorEntities([sm]).map((i) => i.message)).toEqual([
      'connector "spanmetrics": histogram: set explicit or exponential buckets, not both',
      'connector "spanmetrics": dimensions: "span.kind" is already a default dimension',
    ]);
  });

  test("count does not split metric counts by attribute", () => {
    const count = new CountConnector({ metrics: { "metric.count": { attributes: [{ key: "env" }] } } });
    expect(validateCollectorEntities([count]).map((i) => i.message)).toEqual([
      'connector "count": metrics.metric.count: attributes are not supported when counting metrics',
    ]);
  });
});

/** Spans into a duration histogram and logs into a count, both feeding one metrics pipeline through signaltometrics. */
function signalToMetricsCollector(): Declarable[] {
  const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
  const s2m = new SignalToMetricsConnector({
    name: "genai",
    spans: [
      {
        name: "gen_ai.client.operation.duration",
        description: "GenAI operation duration",
        unit: "s",
        conditions: ['attributes["gen_ai.operation.name"] != nil'],
        attributes: [{ key: "gen_ai.operation.name" }, { key: "gen_ai.request.model", default_value: "unknown" }, { key: "error.type", optional: true }],
        histogram: { buckets: [0.01, 0.1, 1, 10], value: "Double(Microseconds(end_time - start_time)) / 1000000.0" },
      },
    ],
    logs: [{ name: "logrecord.count", sum: { value: "1" } }],
  });
  const debug = new DebugExporter({ verbosity: "basic" });
  const prom = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
  return [
    otlp,
    s2m,
    debug,
    prom,
    new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug, s2m] }),
    new Pipeline({ signal: "logs", receivers: [otlp], exporters: [s2m] }),
    new Pipeline({ signal: "metrics", name: "genai", receivers: [s2m], exporters: [prom] }),
  ];
}

describe("signaltometrics", () => {
  const problems = (config: SignalToMetricsConnectorConfig) =>
    validateCollectorEntities([new SignalToMetricsConnector(config)]).map((i) => i.message);

  test("is typed against the pinned release and reads every signal into metrics", () => {
    expect(SignalToMetricsConnector.definition.type).toBe("signaltometrics");
    expect(SignalToMetricsConnector.definition.pin).toBe(COLLECTOR_PIN);
    expect(SignalToMetricsConnector.definition.connects).toEqual([
      { from: "traces", to: "metrics" },
      { from: "metrics", to: "metrics" },
      { from: "logs", to: "metrics" },
      { from: "profiles", to: "metrics" },
    ]);
  });

  test("serializes each signal's metric list, and the pipelines it joins pass every check", () => {
    const entities = signalToMetricsCollector();
    const config = load(collectorYaml(entities)) as CollectorConfig;
    expect(config.connectors?.["signaltometrics/genai"]).toEqual({
      spans: [
        {
          name: "gen_ai.client.operation.duration",
          description: "GenAI operation duration",
          unit: "s",
          conditions: ['attributes["gen_ai.operation.name"] != nil'],
          attributes: [
            { key: "gen_ai.operation.name" },
            { key: "gen_ai.request.model", default_value: "unknown" },
            { key: "error.type", optional: true },
          ],
          histogram: { buckets: [0.01, 0.1, 1, 10], value: "Double(Microseconds(end_time - start_time)) / 1000000.0" },
        },
      ],
      logs: [{ name: "logrecord.count", sum: { value: "1" } }],
    });
    expect(validateCollectorConfig(config)).toEqual([]);
    expect(validateCollectorEntities(entities)).toEqual([]);
    expect(collectorTopologyOf(entities).edges.map((e) => [e.from, e.to])).toEqual([
      ["traces", "metrics/genai"],
      ["logs", "metrics/genai"],
    ]);
  });

  test("OTEL112: it cannot feed a traces pipeline", () => {
    const yaml = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
connectors:
  signaltometrics:
    spans: [{name: n, sum: {value: "1"}}]
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [signaltometrics]
    traces/out:
      receivers: [signaltometrics]
      exporters: [debug]
`;
    expect(otel112.check(ctxFor(yaml)).map((d) => d.entity)).toEqual(["signaltometrics", "signaltometrics"]);
  });

  test("entries list each metric with the types it names", () => {
    const entries = signalToMetricsEntries({
      spans: [{ name: "a", sum: { value: "1" } }],
      datapoints: [{ name: "b", gauge: { value: "value_double" } }],
    });
    expect(entries.map((e) => [e.signal, e.index, e.metric.name, e.types])).toEqual([
      ["spans", 0, "a", ["sum"]],
      ["datapoints", 0, "b", ["gauge"]],
    ]);
  });

  test("OTEL107 passes valid entries of every metric type", () => {
    expect(
      problems({
        spans: [
          { name: "s.sum", sum: { value: "Int(AdjustedCount())" } },
          { name: "s.hist", histogram: { value: "Milliseconds(end_time - start_time)", count: "1" } },
          { name: "s.exp", exponential_histogram: { max_size: 160, value: "Microseconds(end_time - start_time)" } },
        ],
        logs: [{ name: "l.gauge", gauge: { value: 'ExtractGrokPatterns(body, "Memory usage %{NUMBER:memory_mb:int}MB")["memory_mb"]' } }],
        profiles: [{ name: "p.count", sum: { value: "1" } }],
      }),
    ).toEqual([]);
  });

  test("OTEL107: each entry names exactly one metric type, with a value", () => {
    const bad = {
      spans: [
        { name: "none" },
        { name: "two", sum: { value: "1" }, histogram: { value: "1" } },
        { name: "nohistvalue", histogram: { count: "1" } },
        { name: "nosumvalue", sum: {} },
      ],
    } as unknown as SignalToMetricsConnectorConfig;
    expect(problems(bad)).toEqual([
      'connector "signaltometrics": spans[0] (none): name exactly one metric type (sum, gauge, histogram or exponential_histogram); found none',
      'connector "signaltometrics": spans[1] (two): name exactly one metric type (sum, gauge, histogram or exponential_histogram); found sum and histogram',
      'connector "signaltometrics": spans[2] (nohistvalue): histogram.value is missing',
      'connector "signaltometrics": spans[3] (nosumvalue): sum.value is missing',
    ]);
  });

  test("OTEL107: names, attributes, buckets, max_size and grok selectors", () => {
    const bad = {
      logs: [
        { name: "", sum: { value: "1" } },
        {
          name: "attrs",
          attributes: [{ key: "a", default_value: "x", optional: true }, { key: "b" }, { key: "b" }, { key: "" }],
          histogram: { buckets: [1, 5, 5], value: "1" },
        },
        { name: "exp", exponential_histogram: { max_size: 1, value: "1" } },
        { name: "grok", gauge: { value: 'ExtractGrokPatterns(body, "%{NUMBER:n:int}")' } },
      ],
    } as unknown as SignalToMetricsConnectorConfig;
    expect(problems(bad)).toEqual([
      'connector "signaltometrics": logs[0]: name is missing',
      'connector "signaltometrics": logs[1] (attrs): histogram.buckets must increase',
      'connector "signaltometrics": logs[1] (attrs): attributes "a": set default_value or optional, not both',
      'connector "signaltometrics": logs[1] (attrs): attributes "b" is listed twice',
      'connector "signaltometrics": logs[1] (attrs): attributes[3]: key is missing',
      'connector "signaltometrics": logs[2] (exp): exponential_histogram.max_size must be between 2 and 16384',
      'connector "signaltometrics": logs[3] (grok): gauge.value with ExtractGrokPatterns needs one key selector, ExtractGrokPatterns(...)["key"]',
    ]);
  });

  test("OTEL107: a connector with no metrics", () => {
    expect(problems({})).toEqual([
      'connector "signaltometrics": no metric is configured under spans, datapoints, logs or profiles; the collector refuses the connector',
    ]);
  });

  test("the type allows exactly one metric type per entry", () => {
    // @ts-expect-error: two metric types
    const two: SignalToMetricsConnectorConfig = { spans: [{ name: "x", sum: { value: "1" }, gauge: { value: "1" } }] };
    // @ts-expect-error: no metric type
    const none: SignalToMetricsConnectorConfig = { spans: [{ name: "x" }] };
    expect([two, none]).toHaveLength(2);
  });
});

// `otelcol validate` is the acceptance test for the emitted YAML. CI has no
// collector binary, so this runs only when one is on PATH (the contrib build,
// which ships the connectors) and is skipped, with the reason shown, when not.
function collectorBinary(): string | undefined {
  const fromEnv = process.env.OTELCOL_BIN;
  const candidates = fromEnv ? [fromEnv] : ["otelcol-contrib", "otelcol"];
  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { stdio: "ignore" });
      return bin;
    } catch {
      // not installed under this name
    }
  }
  return undefined;
}

const otelcol = collectorBinary();

describe.skipIf(!otelcol)(
  `otelcol validate accepts a connector config${otelcol ? "" : " (skipped: no otelcol-contrib or otelcol on PATH)"}`,
  () => {
    test(`traces into metrics through spanmetrics validates (typed against ${COLLECTOR_PIN.version})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "chant-otel-connectors-"));
      try {
        const file = join(dir, "config.yaml");
        writeFileSync(file, collectorYaml(spanMetricsCollector()));
        expect(() => execFileSync(otelcol!, ["validate", `--config=${file}`], { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the signaltometrics example validates", () => {
      const dir = mkdtempSync(join(tmpdir(), "chant-otel-connectors-"));
      try {
        const file = join(dir, "config.yaml");
        writeFileSync(file, collectorYaml(signalToMetricsCollector()));
        expect(() => execFileSync(otelcol!, ["validate", `--config=${file}`], { stdio: "pipe" })).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a spanmetrics signal mismatch is refused by the collector too", () => {
      const dir = mkdtempSync(join(tmpdir(), "chant-otel-connectors-"));
      try {
        const file = join(dir, "config.yaml");
        const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
        const sm = new SpanMetricsConnector({});
        const debug = new DebugExporter({});
        writeFileSync(
          file,
          collectorYaml([
            new Pipeline({ signal: "traces", receivers: [otlp], exporters: [sm] }),
            new Pipeline({ signal: "traces", name: "out", receivers: [sm], exporters: [debug] }),
          ]),
        );
        expect(() => execFileSync(otelcol!, ["validate", `--config=${file}`], { stdio: "pipe" })).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
