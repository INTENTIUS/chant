// Serializer
export { helmSerializer } from "./serializer";

// Plugin
export { helmPlugin } from "./plugin";

// #1495 piece 4 — the component surface. `helmCapabilityPlugin` exported from
// the package entry is what `loadCapabilityPluginFromLexicon` scans for, the
// same discovery the aws and k8s plugins ride.
export { helmCapabilityPlugin, HELM_VERB_FAMILIES } from "./components/capability-plugin";
export { helmUpgradeCapability, createHelmUpgradeCapability, type HelmUpgradeInput, type HelmUpgradeOutcome } from "./components/helm-upgrade";

// Resources
export { Chart, Values, ValuesOverride, HelmTest, HelmNotes, HelmHook, HelmDependency, HelmMaintainer, HelmCRD } from "./resources";

// HelmRender — render an upstream chart at chant build time
export { HelmRender, getHelmRenderRecords, clearHelmRenderRecords } from "./render";
export type { HelmRenderProps, HelmRenderRecord } from "./render";

// #1237 — render canonicalization + the contentDigest/inputDigest split.
export { canonicalizeRender, helmContentDigest, helmInputDigest, renderStability } from "./render-digest";
export type { HelmInputDigestSource, RenderStabilityGroup, RenderStabilityReport } from "./render-digest";

// #1251/#1252 — build-time coalesced-values probe and its provenance products.
export {
  probeCoalescedValues,
  coalescedValuesDigest,
  computeValueSources,
  findDeadAssignments,
  rootCoalescedValues,
  getValuesProbeRecords,
  recordValuesProbe,
  clearValuesProbeRecords,
} from "./values-probe";
export type {
  ValuesProbeOptions,
  CoalescedValuesProbe,
  CoalescedChartValues,
  DisabledDependency,
  SuppliedValuesLayer,
  ValueOrigin,
  ValuesAttributionInput,
  DeadAssignment,
  HelmValuesProbeRecord,
} from "./values-probe";

// Capability profiles — per-cluster render inputs (#1235, epic #1228)
export {
  helmConfigSchema,
  helmCapabilityProfileSchema,
  resolveCapabilityProfile,
  validateCapabilityProfile,
  KUBE_VERSION_PATTERN,
} from "./config";
export type {
  HelmChantConfig,
  HelmCapabilityProfile,
  HelmCapabilityProfileConfig,
  HelmCapabilityProfileRef,
} from "./config";

// Intrinsics
export {
  HelmTpl,
  HELM_TPL_KEY,
  HELM_IF_KEY,
  HELM_RANGE_KEY,
  HELM_WITH_KEY,
  RuntimeSlot,
  RUNTIME_SLOT_KEY,
  runtimeSlot,
  values,
  Release,
  ChartRef,
  include,
  required,
  helmDefault,
  toYaml,
  quote,
  printf,
  tpl,
  lookup,
  Capabilities,
  Template,
  filesGet,
  filesGlob,
  filesAsConfig,
  filesAsSecrets,
  ElseIf,
  If,
  Range,
  With,
  withOrder,
  argoWave,
} from "./intrinsics";
export type { HelmConditional } from "./intrinsics";

// Helpers
export { generateHelpers } from "./helpers";
export type { HelpersConfig } from "./helpers";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// Composites
export {
  HelmWebApp,
  HelmStatefulService,
  HelmCronJob,
  HelmMicroservice,
  HelmLibrary,
  HelmCRDLifecycle,
  HelmDaemonSet,
  HelmWorker,
  HelmExternalSecret,
  HelmBatchJob,
  HelmMonitoredService,
  HelmSecureIngress,
  HelmNamespaceEnv,
} from "./composites";
export type {
  HelmWebAppProps,
  HelmWebAppResult,
  HelmStatefulServiceProps,
  HelmStatefulServiceResult,
  HelmCronJobProps,
  HelmCronJobResult,
  HelmMicroserviceProps,
  HelmMicroserviceResult,
  HelmLibraryProps,
  HelmLibraryResult,
  HelmCRDLifecycleProps,
  HelmCRDLifecycleResult,
  HelmDaemonSetProps,
  HelmDaemonSetResult,
  HelmWorkerProps,
  HelmWorkerResult,
  HelmExternalSecretProps,
  HelmExternalSecretResult,
  HelmBatchJobProps,
  HelmBatchJobResult,
  HelmMonitoredServiceProps,
  HelmMonitoredServiceResult,
  HelmSecureIngressProps,
  HelmSecureIngressResult,
  HelmNamespaceEnvProps,
  HelmNamespaceEnvResult,
} from "./composites";

// Import pipeline
export { HelmParser } from "./import/parser";
export { HelmGenerator } from "./import/generator";
export { stripTemplateExpressions, classifyExpression } from "./import/template-stripper";
export type { StrippedExpression, StripResult, ExpressionKind } from "./import/template-stripper";

// Pinnability gate (#1234, epic #1228) — what the pinned-render pipeline
// consults before anything is pinned
export { classifyChart } from "./pinnability";
export type {
  PinnabilityVerdict,
  PinnabilityReport,
  ClassifyChartOptions,
  CapabilityRequirement,
  ClosedInput,
  ConditionalHazard,
  RenderEvidence,
} from "./pinnability";

// LSP providers
export { helmCompletions } from "./lsp/completions";
export { helmHover } from "./lsp/hover";

// Docs generation
export { generateDocs } from "./codegen/docs";
