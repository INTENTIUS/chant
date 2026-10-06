// OpenTelemetry Collector lexicon.

// Plugin and serializer
export { otelPlugin } from "./plugin";
export { otelSerializer } from "./serializer";

// Built-in components and their config types
export * from "./components";

// Pipelines and the service block
export {
  Pipeline,
  Service,
  PIPELINE_TYPE,
  SERVICE_TYPE,
  isPipelineEntity,
  isServiceEntity,
  type ComponentRef,
  type PipelineProps,
  type PipelineEntity,
  type ServiceProps,
  type ServiceEntity,
  type ServiceTelemetry,
} from "./pipeline";

// The extension point: components chant doesn't ship
export {
  defineComponent,
  definitionFor,
  definitionOf,
  registeredDefinitions,
  componentEntityType,
  isOTelComponent,
  COLLECTOR_PIN,
  SEMCONV_PIN,
  GENAI_SEMCONV_PIN,
  type SchemaPin,
  type SafeParseSchema,
  type ConfigValidator,
  type ComponentDefinition,
  type CustomComponentOptions,
  type ComponentProps,
  type ComponentClass,
  type OTelComponent,
} from "./define";

// The plain-data model, YAML, checks and topology
export * from "./model";
export { buildCollectorConfig, collectorConfig, collectorYaml, componentConfig, type BuiltCollector } from "./collector";
export { emitCollectorYaml, type EmitOptions } from "./yaml";
export {
  configMapCollectorConfigs,
  describeConfigMapConfig,
  describeOperatorCollectorConfig,
  operatorCollectorConfig,
  parseCollectorConfig,
  type ConfigMapCollectorConfig,
  type OperatorCollectorConfig,
} from "./configmap";
export {
  validateCollectorConfig,
  validateCollectorEntities,
  type CollectorIssue,
  type CollectorIssueCode,
} from "./validate-config";
export { K8S_ATTRIBUTES_METADATA, RESOURCE_DETECTORS } from "./config-hygiene";
export {
  collectorTopology,
  collectorTopologyOf,
  type CollectorTopology,
  type TopologyPipeline,
  type TopologyComponent,
  type TopologyExporter,
  type TopologyEdge,
  type SemconvUsage,
} from "./topology";
export { semconvUsage, SEMCONV_VOCABULARIES, type SemconvVocabulary } from "./semconv";
export { attributionIssues, isProtectedResourceAttribute, PROTECTED_RESOURCE_ATTRIBUTES } from "./attribution";

// Composites
export { NodeAgent, nodeAgentPropsProblem, type NodeAgentProps, type NodeAgentMembers, type NodeAgentInstance } from "./composites";
export {
  RedMetrics,
  redMetricsNames,
  redMetricsPropsProblem,
  GenAiPipeline,
  OtlpCollector,
  otlpCollectorPropsProblem,
  TailSamplingTier,
  tailSamplingTierPropsProblem,
  tailSamplingLoadBalancer,
  type RedMetricsProps,
  type RedMetricsMembers,
  type RedMetricsInstance,
  type RedMetricsNames,
  type GenAiPipelineProps,
  type GenAiPipelineMembers,
  type GenAiPipelineInstance,
  type OtlpCollectorProps,
  type OtlpCollectorMembers,
  type OtlpCollectorInstance,
  type TailSamplingTierProps,
  type TailSamplingTierMembers,
  type TailSamplingTierInstance,
} from "./composites";

// What the platform collector composites (docker, k8s, fly) share
export {
  otlpCollector,
  otlpCollectorParts,
  collectorEndpoints,
  COLLECTOR_IMAGE,
  COLLECTOR_CONFIG_PATH,
  type OtlpCollectorOptions,
  type OtlpCollectorParts,
  type CollectorPort,
  type CollectorEndpoints,
} from "./platform";

// The GenAI preset: content removal and agent RED and token metrics
export {
  genAiPipeline,
  genAiPipelineParts,
  genAiComponents,
  genAiMetrics,
  GENAI_ATTRIBUTES,
  GENAI_CONTENT_ATTRIBUTES,
  GENAI_CONTENT_EVENTS,
  GENAI_INDEXED_CONTENT_PATTERN,
  GENAI_HIGH_CARDINALITY_ATTRIBUTES,
  genAiCardinalityRisk,
  GENAI_SPAN_METRIC_DIMENSIONS,
  GENAI_TOKEN_DIMENSIONS,
  GENAI_DURATION_BUCKETS,
  GENAI_UNKNOWN_MODEL,
  GENAI_PROVIDER_DIMENSIONS,
  GENAI_CLIENT_METRIC_NAMES,
  GENAI_CLIENT_METRIC_ATTRIBUTES,
  GENAI_CLIENT_DURATION_BUCKETS,
  GENAI_CLIENT_TOKEN_BUCKETS,
  GENAI_TOKEN_TYPES,
  DELTA_READY_EXPORTERS,
  genAiNeedsDeltaToCumulative,
  type GenAiPipelineOptions,
  type GenAiPipelineParts,
  type GenAiComponentsOptions,
  type GenAiComponents,
  type GenAiMetricsOptions,
  type GenAiMetrics,
  type GenAiMetric,
  type GenAiClientMetrics,
  type GenAiClientMetricsSource,
} from "./genai";

// Metric names as Prometheus serves them, for dashboards and SLOs built from a declaration
export {
  spanMetricsNames,
  prometheusMetricName,
  prometheusLabel,
  SPANMETRICS_DEFAULT_DIMENSIONS,
  SPANMETRICS_DEFAULT_NAMESPACE,
  SPAN_STATUS_ERROR,
  SERVICEGRAPH_NAMESPACE,
  serviceGraphNames,
  type ServiceGraphNames,
  type ServiceGraphNamingConfig,
  type CollectorMetric,
  type SpanMetricsNames,
  type SpanMetricsNamingConfig,
  type PrometheusNaming,
  promSelector,
  promSumRate,
  promErrorRatio,
  promQuantile,
  promNumber,
  spanKindMatchers,
  spanMetricsRedQueries,
  SPAN_METRICS_KINDS,
  RED_DEFAULT_SPAN_KINDS,
  type PromMatcher,
  type SpanMetricsKind,
  type RedQueryOptions,
  type RedQueries,
} from "./metric-names";

// Op steps (#3369): the collector binary's checks, collectors as resources a
// ConvergeOp observes, and the pin audit. The activities resolve from
// `@intentius/chant-lexicon-otel/op/activities`.
export { otelcolValidate, otelcolComponents, collectorHealthObserve, collectorAudit } from "./op/builders";
export { CollectorAuditOp, type CollectorAuditOpConfig, type CollectorAuditOpResources } from "./op/audit-op";
