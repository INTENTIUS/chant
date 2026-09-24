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
} from "./topology";
