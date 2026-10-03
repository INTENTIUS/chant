/**
 * fountain Op activities — resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `fountain` lexicon. Contributes
 * the native applier (`fountainApply` — direct REST against fountain's
 * API, no CLI, no state file), the conversation runner (`fountainRun`) and
 * the next turn on a conversation (`fountainPrompt`, #3356).
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

export { fountainPrompt } from "./fountain-prompt";
export type { FountainPromptArgs, FountainPromptResult } from "./fountain-prompt";
