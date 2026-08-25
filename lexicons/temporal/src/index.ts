// Plugin
export { temporalPlugin } from "./plugin";

// Deep observation (#1088): the Temporal client reader and the noise rules it
// shares with core's normalization pass.
export {
  observeResourcesDeepTemporal,
  temporalDeepNormalizationHooks,
  TEMPORAL_NAMESPACE_DEFAULTS,
  TEMPORAL_SCHEDULE_DEFAULTS,
  parseDurationSeconds,
  formatDurationSeconds,
  reconcileDuration,
} from "./deep-observe";

// Serializer
export { temporalSerializer } from "./serializer";

// Resources (hand-written)
export {
  TemporalServer,
  TemporalNamespace,
  SearchAttribute,
  TemporalSchedule,
} from "./resources";
export type {
  TemporalServerProps,
  TemporalNamespaceProps,
  SearchAttributeProps,
  TemporalScheduleProps,
} from "./resources";

// Worker profile config shape + activity profiles
export type { TemporalWorkerProfile, TemporalChantConfig, TemporalActivityProfile } from "./config";
export { TEMPORAL_ACTIVITY_PROFILES } from "./config";

// Composites
export { TemporalDevStack } from "./composites/dev-stack";
export type { TemporalDevStackConfig, TemporalDevStackResources } from "./composites/dev-stack";
export { TemporalCloudStack } from "./composites/cloud-stack";
export type { TemporalCloudStackConfig, TemporalCloudStackResources } from "./composites/cloud-stack";
export { WatchOp } from "./composites/watch-op";
export type { WatchOpConfig, WatchOpResources } from "./composites/watch-op";
export { ReconcileOp } from "./composites/reconcile-op";
export type { ReconcileOpConfig, ReconcileOpResources } from "./composites/reconcile-op";
export { WorkflowAuditOp } from "./composites/workflow-audit-op";
export type { WorkflowAuditOpConfig, WorkflowAuditOpResources } from "./composites/workflow-audit-op";
export { PipelineAuditOp } from "./composites/pipeline-audit-op";
export type { PipelineAuditOpConfig, PipelineAuditOpResources } from "./composites/pipeline-audit-op";
export { LexiconUpgradeOp, IN_SCOPE_LEXICONS } from "./composites/lexicon-upgrade-op";
export type { LexiconUpgradeOpConfig, LexiconUpgradeOpResources } from "./composites/lexicon-upgrade-op";
export { ApplyOp } from "./composites/apply-op";
export type { ApplyOpConfig, ApplyOpResources } from "./composites/apply-op";

// Op builders (re-exported from core for single-import convenience)
export {
  Op,
  phase,
  activity,
  gate,
  effect,
  build,
  kubectlApply,
  helmInstall,
  helmInstallPinned,
  waitForStack,
  waitForReady,
  gitlabPipeline,
  lifecycleSnapshot,
  shell,
  ensureSecret,
  teardown,
  envTeardown,
  k3dUp,
  k3dDown,
  flociUp,
  flociDown,
  flociAzUp,
  flociAzDown,
  flociGcpUp,
  flociGcpDown,
  httpCheck,
  azGroupEnsure,
  azGroupDelete,
  azApply,
  azDelete,
  awsApply,
  awsDelete,
  gcpApply,
  gcpDelete,
  policyGate,
} from "@intentius/chant/op";
export type { OpConfig, PhaseDefinition, StepDefinition, ActivityStep, GateStep, EffectStep } from "@intentius/chant/op";
