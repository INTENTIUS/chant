// Plugin
export { flyPlugin } from "./plugin";

// Serializer
export { flySerializer } from "./serializer";

// Ownership marker convention (machine config.metadata keys)
export { FLY_METADATA_OWNERSHIP_KEYS } from "./ownership";

// Deploy Op composite + typed step builders (#744). `flyDeploy` returns a
// `boot → build → flyApply → wait → teardown` Op; the step builders wrap the
// generic `activity()` so the fly activities resolve by name without a core change.
export { flyDeploy, flapsUp, flapsDown, flyApplyStep, LOCAL_FLAPS_ENDPOINT } from "./composites/fly-deploy";
export type { FlyDeployOpts, FlyApplyStepOpts, FlapsStepOpts } from "./composites/fly-deploy";

// Generated resources — export everything from generated index.
// Provides `App`, `Machine`, `Volume`, and the property types
// (`MachineConfig`, `MachineGuest`, `MachineService`, ...) for authoring.
export * from "./generated/index";
