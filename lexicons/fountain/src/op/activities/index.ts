/**
 * fountain Op activities — resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `fountain` lexicon. Contributes
 * the native applier (`fountainApply` — direct REST against fountain's
 * API, no CLI, no state file) and the conversation runner (`fountainRun`).
 */
export {
  fountainApply,
  resolveEndpoint,
  resolveToken,
  resolveConnection,
  parseManifest,
  toApplyPayload,
  isChantOwned,
  defaultFountainHttp,
  DEFAULT_FOUNTAIN_BASE_URL,
  OWNERSHIP_KEY,
  OWNERSHIP_VALUE,
} from "./fountain-apply";
export type {
  FountainApplyArgs,
  FountainApplySummary,
  ManifestResource,
  FountainHttp,
  FountainConnectionDeps,
} from "./fountain-apply";

export {
  fountainRun,
  resolveAgent,
  resolveAgentId,
  TERMINAL_STATUSES,
  PERSISTENT_DONE_STATUSES,
} from "./fountain-run";
export type { FountainRunArgs, FountainRunResult, ResolvedAgent, TerminatePolicy } from "./fountain-run";
