import { describe, expect, test } from "vitest";
import { collectorConfig, describeOperatorCollectorConfig, operatorCollectorConfig } from "./index";
import { OtlpReceiver, DebugExporter, Pipeline } from "./index";

const config = {
  receivers: { otlp: { protocols: { grpc: {} } } },
  exporters: { debug: {} },
  service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] } } },
};

const cr = (spec: unknown, apiVersion = "opentelemetry.io/v1beta1") => ({
  apiVersion,
  kind: "OpenTelemetryCollector",
  metadata: { name: "gw", namespace: "obs" },
  spec,
});

describe("operatorCollectorConfig (#3367)", () => {
  test("reads spec.config as an object (v1beta1) or as YAML text (v1alpha1)", () => {
    expect(operatorCollectorConfig(cr({ config }))).toEqual({ namespace: "obs", name: "gw", config });
    const text = "receivers: { otlp: {} }\nexporters: { debug: {} }\nservice:\n  pipelines:\n    traces: { receivers: [otlp], exporters: [debug] }\n";
    const old = operatorCollectorConfig(cr({ config: text }, "opentelemetry.io/v1alpha1"));
    expect(old?.config.service?.pipelines?.traces).toEqual({ receivers: ["otlp"], exporters: ["debug"] });
  });

  test("defaults the namespace and skips other kinds, other groups and configs without pipelines", () => {
    expect(operatorCollectorConfig({ ...cr({ config }), metadata: { name: "x" } })?.namespace).toBe("default");
    expect(operatorCollectorConfig({ ...cr({ config }), kind: "Deployment" })).toBeUndefined();
    expect(operatorCollectorConfig(cr({ config }, "example.com/v1"))).toBeUndefined();
    expect(operatorCollectorConfig(cr({ config: { receivers: {} } }))).toBeUndefined();
    expect(operatorCollectorConfig(cr({}))).toBeUndefined();
  });

  test("describes the CR in a message", () => {
    expect(describeOperatorCollectorConfig({ namespace: "obs", name: "gw" })).toBe("OpenTelemetryCollector obs/gw, spec.config");
  });
});

describe("collectorConfig", () => {
  test("is the config object collectorYaml prints", () => {
    const entities = [new Pipeline({ signal: "traces", receivers: [new OtlpReceiver({ protocols: { grpc: {} } })], exporters: [new DebugExporter({})] })];
    expect(collectorConfig(entities).service?.pipelines?.traces).toEqual({ receivers: ["otlp"], exporters: ["debug"] });
  });
});
