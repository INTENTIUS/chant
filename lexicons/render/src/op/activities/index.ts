/**
 * render Op activities — resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `render` lexicon. Contributes the
 * native Render API applier (`renderApply`), which speaks the Render Public
 * API directly (no CLI, no Blueprint, no state file), and its teardown twin
 * (`renderDelete`).
 */
export {
  renderApply,
  renderApplyDetailed,
  renderDelete,
  toApplyResult,
  resolveEndpoint,
  parsePlan,
  orderPlan,
  collectDependencies,
  configEqual,
  diffForPatch,
  envVarsToMap,
  declaredEnvVarsToMap,
  envVarsDiffer,
  isChantOwned,
  ownershipOf,
  planOwnership,
  inStack,
  defaultRenderHttp,
  listAll,
  getOne,
  resolveOwner,
  findExisting,
  resolveAttribute,
  resolveMarkers,
  create,
  patch,
  remove,
  readServiceEnvVars,
  putServiceEnvVars,
  reconcileEnvGroupVars,
  linkEnvGroupServices,
  latestDeploy,
  waitForDeploy,
  DEFAULT_RENDER_BASE_URL,
} from "./render-apply";
export type {
  RenderApplyArgs,
  RenderApplyOutcome,
  RenderHttp,
  WaitOpts,
  ApplyCtx,
  LiveEntity,
} from "./render-apply";
