/**
 * `GenAiPipeline`: the composite declares exactly the config
 * `genAiPipeline()` returns, with each entity under a member name.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { GenAiPipeline } from "./index";
import { genAiPipeline, type GenAiPipelineOptions } from "../genai";
import { PrometheusExporter } from "../components/exporters";
import { TailSamplingProcessor } from "../components/sampling";
import { collectorYaml } from "../collector";

const yamlOf = (entities: Declarable[]) => collectorYaml(entities);

describe("GenAiPipeline", () => {
  const sampling = [new TailSamplingProcessor({ decision_wait: "10s", policies: [{ name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } }] })];
  const cases: Array<[string, GenAiPipelineOptions]> = [
    ["the defaults", {}],
    ["client metrics derived to a prometheus exporter", { clientMetrics: "derive", metricExporters: [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })] }],
    ["sampling, no logs, no health check", { sampling, logs: false, healthCheck: false }],
  ];

  test.each(cases)("%s: the same config as genAiPipeline()", (_label, options) => {
    const composite = GenAiPipeline(options);
    expect(yamlOf(Object.values(composite.members) as Declarable[])).toBe(yamlOf(genAiPipeline(options)));
    expect(Object.values(composite.members)).toHaveLength(genAiPipeline(options).length);
  });

  test("the members are named after their parts, and the parts that are off are absent", () => {
    expect(Object.keys(GenAiPipeline({}).members)).toEqual(["otlp", "traces", "genAiTraces", "genAiMetrics", "logs", "health"]);
    expect(Object.keys(GenAiPipeline({ clientMetrics: "passthrough" }).members)).toContain("sdkMetrics");
    expect(Object.keys(GenAiPipeline({ sampling, logs: false, healthCheck: false }).members)).toEqual([
      "otlp",
      "traces",
      "sampled",
      "genAiTraces",
      "genAiMetrics",
    ]);
  });

  test("genAiPipeline() still returns its entities in the order it always has: receiver, pipelines, extension", () => {
    const ids = genAiPipeline().map((e) => (e as { pipelineId?: string; componentId?: string }).pipelineId ?? (e as { componentId?: string }).componentId);
    expect(ids).toEqual(["otlp", "traces", "traces/genai", "metrics/genai", "logs", "health_check"]);
  });

  test("the pipeline ids are the preset's", () => {
    const g = GenAiPipeline({ sampling });
    expect(g.traces.pipelineId).toBe("traces");
    expect(g.sampled?.pipelineId).toBe("traces/sampled");
    expect(g.genAiTraces.pipelineId).toBe("traces/genai");
    expect(g.genAiMetrics.pipelineId).toBe("metrics/genai");
  });
});
