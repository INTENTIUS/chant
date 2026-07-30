// Plugin
export { fountainPlugin } from "./plugin";

// Serializer
export { fountainSerializer } from "./serializer";

// Generated resources — Environment, Vault, Agent, and property types.
export * from "./generated/index";

// Op activities — the native applier and conversation runner. Also
// resolvable by name via loadActivities(["fountain"]).
export { fountainApply, fountainRun, DEFAULT_FOUNTAIN_BASE_URL } from "./op/activities";
export type { FountainApplyArgs, FountainApplySummary, FountainRunArgs, FountainRunResult } from "./op/activities";
