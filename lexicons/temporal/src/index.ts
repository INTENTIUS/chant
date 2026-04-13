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
  stateSnapshot,
  shell,
  teardown,
} from "@intentius/chant/op";
export type { OpConfig, PhaseDefinition, StepDefinition, ActivityStep, GateStep } from "@intentius/chant/op";
