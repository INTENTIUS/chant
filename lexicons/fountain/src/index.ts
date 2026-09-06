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

// Config namespace (#2124) — `fountain.profiles` in chant.config.ts, and the
// resolver both activities and the opRuntime provider (#2126) call.
export { fountainConfigSchema, resolveProfile } from "./config";
export type { FountainConfig, FountainProfile } from "./config";

// The op runtime (#2126) — `chant run <op> --on fountain`, a client over
// fountain's REST and SSE with no state of its own.
export {
  createFountainOpRuntime,
  defaultFountainSse,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from "./op/runtime";
export type { FountainOpRuntimeOptions, FountainSse, FountainSseEvent } from "./op/runtime";

// Composites — secure-by-construction bundles.
export { ConciergeStack } from "./composites/concierge-stack";
export type { ConciergeStackOpts, ConciergeStackResources } from "./composites/concierge-stack";
export { Steward, stewardForOp, STEWARD_RUNTIME_COMMAND } from "./composites/steward";
export type { StewardOpts, StewardResources, StewardWebhookOpts } from "./composites/steward";

// `chant acp` (#2125) — the ACP server, mounted through the plugin's command
// group. Exported so an embedder can serve it over its own transport.
export { acpCommandGroup } from "./acp";
export { AcpServer } from "./acp/server";
export type { AcpServerOptions } from "./acp/server";
export { createChantHost } from "./acp/host";
export type { ChantHost } from "./acp/host";
