/**
 * Type-level guarantees of the otel lexicon's hand-written types: what
 * TypeScript rejects before a build runs. Each `@ts-expect-error` line is a
 * mistake the types must keep catching; tsc fails on the directive if the
 * line ever compiles (`tsconfig.typecheck.json`, scripts/typecheck.ts). The
 * runtime assertions keep vitest's view of the file honest.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  BatchProcessor,
  DebugExporter,
  HealthCheckExtension,
  MemoryLimiterProcessor,
  NodeAgent,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
  Service,
  SpanMetricsConnector,
  TailSamplingProcessor,
  defineComponent,
  type PipelineEntity,
  type TailSamplingPolicy,
} from "./index";
import { generate } from "./codegen/generate";

const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
const batch = new BatchProcessor({});
const debug = new DebugExporter({ verbosity: "basic" });
const health = new HealthCheckExtension({});
const spanmetrics = new SpanMetricsConnector({});

describe("pipelines take components of the right kind", () => {
  test("receivers, processors and exporters in their own slots; a connector on either side", () => {
    const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch], exporters: [debug, spanmetrics] });
    const metrics = new Pipeline({ signal: "metrics", receivers: [spanmetrics], exporters: [debug] });
    expectTypeOf(traces).toEqualTypeOf<PipelineEntity>();
    expect(traces.pipelineId).toBe("traces");
    expect(metrics.pipelineId).toBe("metrics");
  });

  test("a component of the wrong kind is a type error", () => {
    // @ts-expect-error a receiver is not an exporter
    new Pipeline({ signal: "traces", receivers: [otlp], exporters: [otlp] });
    // @ts-expect-error an exporter is not a processor
    new Pipeline({ signal: "traces", receivers: [otlp], processors: [debug], exporters: [debug] });
    // @ts-expect-error an extension is not a receiver
    new Pipeline({ signal: "traces", receivers: [health], exporters: [debug] });
    // @ts-expect-error a processor is not an extension
    new Service({ extensions: [batch] });
    expect(true).toBe(true);
  });

  test("the signal is one the collector knows", () => {
    // @ts-expect-error "spans" is not a signal; "traces" is
    new Pipeline({ signal: "spans", receivers: [otlp], exporters: [debug] });
    expect(true).toBe(true);
  });
});

describe("component configs are typed", () => {
  test("a wrongly typed setting is a type error", () => {
    // @ts-expect-error limit_mib is a number
    new MemoryLimiterProcessor({ check_interval: "1s", limit_mib: "400" });
    // @ts-expect-error verbosity is basic, normal or detailed
    new DebugExporter({ verbosity: "verbose" });
    // @ts-expect-error tls is an object, not a flag
    new OtlpExporter({ endpoint: "tempo:4317", tls: true });
    expect(true).toBe(true);
  });

  test("tail sampling policies are discriminated by type", () => {
    const errors: TailSamplingPolicy = { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } };
    // @ts-expect-error a latency policy carries its settings under `latency`
    const wrong: TailSamplingPolicy = { name: "slow", type: "latency", probabilistic: { sampling_percentage: 10 } };
    // @ts-expect-error decision_wait is required
    new TailSamplingProcessor({ policies: [errors] });
    expect(wrong.name).toBe("slow");
  });

  test("a custom component's config type follows its definition", () => {
    const Vendor = defineComponent<{ token: string }>()({
      kind: "exporter",
      type: "vendor",
      pin: { source: "github.com/example/vendorexporter", version: "v1.0.0" },
    });
    new Vendor({ token: "${env:VENDOR_TOKEN}" });
    // @ts-expect-error token is a string
    new Vendor({ token: 42 });
    expect(Vendor.definition.type).toBe("vendor");
  });
});

describe("NodeAgent props", () => {
  test("exporters are required and must be exporters", () => {
    const agent = NodeAgent({ exporters: [debug] });
    expectTypeOf(agent.traces).toEqualTypeOf<PipelineEntity>();
    // @ts-expect-error exporters is required
    expect(() => NodeAgent({})).toThrow(/exporters/);
    // @ts-expect-error a receiver is not an exporter
    NodeAgent({ exporters: [otlp] });
    // @ts-expect-error hostMetrics is a switch or its settings
    NodeAgent({ exporters: [debug], hostMetrics: "on" });
  });
});

describe("the packaged types entry", () => {
  test("re-exports the package's own declarations", async () => {
    const result = await generate();
    expect(result.typesDTS).toContain('export * from "../index"');
  });
});
