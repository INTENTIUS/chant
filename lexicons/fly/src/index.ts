// Plugin
export { flyPlugin } from "./plugin";

// Component/release capabilities — run-agent, the sprite-lifecycle leaf
// contributed to core's capability-plugin seam (#1942). Core loads
// `flyCapabilityPlugin` when a project's chant.config lists this lexicon.
export { flyCapabilityPlugin, FLY_VERB_FAMILIES } from "./components/capability-plugin";

// Serializer
export { flySerializer } from "./serializer";

// Pseudo-parameters — environment-resolved values (`Fly.Region`, `Fly.OrgSlug`,
// `Fly.AppName`) usable in place of hard-coded strings.
export { Fly, Region, OrgSlug, AppName, PseudoParameter } from "./pseudo";

// Ownership marker convention (machine config.metadata keys)
export { FLY_METADATA_OWNERSHIP_KEYS } from "./ownership";

// Deploy Op composite + typed step builders (#744). `flyDeploy` returns a
// `boot → build → flyApply → wait → teardown` Op; the step builders wrap the
// generic `activity()` so the fly activities resolve by name without a core change.
export { flyDeploy, flapsUp, flapsDown, flyApplyStep, LOCAL_FLAPS_ENDPOINT } from "./composites/fly-deploy";
export type { FlyDeployOpts, FlyApplyStepOpts, FlapsStepOpts } from "./composites/fly-deploy";

// Sprite Op step builders (re-exported from core for single-import convenience).
// These author `activity("spriteCreate", ...)` steps; `loadActivities(["fly"])`
// binds them to the implementations in ./op/activities/sprites.ts. The `spritesUp`
// /`spritesDown` builders boot/tear down the spritzer emulator as modeled steps.
export {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  listCheckpoints,
  spriteDestroy,
  spriteWriteFile,
  spriteReadFile,
  spriteListDir,
  spriteRemove,
  spriteApplyNetworkPolicy,
  spriteApplyServices,
  spriteTaskCreate,
  spriteTaskRefresh,
  spriteTaskRelease,
  spritesUp,
  spritesDown,
} from "@intentius/chant/op";

// Generated resources — export everything from generated index.
// Provides `App`, `Machine`, `Volume`, and the property types
// (`MachineConfig`, `MachineGuest`, `MachineService`, ...) for authoring.
export * from "./generated/index";
