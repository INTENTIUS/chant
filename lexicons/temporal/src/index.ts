// Plugin
export { temporalPlugin } from "./plugin";

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
export { ApplyOp } from "./composites/apply-op";
export type { ApplyOpConfig, ApplyOpResources } from "./composites/apply-op";

// Op builders (re-exported from core for single-import convenience)
export {
  Op,
  phase,
  activity,
  gate,
  build,
  kubectlApply,
  helmInstall,
  waitForStack,
  gitlabPipeline,
  lifecycleSnapshot,
  shell,
  teardown,
  policyGate,
} from "@intentius/chant/op";
export type { OpConfig, PhaseDefinition, StepDefinition, ActivityStep, GateStep } from "@intentius/chant/op";
