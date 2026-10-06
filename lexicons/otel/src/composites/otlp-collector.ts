/**
 * `OtlpCollector`: `otlpCollector()` as a composite.
 *
 * The small OTLP collector the docker, k8s and fly platform composites start
 * from: an `otlp` receiver on 4317 (gRPC) and 4318 (HTTP), `memory_limiter`
 * then `batch`, the given exporters (default: one `debug` exporter), one
 * pipeline per signal, and a `health_check` extension on 0.0.0.0:13133.
 * Each part is a member, so a project exports one declaration and hands
 * the parts on by name.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import type { OTelComponent } from "../define";
import type { PipelineEntity } from "../pipeline";
import { otlpCollectorParts, type OtlpCollectorOptions } from "../platform";

export type OtlpCollectorProps = OtlpCollectorOptions;

// A type alias, not an interface: a composite's members type needs the implicit index signature.
export type OtlpCollectorMembers = {
  otlp: OTelComponent<"receiver", "otlp", object>;
  memoryLimiter: OTelComponent<"processor", "memory_limiter", object>;
  batch: OTelComponent<"processor", "batch", object>;
  /** The default `debug` exporter, when no `exporters` are given. */
  debug?: OTelComponent<"exporter", string, object>;
  health?: OTelComponent<"extension", "health_check", object>;
  traces?: PipelineEntity;
  metrics?: PipelineEntity;
  logs?: PipelineEntity;
};

export type OtlpCollectorInstance = CompositeInstance<OtlpCollectorMembers> & OtlpCollectorMembers;

/** Why a set of `OtlpCollector` props can't build, or undefined when they can. */
export function otlpCollectorPropsProblem(props: OtlpCollectorProps = {}): string | undefined {
  if (props.exporters !== undefined && props.exporters.length === 0) return "exporters must name at least one exporter when set";
  if (props.signals !== undefined) {
    if (props.signals.length === 0) return "signals must name at least one signal when set";
    const bad = props.signals.find((s) => s !== "traces" && s !== "metrics" && s !== "logs");
    if (bad !== undefined) return `signals: "${String(bad)}" is not traces, metrics or logs`;
  }
  return undefined;
}

/**
 * A small OTLP collector config: OTLP in, `memory_limiter` and `batch`, the
 * given exporters out, for each signal.
 *
 * @example
 * ```ts
 * import { OtlpCollector, OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * const backend = new OtlpExporter({ name: "backend", endpoint: "collector.example.com:4317" });
 * export const collector = OtlpCollector({ exporters: [backend], signals: ["traces", "logs"] });
 * ```
 */
export const OtlpCollector = Composite<OtlpCollectorProps, OtlpCollectorMembers>((input) => {
  const props = input ?? {};
  const problem = otlpCollectorPropsProblem(props);
  if (problem) throw new Error(`OtlpCollector: ${problem}`);
  const p = otlpCollectorParts(props);
  // A composite member must be a declarable, so the parts that are off are left out rather than undefined.
  const members: OtlpCollectorMembers = { otlp: p.otlp, memoryLimiter: p.memoryLimiter, batch: p.batch };
  if (props.exporters === undefined) members.debug = p.exporters[0];
  if (p.health) members.health = p.health;
  if (p.pipelines.traces) members.traces = p.pipelines.traces;
  if (p.pipelines.metrics) members.metrics = p.pipelines.metrics;
  if (p.pipelines.logs) members.logs = p.pipelines.logs;
  return members;
}, "OtlpCollector");
