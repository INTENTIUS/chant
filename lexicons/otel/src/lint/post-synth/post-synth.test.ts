import { describe, expect, test } from "vitest";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import { otel101 } from "./otel101";
import { otel102 } from "./otel102";
import { otel103 } from "./otel103";
import { otel104 } from "./otel104";
import { otel105 } from "./otel105";
import { otel106 } from "./otel106";
import { otel107 } from "./otel107";
import { otel108 } from "./otel108";
import { otel109 } from "./otel109";
import { BatchProcessor, DebugExporter, FileLogReceiver, MemoryLimiterProcessor, OtlpReceiver } from "../../components";
import { defineComponent } from "../../define";
import { Pipeline } from "../../pipeline";

const GOOD = `receivers:
  otlp:
    protocols:
      grpc: {}

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400
  batch: {}

exporters:
  debug: {}

extensions:
  health_check: {}

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
`;

const configChecks = [otel101, otel102, otel103, otel104, otel105, otel106];

function entities(list: unknown[]): Map<string, Declarable> {
  return new Map(list.map((e, i) => [`e${i}`, e as Declarable]));
}

describe("config-level checks on a clean config", () => {
  test.each(configChecks.map((c) => [c.id, c] as const))("%s finds nothing", (_id, check) => {
    expect(check.check(makePostSynthCtx("otel", GOOD))).toEqual([]);
  });
});

describe("OTEL101 undeclared component", () => {
  test("flags an exporter and a processor nobody declares", () => {
    const yaml = GOOD.replace("exporters: [debug]", "exporters: [debug, otlp/backend]").replace(
      "processors: [memory_limiter, batch]",
      "processors: [memory_limiter, batch, attributes/redact]",
    );
    const diags = otel101.check(makePostSynthCtx("otel", yaml));
    expect(diags.map((d) => d.entity)).toEqual(["attributes/redact", "otlp/backend"]);
    expect(diags[0].severity).toBe("error");
  });

  test("accepts a connector id as a receiver or exporter", () => {
    const yaml = `connectors:
  forward: {}
receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [forward]
    traces/2:
      receivers: [forward]
      exporters: [debug]
`;
    expect(otel101.check(makePostSynthCtx("otel", yaml))).toEqual([]);
  });

  test("finds a collector config in another lexicon's output by its shape", () => {
    const yaml = GOOD.replace("exporters: [debug]", "exporters: [nope]");
    expect(otel101.check(makePostSynthCtx("docker", yaml))).toHaveLength(1);
  });
});

describe("OTEL102 empty ends", () => {
  test("flags a pipeline with no receivers and one with no exporters", () => {
    const yaml = `receivers:
  otlp: {protocols: {grpc: {}}}
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: []
      exporters: [debug]
    logs:
      receivers: [otlp]
`;
    const diags = otel102.check(makePostSynthCtx("otel", yaml));
    expect(diags.map((d) => d.message)).toEqual([
      'pipeline "traces" has no receivers, so nothing enters it',
      'pipeline "logs" has no exporters, so what enters it goes nowhere',
    ]);
  });
});

describe("OTEL103 unused", () => {
  test("warns about an unused exporter and an extension never enabled", () => {
    const yaml = GOOD.replace("  debug: {}\n", "  debug: {}\n  otlp/spare:\n    endpoint: x:4317\n").replace(
      "  health_check: {}\n",
      "  health_check: {}\n  zpages: {}\n",
    );
    const diags = otel103.check(makePostSynthCtx("otel", yaml));
    expect(diags.map((d) => [d.entity, d.severity])).toEqual([
      ["otlp/spare", "warning"],
      ["zpages", "warning"],
    ]);
  });
});

describe("OTEL104 undeclared extension", () => {
  test("flags service.extensions naming an extension nobody declares", () => {
    const yaml = GOOD.replace("extensions: [health_check]", "extensions: [health_check, pprof]");
    expect(otel104.check(makePostSynthCtx("otel", yaml)).map((d) => d.entity)).toEqual(["pprof"]);
  });
});

describe("OTEL105 memory_limiter position", () => {
  test("warns when memory_limiter is not first", () => {
    const yaml = GOOD.replace("processors: [memory_limiter, batch]", "processors: [batch, memory_limiter]");
    const diags = otel105.check(makePostSynthCtx("otel", yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });
});

describe("OTEL106 syntax", () => {
  test("flags a pipeline id that names no signal", () => {
    const yaml = GOOD.replace("    traces:\n", "    trace:\n");
    expect(otel106.check(makePostSynthCtx("otel", yaml)).map((d) => d.entity)).toEqual(["trace"]);
  });
});

describe("entity-level checks", () => {
  test("OTEL107 reports a built-in's own config rules", () => {
    const limiter = new MemoryLimiterProcessor({ check_interval: "1s" });
    const logs = new FileLogReceiver({ include: [] });
    const diags = otel107.check(makePostSynthCtx("otel", "", entities([limiter, logs])));
    expect(diags.map((d) => d.entity)).toEqual(["memory_limiter", "filelog"]);
    expect(diags[0].message).toContain("limit_mib or limit_percentage");
  });

  test("OTEL107 is quiet for valid config", () => {
    const limiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80 });
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    expect(otel107.check(makePostSynthCtx("otel", "", entities([limiter, otlp, new BatchProcessor({})])))).toEqual([]);
  });

  test("OTEL108 flags duplicate component and pipeline ids", () => {
    const a = new DebugExporter({});
    const b = new DebugExporter({ verbosity: "detailed" });
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const p1 = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [a] });
    const p2 = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [b] });
    const diags = otel108.check(makePostSynthCtx("otel", "", entities([a, b, otlp, p1, p2])));
    expect(diags.map((d) => d.entity)).toEqual(["debug", "traces"]);
  });

  test("OTEL109 flags a custom component whose pin is unusable", () => {
    const Loose = defineComponent<{ endpoint?: string }>()({
      kind: "exporter",
      type: "loosepin2559",
      pin: { source: "", version: "" },
    });
    const diags = otel109.check(makePostSynthCtx("otel", "", entities([new Loose({})])));
    expect(diags.map((d) => d.checkId)).toEqual(["OTEL109"]);
  });
});
