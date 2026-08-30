// Plugin
export { fountainPlugin } from "./plugin";

// Serializer
export { fountainSerializer } from "./serializer";

// Deep observation (#1217) — the reader plus the noise rules it shares with
// core's normalization pass.
export { observeResourcesDeepFountain } from "./deep-observe";
export type { FountainDeepObserveOptions } from "./deep-observe";
export {
  fountainDeepNormalizationHooks,
  FOUNTAIN_SERVER_FIELDS,
  FOUNTAIN_DEFAULTS,
} from "./deep-observe-hooks";

// Generated resources — Environment, Vault, Agent, and property types.
export * from "./generated/index";

// Op activities — the native applier and conversation runner. Also
// resolvable by name via loadActivities(["fountain"]).
export { fountainApply, fountainRun, DEFAULT_FOUNTAIN_BASE_URL } from "./op/activities";
export type { FountainApplyArgs, FountainApplySummary, FountainRunArgs, FountainRunResult } from "./op/activities";

// Composites — secure-by-construction bundles.
export { ConciergeStack } from "./composites/concierge-stack";
export type { ConciergeStackOpts, ConciergeStackResources } from "./composites/concierge-stack";
