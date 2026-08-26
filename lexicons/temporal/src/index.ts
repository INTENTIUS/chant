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
export { ConvergeOp } from "./composites/converge-op";
export type { ConvergeOpConfig, ConvergeOpResources, ConvergeDial } from "./composites/converge-op";

// Op builders (re-exported from core for single-import convenience)
//
// chant #1288 Stage 2: kubectlApply, helmInstall, helmInstallPinned,
// waitForReady, ensureSecret, gitlabPipeline, and the cloud appliers
// (k3d/k3s/floci*/az*/aws*/gcp*) are owned by other lexicons — typing them
// here would make this package depend on k8s/helm/gitlab/aws/azure/gcp/k3d/
// k3s at runtime, undoing the product-agnostic split #809 did (see
// `lexicons/k8s/src/op/builders.ts`'s module doc). They stay sourced from
// core, unchanged, exactly as before; an author who wants the typed surface
// for one of these imports it from the owning lexicon instead (e.g.
// `kubectlApply` from `@intentius/chant-lexicon-k8s`).
//
// build, shell, waitForStack, lifecycleSnapshot, teardown, envTeardown,
// httpCheck, and policyGate ARE this lexicon's own activities, so they come
// from `./op/builders` (fully typed, deriving from each activity's own
// `*Args` interface) instead — same names, same import path, no call-site
// change required. See `builders-exports.test.ts` in core for the guard that
// keeps this split intentional rather than drifting.
export {
  Op,
  phase,
  activity,
  gate,
  effect,
  kubectlApply,
  helmInstall,
  helmInstallPinned,
  waitForReady,
  gitlabPipeline,
  ensureSecret,
  k3dUp,
  k3dDown,
  k3sInstall,
  k3sUninstall,
  flociUp,
  flociDown,
  flociAzUp,
  flociAzDown,
  flociGcpUp,
  flociGcpDown,
  azGroupEnsure,
  azGroupDelete,
  azApply,
  azDelete,
  awsApply,
  awsDelete,
  gcpApply,
  gcpDelete,
  stepOutput,
} from "@intentius/chant/op";
export type {
  OpConfig, PhaseDefinition, StepDefinition, ActivityStep, GateStep, EffectStep,
  StepOutputRef, NamedActivityStep, WithStepRefs,
} from "@intentius/chant/op";
export { build, shell, waitForStack, lifecycleSnapshot, teardown, envTeardown, httpCheck, policyGate } from "./op/builders";
