/**
 * fly Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `fly` lexicon. Contributes the native flaps
 * applier (`flyApply`), which speaks the Fly Machines REST API directly (no
 * flyctl, no state file), and the mudflaps emulator lifecycle it is tested
 * against.
 */
export {
  flyApply,
  flyDelete,
  applyApp,
  applyMachine,
  destroyMachine,
  deleteApp,
  listMachines,
  pruneMachines,
  waitForMachine,
  acquireLease,
  releaseLease,
  withLease,
  resolveEndpoint,
  parsePlan,
  isAppRequest,
  isMachineRequest,
  machineAppSegment,
  resolveApp,
  appNameFromRequest,
  isChantOwned,
  configEqual,
  isLeaseConflict,
  defaultFlyHttp,
  DEFAULT_FLAPS_BASE_URL,
  LEASE_NONCE_HEADER,
} from "./fly-apply";
export type { FlyApplyArgs, FlyPlan, FlapsRequest, FlapsMachine, FlyHttp, WaitOpts, ApplyCtx } from "./fly-apply";

// mudflaps (Fly Machines API emulator) lifecycle — boots/tears down the local
// flaps target flyApply is exercised against.
export {
  flapsUp,
  flapsDown,
  flapsRunCommand,
  flapsRmCommand,
  flapsExistsCommand,
  flapsHealthUrl,
  flapsEndpoint,
} from "./flaps";
export type { FlapsUpArgs, FlapsDownArgs } from "./flaps";
