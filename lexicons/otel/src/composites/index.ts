/**
 * otel lexicon composites: declarations that expand to a collector config's components and pipelines.
 */

export { NodeAgent, nodeAgentPropsProblem } from "./node-agent";
export type { NodeAgentProps, NodeAgentMembers, NodeAgentInstance } from "./node-agent";
export { RedMetrics, redMetricsNames, redMetricsPropsProblem } from "./red-metrics";
export type { RedMetricsProps, RedMetricsMembers, RedMetricsInstance, RedMetricsNames } from "./red-metrics";
export { GenAiPipeline } from "./genai-pipeline";
export type { GenAiPipelineProps, GenAiPipelineMembers, GenAiPipelineInstance } from "./genai-pipeline";
export { OtlpCollector, otlpCollectorPropsProblem } from "./otlp-collector";
export type { OtlpCollectorProps, OtlpCollectorMembers, OtlpCollectorInstance } from "./otlp-collector";
export { TailSamplingTier, tailSamplingTierPropsProblem, tailSamplingLoadBalancer } from "./tail-sampling-tier";
export type { TailSamplingTierProps, TailSamplingTierMembers, TailSamplingTierInstance } from "./tail-sampling-tier";
