// Serializer
export { k8sSerializer } from "./serializer";

// Plugin
export { k8sPlugin } from "./plugin";

// Default labels & annotations
export { defaultLabels, defaultAnnotations, isDefaultLabels, isDefaultAnnotations } from "./default-labels";
export { DEFAULT_LABELS_MARKER, DEFAULT_ANNOTATIONS_MARKER } from "./default-labels";

// Variables / label constants
export { K8sLabels, K8sAnnotations } from "./variables";

// Generated entities — export everything from generated index
// After running `chant generate`, this re-exports all K8s resource classes
export * from "./generated/index";

// Composites
export {
  WebApp, StatefulApp, CronWorkload, AutoscaledService, WorkerPool, NamespaceEnv, NodeAgent,
  BatchJob, SecureIngress, ConfiguredApp, SidecarApp, MonitoredService, NetworkIsolatedApp,
  IrsaServiceAccount, AlbIngress, EbsStorageClass, EfsStorageClass, FluentBitAgent, ExternalDnsAgent, AdotCollector,
  MetricsServer,
} from "./composites/index";
export type {
  WebAppProps, WebAppResult, StatefulAppProps, StatefulAppResult, CronWorkloadProps, CronWorkloadResult,
  AutoscaledServiceProps, AutoscaledServiceResult, WorkerPoolProps, WorkerPoolResult,
  NamespaceEnvProps, NamespaceEnvResult, NodeAgentProps, NodeAgentResult,
  BatchJobProps, BatchJobResult, SecureIngressProps, SecureIngressResult,
  ConfiguredAppProps, ConfiguredAppResult, SidecarAppProps, SidecarAppResult,
  MonitoredServiceProps, MonitoredServiceResult, NetworkIsolatedAppProps, NetworkIsolatedAppResult,
  IrsaServiceAccountProps, IrsaServiceAccountResult, AlbIngressProps, AlbIngressResult,
  EbsStorageClassProps, EbsStorageClassResult, EfsStorageClassProps, EfsStorageClassResult,
  FluentBitAgentProps, FluentBitAgentResult, ExternalDnsAgentProps, ExternalDnsAgentResult,
  AdotCollectorProps, AdotCollectorResult,
  MetricsServerProps, MetricsServerResult,
} from "./composites/index";

// RBAC verb constants
export * from "./actions/index";

// Spec utilities (for tooling)
export { fetchK8sSchema, fetchSchemas, K8S_SCHEMA_VERSION } from "./spec/fetch";
export { parseK8sSwagger, k8sShortName, k8sServiceName, gvkToTypeName, gvkToApiVersion } from "./spec/parse";
export type { K8sParseResult, ParsedResource, ParsedProperty, ParsedPropertyType, ParsedEnum, GroupVersionKind } from "./spec/parse";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// CRD framework
export type { CRDSource, CRDSpec } from "./crd/types";
export { parseCRD, parseCRDSpec } from "./crd/parser";
export { loadCRDs, loadMultipleCRDs } from "./crd/loader";
