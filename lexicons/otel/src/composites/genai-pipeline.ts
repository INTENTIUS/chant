/**
 * `GenAiPipeline`: `genAiPipeline()` as a composite.
 *
 * The same collector config `genAiPipeline(options)` returns as a list (an
 * `otlp` receiver, content removal on traces and logs, a `traces/genai`
 * branch that turns GenAI spans into metrics before any sampling, and a
 * `metrics/genai` pipeline that exports them), with each entity under a
 * member name, so a project exports one declaration and reads the parts by
 * name. The options are `genAiPipeline()`'s; every one has its default.
 *
 * The prometheus lexicon's `GenAiRules` reads the metric names from
 * `genAiMetrics(options)` with the same options.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { genAiPipelineParts, type GenAiPipelineOptions, type GenAiPipelineParts } from "../genai";

export type GenAiPipelineProps = GenAiPipelineOptions;

/** The members: `otlp`, `traces`, `sampled` (with `sampling`), `genAiTraces`, `genAiMetrics`, `sdkMetrics` (with `clientMetrics`), `logs` and `health` (unless off). */
export type GenAiPipelineMembers = GenAiPipelineParts;

export type GenAiPipelineInstance = CompositeInstance<GenAiPipelineMembers> & GenAiPipelineMembers;

/**
 * The collector config of an OTLP collector for GenAI workloads, from the
 * GenAI preset.
 *
 * @example
 * ```ts
 * import { GenAiPipeline, PrometheusExporter } from "@intentius/chant-lexicon-otel";
 *
 * const scrape = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });
 * export const genai = GenAiPipeline({ metricExporters: [scrape], clientMetrics: "derive" });
 * ```
 */
export const GenAiPipeline = Composite<GenAiPipelineProps, GenAiPipelineMembers>(
  (props) => genAiPipelineParts(props ?? {}),
  "GenAiPipeline",
);
