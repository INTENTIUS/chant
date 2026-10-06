/**
 * `OtlpCollector`: the composite declares the config `otlpCollector()`
 * returns, with each part under a member name.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { OtlpCollector, otlpCollectorPropsProblem, type OtlpCollectorProps } from "./index";
import { otlpCollector } from "../platform";
import { OtlpExporter } from "../components/exporters";
import { collectorYaml } from "../collector";
import { validateCollectorConfig } from "../validate-config";
import type { CollectorConfig, Signal } from "../model";

const backend = new OtlpExporter({ name: "backend", endpoint: "collector.example.com:4317" });

describe("OtlpCollector", () => {
  const cases: Array<[string, OtlpCollectorProps]> = [
    ["the defaults", {}],
    ["an exporter and two signals", { exporters: [backend], signals: ["traces", "logs"] }],
    ["no health check", { healthCheck: false }],
  ];

  test.each(cases)("%s: the same config as otlpCollector(), and it passes the config checks", (_label, props) => {
    const yaml = collectorYaml(Object.values(OtlpCollector(props).members) as Declarable[]);
    expect(yaml).toBe(collectorYaml(otlpCollector(props)));
    expect(validateCollectorConfig(load(yaml) as CollectorConfig)).toEqual([]);
  });

  test("members: the default debug exporter only when no exporters are given, a pipeline per signal", () => {
    expect(Object.keys(OtlpCollector({}).members).sort()).toEqual(["batch", "debug", "health", "logs", "memoryLimiter", "metrics", "otlp", "traces"]);
    const c = OtlpCollector({ exporters: [backend], signals: ["traces"], healthCheck: false });
    expect(Object.keys(c.members).sort()).toEqual(["batch", "memoryLimiter", "otlp", "traces"]);
    expect(c.traces?.props.exporters).toEqual([backend]);
  });

  test("bad props are refused", () => {
    expect(otlpCollectorPropsProblem({})).toBeUndefined();
    expect(() => OtlpCollector({ exporters: [] })).toThrow(/OtlpCollector: exporters must name at least one exporter/);
    expect(() => OtlpCollector({ signals: [] })).toThrow(/signals must name at least one signal/);
    expect(() => OtlpCollector({ signals: ["profiles" as Signal] })).toThrow(/"profiles" is not traces, metrics or logs/);
  });
});
