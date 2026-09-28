import { describe, expect, test } from "vitest";
import type { CollectorConfig } from "../model";
import { builtinClassName, generateCollectorFiles, OtelCollectorGenerator, tsLiteral } from "./generator";
import { OtelCollectorParser } from "./parser";

const files = (config: CollectorConfig, meta = {}) =>
  Object.fromEntries(generateCollectorFiles(config, meta).map((f) => [f.path, f.content]));

describe("builtinClassName", () => {
  test("maps every built-in kind and type to its exported class", () => {
    expect(builtinClassName("receiver", "otlp")).toBe("OtlpReceiver");
    expect(builtinClassName("exporter", "otlp")).toBe("OtlpExporter");
    expect(builtinClassName("processor", "tail_sampling")).toBe("TailSamplingProcessor");
    expect(builtinClassName("connector", "spanmetrics")).toBe("SpanMetricsConnector");
    expect(builtinClassName("connector", "sum")).toBe("SumConnector");
    expect(builtinClassName("receiver", "k8s_cluster")).toBe("K8sClusterReceiver");
    expect(builtinClassName("extension", "health_check")).toBe("HealthCheckExtension");
    expect(builtinClassName("exporter", "datadog")).toBeUndefined();
  });
});

describe("tsLiteral", () => {
  test("writes plain keys bare, quotes the rest, and prefers single quotes for OTTL", () => {
    expect(tsLiteral({ a: 1, "b.c": true, d: null }, 0)).toBe('{ a: 1, "b.c": true, d: null }');
    expect(tsLiteral('attributes["x"] == "y"', 0)).toBe(`'attributes["x"] == "y"'`);
    expect(tsLiteral(`it's "both"`, 0)).toBe(JSON.stringify(`it's "both"`));
    expect(tsLiteral("${env:X}", 0)).toBe('"${env:X}"');
  });

  test("breaks a value across lines past 100 columns", () => {
    const out = tsLiteral({ list: Array.from({ length: 12 }, (_, i) => `item-${i}`) }, 0);
    expect(out.split("\n").length).toBeGreaterThan(1);
    expect(out.split("\n").every((l) => l.length <= 100)).toBe(true);
  });
});

