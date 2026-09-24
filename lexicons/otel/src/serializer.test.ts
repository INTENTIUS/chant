import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { otelSerializer } from "./serializer";
import {
  BatchProcessor,
  DebugExporter,
  GoogleCloudExporter,
  HealthCheckExtension,
  MemoryLimiterProcessor,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
  PprofExtension,
  Service,
} from "./index";

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

function primary(out: ReturnType<typeof otelSerializer.serialize>): string {
  return typeof out === "string" ? out : out.primary;
}

describe("otel serializer", () => {
  // 1, 2
  test("name and rule prefix", () => {
    expect(otelSerializer.name).toBe("otel");
    expect(otelSerializer.rulePrefix).toBe("OTEL");
  });

  // 3
  test("an empty map serializes to the empty string", () => {
    expect(otelSerializer.serialize(new Map())).toBe("");
  });

  // 4
  test("a minimal traces pipeline", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const debug = new DebugExporter({ verbosity: "basic" });
    const out = otelSerializer.serialize(
      entities({ otlp, debug, traces: new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug] }) }),
    );
    expect(out).toBe(`receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  debug:
    verbosity: basic

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`);
  });

  // 5, 6: the collector id comes from the type and the instance name, never the export name
  test("the export name does not leak into the id; an instance name makes type/name", () => {
    const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317" });
    const plain = new OtlpExporter({ endpoint: "other:4317" });
    const yaml = primary(otelSerializer.serialize(entities({ myTempoExporter: tempo, anotherOne: plain })));
    const parsed = load(yaml) as any;
    expect(Object.keys(parsed.exporters)).toEqual(["otlp/tempo", "otlp"]);
    expect(yaml).not.toContain("myTempoExporter");
    expect(parsed.exporters["otlp/tempo"]).toEqual({ endpoint: "tempo:4317" });
  });

  // 7
  test("several pipelines, in declaration order, sharing components", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {}, http: {} } });
    const batch = new BatchProcessor({});
    const debug = new DebugExporter({});
    const parsed = load(
      primary(
        otelSerializer.serialize(
          entities({
            otlp,
            batch,
            debug,
            logs: new Pipeline({ signal: "logs", receivers: [otlp], processors: [batch], exporters: [debug] }),
            traces: new Pipeline({ signal: "traces", name: "debug", receivers: [otlp], exporters: [debug] }),
          }),
        ),
      ),
    ) as any;
    expect(Object.keys(parsed.service.pipelines)).toEqual(["logs", "traces/debug"]);
    expect(parsed.service.pipelines["traces/debug"].processors).toBeUndefined();
    expect(parsed.receivers.otlp).toEqual({ protocols: { grpc: {}, http: {} } });
  });

  // 8
  test("declared extensions are enabled by default, in declaration order", () => {
    const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });
    const pprof = new PprofExtension({});
    const parsed = load(primary(otelSerializer.serialize(entities({ health, pprof })))) as any;
    expect(parsed.service.extensions).toEqual(["health_check", "pprof"]);
  });

  // 9
  test("a Service that lists extensions wins over the default, and carries telemetry", () => {
    const health = new HealthCheckExtension({});
    const pprof = new PprofExtension({});
    const parsed = load(
      primary(
        otelSerializer.serialize(
          entities({ health, pprof, service: new Service({ extensions: [health], telemetry: { logs: { level: "warn" } } }) }),
        ),
      ),
    ) as any;
    expect(parsed.service.extensions).toEqual(["health_check"]);
    expect(parsed.service.telemetry).toEqual({ logs: { level: "warn" } });
  });

  // 10
  test("a component a pipeline references but nobody listed is still emitted", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const debug = new DebugExporter({});
    const parsed = load(
      primary(otelSerializer.serialize(entities({ traces: new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug] }) }))),
    ) as any;
    expect(Object.keys(parsed.receivers)).toEqual(["otlp"]);
    expect(Object.keys(parsed.exporters)).toEqual(["debug"]);
  });

  // 11
  test("sections come out in collector order whatever the declaration order", () => {
    const debug = new DebugExporter({});
    const health = new HealthCheckExtension({});
    const limiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_mib: 400 });
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const yaml = primary(
      otelSerializer.serialize(
        entities({
          traces: new Pipeline({ signal: "traces", receivers: [otlp], processors: [limiter], exporters: [debug] }),
          debug,
          health,
          limiter,
          otlp,
        }),
      ),
    );
    const sections = yaml.split("\n").filter((l) => /^[a-z]/.test(l));
    expect(sections).toEqual(["receivers:", "processors:", "exporters:", "extensions:", "service:"]);
  });

  // 12a: the output parses back to what was declared
  test("round-trips through a YAML parser, including values that need quoting", () => {
    const exporter = new OtlpExporter({
      name: "vendor",
      endpoint: "api.vendor.example:443",
      headers: { "x-api-key": "${env:VENDOR_KEY}", "x-tenant": "true", "x-shard": "0012" },
      compression: "gzip",
      retry_on_failure: { enabled: true, max_elapsed_time: "300s" },
    });
    const gc = new GoogleCloudExporter({ project: "my-project", metric: { known_domains: ["a,b", "c"] } });
    const parsed = load(primary(otelSerializer.serialize(entities({ exporter, gc })))) as any;
    expect(parsed.exporters["otlp/vendor"].headers).toEqual({
      "x-api-key": "${env:VENDOR_KEY}",
      "x-tenant": "true",
      "x-shard": "0012",
    });
    expect(parsed.exporters["otlp/vendor"].retry_on_failure).toEqual({ enabled: true, max_elapsed_time: "300s" });
    expect(parsed.exporters.googlecloud.metric.known_domains).toEqual(["a,b", "c"]);
  });

  // 12b
  test("two components with one id: the first is emitted and a warning says so", () => {
    const a = new DebugExporter({ verbosity: "basic" });
    const b = new DebugExporter({ verbosity: "detailed" });
    const out = otelSerializer.serialize(entities({ a, b }));
    expect(typeof out).toBe("object");
    const result = out as { primary: string; warnings?: string[] };
    expect((load(result.primary) as any).exporters.debug).toEqual({ verbosity: "basic" });
    expect(result.warnings?.[0]).toContain('declare the id "debug"');
  });

  test("non-otel entities are ignored", () => {
    const foreign = { lexicon: "k8s", entityType: "K8s::Core::ConfigMap", kind: "resource", props: {} } as unknown as Declarable;
    expect(otelSerializer.serialize(entities({ foreign }))).toBe("");
  });
});
