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
