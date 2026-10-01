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
export { buildCollectorConfig, collectorYaml, componentConfig, type BuiltCollector } from "./collector";
export { emitCollectorYaml, type EmitOptions } from "./yaml";
export { configMapCollectorConfigs, describeConfigMapConfig, parseCollectorConfig, type ConfigMapCollectorConfig } from "./configmap";
export {
  validateCollectorConfig,
  validateCollectorEntities,
  type CollectorIssue,
  type CollectorIssueCode,
} from "./validate-config";
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

// What the platform collector composites (docker, k8s, fly) share
export {
  otlpCollector,
  collectorEndpoints,
  COLLECTOR_IMAGE,
  COLLECTOR_CONFIG_PATH,
  type OtlpCollectorOptions,
  type CollectorPort,
  type CollectorEndpoints,
} from "./platform";

// The GenAI preset: content removal and agent RED and token metrics
export {
  genAiPipeline,
  genAiComponents,
  genAiMetrics,
  GENAI_ATTRIBUTES,
  GENAI_CONTENT_ATTRIBUTES,
  GENAI_CONTENT_EVENTS,
  GENAI_INDEXED_CONTENT_PATTERN,
  GENAI_SPAN_METRIC_DIMENSIONS,
  GENAI_TOKEN_DIMENSIONS,
  GENAI_DURATION_BUCKETS,
  GENAI_UNKNOWN_MODEL,
  type GenAiPipelineOptions,
  type GenAiComponentsOptions,
  type GenAiComponents,
  type GenAiMetricsOptions,
  type GenAiMetrics,
  type GenAiMetric,
} from "./genai";

// Metric names as Prometheus serves them, for dashboards and SLOs built from a declaration
export {
  spanMetricsNames,
  prometheusMetricName,
  prometheusLabel,
  SPANMETRICS_DEFAULT_DIMENSIONS,
  SPANMETRICS_DEFAULT_NAMESPACE,
  SPAN_STATUS_ERROR,
  type CollectorMetric,
  type SpanMetricsNames,
  type SpanMetricsNamingConfig,
  type PrometheusNaming,
} from "./metric-names";
