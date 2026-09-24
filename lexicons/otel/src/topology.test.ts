import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { collectorTopology, collectorTopologyOf } from "./topology";
import { collectorYaml } from "./collector";
import {
  BatchProcessor,
  DebugExporter,
  GoogleCloudExporter,
  HealthCheckExtension,
  OtlpHttpExporter,
  OtlpReceiver,
  PrometheusExporter,
} from "./components";
import { Pipeline } from "./pipeline";
import type { CollectorConfig } from "./model";

describe("collectorTopology", () => {
  const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: {} } });
  const batch = new BatchProcessor({});
  const honeycomb = new OtlpHttpExporter({ name: "honeycomb", endpoint: "https://api.honeycomb.io" });
  const prom = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
  const gc = new GoogleCloudExporter({ project: "p1" });
  const debug = new DebugExporter({});
  const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });
  const entities = [
    otlp,
    batch,
    honeycomb,
    prom,
    gc,
    debug,
    health,
    new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch], exporters: [honeycomb, gc] }),
    new Pipeline({ signal: "metrics", receivers: [otlp], processors: [batch], exporters: [prom, gc] }),
    new Pipeline({ signal: "logs", name: "debug", receivers: [otlp], exporters: [debug] }),
  ];

  test("names every pipeline and where each exporter sends which signals", () => {
    const topo = collectorTopologyOf(entities);
    expect(topo.pipelines.map((p) => [p.id, p.signal])).toEqual([
      ["traces", "traces"],
      ["metrics", "metrics"],
      ["logs/debug", "logs"],
    ]);
    expect(topo.exporters).toEqual([
      { id: "otlphttp/honeycomb", type: "otlphttp", endpoints: ["https://api.honeycomb.io"], pipelines: ["traces"], signals: ["traces"] },
      { id: "prometheus", type: "prometheus", endpoints: ["0.0.0.0:8889"], pipelines: ["metrics"], signals: ["metrics"] },
      {
        id: "googlecloud",
        type: "googlecloud",
        endpoints: ["googlecloud://projects/p1"],
        pipelines: ["traces", "metrics"],
        signals: ["traces", "metrics"],
      },
      { id: "debug", type: "debug", endpoints: ["console"], pipelines: ["logs/debug"], signals: ["logs"] },
    ]);
  });

  test("reports receiver listen addresses, defaults included, and extension endpoints", () => {
    const topo = collectorTopologyOf(entities);
    expect(topo.components.find((c) => c.id === "otlp")!.endpoints).toEqual(["0.0.0.0:4317", "localhost:4318"]);
    expect(topo.components.find((c) => c.id === "health_check")!.endpoints).toEqual(["0.0.0.0:13133/"]);
  });

  test("reads a parsed YAML file the same as the declaration it came from", () => {
    const parsed = load(collectorYaml(entities)) as CollectorConfig;
    expect(collectorTopology(parsed)).toEqual(collectorTopologyOf(entities));
  });

  test("a component this process has no definition for falls back to its endpoint key", () => {
    const topo = collectorTopology({
      exporters: { "kafka/out": { brokers: ["k:9092"] }, "somevendor": { endpoint: "https://v.example" } },
      service: { pipelines: { traces: { receivers: [], exporters: ["kafka/out", "somevendor"] } } },
    });
    expect(topo.components.map((c) => [c.id, c.type, c.name, c.builtin, c.endpoints])).toEqual([
      ["kafka/out", "kafka", "out", false, []],
      ["somevendor", "somevendor", undefined, false, ["https://v.example"]],
    ]);
  });
});
