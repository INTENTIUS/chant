import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { collectorYaml } from "../collector";
import { validateCollectorEntities } from "../validate-config";
import { COLLECTOR_PIN } from "../define";
import { Pipeline } from "../pipeline";
import { DebugExporter } from "./exporters";
import { SumConnector } from "./connectors";
import { OtlpReceiver } from "./receivers";
import { DeltaToCumulativeProcessor, type DeltaToCumulativeProcessorConfig } from "./processors";

function problems(component: Declarable): string[] {
  return validateCollectorEntities([component])
    .filter((i) => i.code === "OTEL107")
    .map((i) => i.message.replace(/^\w+ "[^"]+": /, ""));
}

describe("deltatocumulative processor", () => {
  test("is a built-in pinned to the collector release", () => {
    expect(DeltaToCumulativeProcessor.definition.kind).toBe("processor");
    expect(DeltaToCumulativeProcessor.definition.type).toBe("deltatocumulative");
    expect(DeltaToCumulativeProcessor.definition.builtin).toBe(true);
    expect(DeltaToCumulativeProcessor.definition.pin).toBe(COLLECTOR_PIN);
  });

  test("sits in a metrics pipeline after a delta-emitting connector", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const sum = new SumConnector({ spans: { "tokens": { source_attribute: "gen_ai.usage.input_tokens" } } });
    const d2c = new DeltaToCumulativeProcessor({ max_stale: "10m", max_streams: 1000 });
    const debug = new DebugExporter({});
    const config = load(
      collectorYaml([
        otlp,
        new Pipeline({ signal: "traces", receivers: [otlp], exporters: [sum] }),
        new Pipeline({ signal: "metrics", receivers: [sum], processors: [d2c], exporters: [debug] }),
      ]),
    ) as any;
    expect(config.processors.deltatocumulative).toEqual({ max_stale: "10m", max_streams: 1000 });
    expect(config.service.pipelines.metrics.processors).toEqual(["deltatocumulative"]);
  });

  test.each<[string, DeltaToCumulativeProcessorConfig, string[]]>([
    ["defaults", {}, []],
    ["set", { max_stale: "1h", max_streams: 0 }, []],
    ["zero max_stale", { max_stale: "0s" }, ['max_stale must be a positive duration (got "0s")']],
    ["bare zero max_stale", { max_stale: "0" }, ['max_stale must be a positive duration (got "0")']],
    ["negative max_stale", { max_stale: "-5m" }, ['max_stale must be a positive duration (got "-5m")']],
    ["negative max_streams", { max_streams: -1 }, ["max_streams must be a whole number, 0 or more (got -1)"]],
    ["fractional max_streams", { max_streams: 1.5 }, ["max_streams must be a whole number, 0 or more (got 1.5)"]],
  ])("checks what config.go Validate checks: %s", (_label, config, expected) => {
    expect(problems(new DeltaToCumulativeProcessor(config))).toEqual(expected);
  });
});
