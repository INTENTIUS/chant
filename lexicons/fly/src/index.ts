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

// The release a Machine serves, in its metadata (#2736): read by
// describeResources and compared with the release ledger by
// `chant components status --live`.
export { RELEASE_METADATA_KEYS, readMachineRelease, withReleaseMetadata } from "./release-metadata";
export type { MachineRelease } from "./release-metadata";

// Deploy Op composite + typed step builders (#744). `flyDeploy` returns a
// `boot → build → flyApply → wait → teardown` Op; the step builders wrap the
// generic `activity()` so the fly activities resolve by name without a core change.
export { flyDeploy, flapsUp, flapsDown, flyApplyStep, LOCAL_FLAPS_ENDPOINT } from "./composites/fly-deploy";
export type { FlyDeployOpts, FlyApplyStepOpts, FlapsStepOpts } from "./composites/fly-deploy";

// OpenTelemetry Collector on a Machine, its config declared with the otel lexicon (#2613).
export { FlyOtelCollector } from "./composites/fly-otel-collector";
export type { FlyOtelCollectorProps } from "./composites/fly-otel-collector";

// Sprite Op step builders. chant #1288 Stage 2: these author
// `activity("spriteCreate", ...)` steps with authoring-time types derived
// from this lexicon's own `Sprite*Args` interfaces (`./op/builders.ts`),
// replacing the hand-restated inline types core's same-named builders used
// to carry — same names, same import path, so an existing
// `import { spriteCreate } from "@intentius/chant-lexicon-fly"` call site
// gains real derived types with no change. `loadActivities(["fly"])` binds
// the `fn` strings to the implementations in `./op/activities/sprites.ts`
// etc. The `spritesUp`/`spritesDown` builders boot/tear down the spritzer
// emulator as modeled steps.
export {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  listCheckpoints,
  spriteDestroy,
  spriteDelete,
  spriteUrl,
  spriteWriteFile,
  spriteReadFile,
  spriteListDir,
  spriteRemove,
  spriteApplyNetworkPolicy,
  spriteApplyServices,
  spriteServiceCreate,
  spriteServiceGet,
  spriteServiceList,
  spriteServiceStart,
  spriteServiceStop,
  spriteServiceDelete,
  spriteServiceLogs,
  spriteServicesObserve,
  spriteServiceRestart,
  spriteTaskCreate,
  spriteTaskRefresh,
  spriteTaskRelease,
  spritesUp,
  spritesDown,
  flyMachineRelease,
  flyMachineExec,
  flyMachineRestart,
  flyMachineStop,
  flyMachineVerify,
  flyMachineRestore,
  flyRelease,
} from "./op/builders";

// Generated resources — export everything from generated index.
// Provides `App`, `Machine`, `Volume`, and the property types
// (`MachineConfig`, `MachineGuest`, `MachineService`, ...) for authoring.
export * from "./generated/index";
