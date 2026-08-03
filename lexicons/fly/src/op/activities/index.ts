/**
 * fly Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `fly` lexicon. Contributes the native flaps
 * applier (`flyApply`), which speaks the Fly Machines REST API directly (no
 * flyctl, no state file), and the mudflaps emulator lifecycle it is tested
 * against.
 */
export {
  flyApply,
  toApplyResult,
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

// Sprites (sprites.dev) — the other Fly product: imperative, checkpointable
// sandbox activities. `loadActivities(["fly"])` provides these; the fake lives
// in `sprites-fake.ts` and is imported only by tests (not an activity). Unlike
// Machines, Sprites have no desired state to reconcile — they are runtime
// primitives driven inside an Op, with checkpoint-as-compensation as the
// headline capability.
export {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  listCheckpoints,
  spriteDestroy,
  resolveSpritesEndpoint,
  defaultSpritesHttp,
  spriteCreateBody,
  parseCreateResponse,
  accumulateExecFrames,
  parseCheckpointNdjson,
  pickCheckpointByComment,
  splitCommand,
  spriteExecWsUrl,
  DEFAULT_SPRITES_BASE_URL,
} from "./sprites";
export type {
  SpritesHttp,
  SpriteCreateArgs,
  SpriteCreateResult,
  SpriteExecArgs,
  SpriteExecResult,
  SpriteCheckpointArgs,
  SpriteCheckpointResult,
  SpriteRestoreArgs,
  ListCheckpointsArgs,
  Checkpoint,
  SpriteDestroyArgs,
} from "./sprites";

// Sprite filesystem activities (#848) — imperative file I/O over the fs API.
// `loadActivities(["fly"])` binds these; the step builders live in core.
export {
  spriteWriteFile,
  spriteReadFile,
  spriteListDir,
  spriteRemove,
  spriteFsUrl,
  defaultSpritesRawHttp,
} from "./sprite-fs";
export type {
  SpritesRawHttp,
  SpriteWriteFileArgs,
  SpriteReadFileArgs,
  SpriteReadFileResult,
  SpriteListDirArgs,
  SpriteDirEntry,
  SpriteRemoveArgs,
} from "./sprite-fs";

// Sprite config reconcile activities (#849) — the desired-state a Sprite carries:
// its outbound network policy and its background services. `loadActivities(["fly"])`
// binds these; the step builders live in core. Apply-activities, not a declarable
// resource — a Sprite has no build→plan→apply pipeline.
export {
  spriteApplyNetworkPolicy,
  spriteApplyServices,
  validateNetworkRules,
  networkRulesEqual,
  validateServices,
  serviceConfigEqual,
} from "./sprite-config";
export type {
  NetworkRule,
  SpriteApplyNetworkPolicyArgs,
  SpriteApplyNetworkPolicyResult,
  ServiceSpec,
  SpriteApplyServicesArgs,
  SpriteApplyServicesResult,
} from "./sprite-config";

// Sprite keep-alive Tasks activities (#847) — a hold that stops a Sprite pausing
// mid-session. `loadActivities(["fly"])` binds these; step builders live in core.
export {
  spriteTaskCreate,
  spriteTaskRefresh,
  spriteTaskRelease,
  spriteTasksUrl,
  spriteTaskUrl,
} from "./sprite-tasks";
export type {
  SpriteTaskCreateArgs,
  SpriteTaskRefreshArgs,
  SpriteTaskReleaseArgs,
} from "./sprite-tasks";

// spritzer (the Sprites API emulator) Docker lifecycle — the twin of mudflaps
// above. `spritesUp`/`spritesDown` resolve by name so an Op can boot/tear down
// the emulator as a modeled step; the sprite activities target it via
// SPRITES_BASE_URL.
export {
  spritesUp,
  spritesDown,
  spritesRunCommand,
  spritesRmCommand,
  spritesExistsCommand,
  spritesHealthUrl,
  spritesEndpoint,
} from "./sprites-emulator";
export type { SpritesUpArgs, SpritesDownArgs } from "./sprites-emulator";