describe("generateCollectorFiles", () => {
  test("one module per section, pipelines importing what they reference", () => {
    const out = files({
      receivers: { otlp: { protocols: { grpc: null } } },
      processors: { batch: null },
      exporters: { "otlp/tempo": { endpoint: "tempo:4317" } },
      service: { pipelines: { traces: { receivers: ["otlp"], processors: ["batch"], exporters: ["otlp/tempo"] } } },
    });
    expect(Object.keys(out)).toEqual(["receivers.ts", "processors.ts", "exporters.ts", "pipelines.ts"]);
    expect(out["receivers.ts"]).toContain('const otlpProtocols: OtlpReceiverConfig["protocols"] = { grpc: null };');
    expect(out["receivers.ts"]).toContain("const otlp = new OtlpReceiver({ protocols: otlpProtocols });");
    expect(out["receivers.ts"]).toContain("export { otlp };");
    expect(out["processors.ts"]).toContain("const batch = new BatchProcessor();");
    expect(out["exporters.ts"]).toContain('const otlpTempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317" });');
    expect(out["pipelines.ts"]).toContain('import { otlpTempo } from "./exporters";');
    expect(out["pipelines.ts"]).toContain(
      [
        "const traces = new Pipeline({",
        '  signal: "traces",',
        "  receivers: [otlp],",
        "  processors: [batch],",
        "  exporters: [otlpTempo],",
        "});",
      ].join("\n"),
    );
    expect(out["pipelines.ts"]).toContain("export { traces };");
  });

  test("an id shared across kinds gets a kind suffix; a connector is one constant on both sides", () => {
    const out = files({
      receivers: { otlp: {}, prometheus: { config: { scrape_configs: [] } } },
      exporters: { otlp: { endpoint: "x:4317" }, prometheus: { endpoint: "0.0.0.0:8889" } },
      connectors: { spanmetrics: {} },
      service: {
        pipelines: {
          traces: { receivers: ["otlp"], exporters: ["otlp", "spanmetrics"] },
          metrics: { receivers: ["prometheus", "spanmetrics"], exporters: ["prometheus"] },
        },
      },
    });
    expect(out["receivers.ts"]).toContain("const otlpReceiver = new OtlpReceiver();");
    expect(out["exporters.ts"]).toContain('const otlpExporter = new OtlpExporter({ endpoint: "x:4317" });');
    expect(out["pipelines.ts"]).toContain("  receivers: [otlpReceiver],\n  exporters: [otlpExporter, spanmetrics],");
    expect(out["pipelines.ts"]).toContain("  receivers: [prometheusReceiver, spanmetrics],\n  exporters: [prometheusExporter],");
    expect(out["pipelines.ts"]).toContain('import { spanmetrics } from "./connectors";');
  });

  test("a component type chant does not ship is defined once with defineComponent and COLLECTOR_PIN", () => {
    const out = files({
      exporters: { "datadog/a": { api: { key: "${env:DD}" } }, "datadog/b": {}, otlp_http: {} },
      service: { pipelines: { logs: { receivers: [], exporters: ["datadog/a", "datadog/b", "otlp_http"] } } },
    });
    const custom = out["custom-components.ts"];
    expect(custom).toContain('import { COLLECTOR_PIN, defineComponent } from "@intentius/chant-lexicon-otel";');
    expect(custom.match(/defineComponent<Record<string, unknown>>\(\)/g)).toHaveLength(2);
    expect(custom).toContain('const DatadogExporter = defineComponent<Record<string, unknown>>()({\n  kind: "exporter",\n  type: "datadog",\n  pin: COLLECTOR_PIN,\n});');
    // `OtlpHttpExporter` is the built-in otlphttp exporter's class, so this one is numbered.
    expect(custom).toContain("const OtlpHttpExporter2 = defineComponent");
    expect(custom).toContain("export { DatadogExporter, OtlpHttpExporter2 };");
    expect(out["exporters.ts"]).toContain('import { DatadogExporter, OtlpHttpExporter2 } from "./custom-components";');
    expect(out["exporters.ts"]).toContain("const datadogAApi = { key: \"${env:DD}\" };");
    expect(out["exporters.ts"]).toContain('const datadogA = new DatadogExporter({ name: "a", api: datadogAApi });');
  });

  test("a pin named by the header replaces COLLECTOR_PIN", () => {
    const out = files(
      { exporters: { "acme/x": {} } },
      { pins: [{ kind: "exporter", id: "acme/x", pin: { source: "@acme/otel", version: "2.0.0", digest: "sha256:1" } }] },
    );
    expect(out["custom-components.ts"]).toContain('pin: { source: "@acme/otel", version: "2.0.0", digest: "sha256:1" },');
    expect(out["custom-components.ts"]).not.toContain("COLLECTOR_PIN");
  });

  test("a Service only when extensions or telemetry differ from the default", () => {
    const ext = { health_check: null, zpages: null };
    expect(files({ extensions: ext, service: { extensions: ["health_check", "zpages"] } })["service.ts"]).toBeUndefined();
    expect(files({ extensions: ext, service: { extensions: ["zpages", "health_check"] } })["service.ts"]).toContain(
      "const service = new Service({ extensions: [zpages, healthCheck] });",
    );
    // Declared but not enabled: an empty list, so the rebuilt config enables none either.
    expect(files({ extensions: ext })["service.ts"]).toContain("const service = new Service({ extensions: [] });");
    const withTelemetry = files({ service: { telemetry: { logs: { level: "warn" } } } })["service.ts"];
    expect(withTelemetry).toContain('const telemetry: ServiceTelemetry = { logs: { level: "warn" } };');
    expect(withTelemetry).toContain("const service = new Service({ telemetry });");
  });

  test("more than eight declarables of one section split into numbered modules", () => {
    const processors = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`batch/b${i}`, null]));
    const out = files({ processors });
    expect(Object.keys(out)).toEqual(["processors-1.ts", "processors-2.ts"]);
    expect(out["processors-1.ts"].match(/new BatchProcessor/g)).toHaveLength(8);
    expect(out["processors-2.ts"].match(/new BatchProcessor/g)).toHaveLength(2);
  });

  test("an id nothing declares stays a string; a signal Pipeline does not type is suppressed with a reason", () => {
    const out = files({ service: { pipelines: { "profiles/x": { receivers: ["otlp"], exporters: ["debug"] } } } });
    expect(out["pipelines.ts"]).toContain(
      [
        "const profilesX = new Pipeline({",
        '  // @ts-expect-error "profiles" is a collector signal Pipeline does not type',
        '  signal: "profiles",',
        '  name: "x",',
        '  receivers: ["otlp"],',
        '  exporters: ["debug"],',
        "});",
      ].join("\n"),
    );
  });

  test("names are valid identifiers even from awkward ids", () => {
    const out = files({
      exporters: { "otlp/2": { endpoint: "a:1" }, "otlp/my-backend.eu": { endpoint: "b:1" }, "debug/new": {} },
      service: { pipelines: { "traces/default": { receivers: [], exporters: ["otlp/2"] } } },
    });
    expect(out["exporters.ts"]).toContain("const otlp2 = new OtlpExporter(");
    expect(out["exporters.ts"]).toContain("const otlpMyBackendEu = new OtlpExporter(");
    expect(out["exporters.ts"]).toContain("const debugNew = new DebugExporter(");
    expect(out["pipelines.ts"]).toContain("const tracesDefault = new Pipeline(");
  });
});

describe("OtelCollectorGenerator", () => {
  test("generates from the parser's IR, and returns a file for an empty config", () => {
    const gen = new OtelCollectorGenerator();
    const ir = new OtelCollectorParser().parse("receivers:\n  otlp: {}\n");
    expect(gen.generate(ir).map((f) => f.path)).toEqual(["receivers.ts"]);
    expect(gen.generate({ resources: [], parameters: [] })).toHaveLength(1);
  });
});
