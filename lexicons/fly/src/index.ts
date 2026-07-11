// Plugin
export { flyPlugin } from "./plugin";

// Serializer
export { flySerializer } from "./serializer";

// Ownership marker convention (machine config.metadata keys)
export { FLY_METADATA_OWNERSHIP_KEYS } from "./ownership";

// Generated resources — export everything from generated index.
// Provides `App`, `Machine`, `Volume`, and the property types
// (`MachineConfig`, `MachineGuest`, `MachineService`, ...) for authoring.
export * from "./generated/index";
