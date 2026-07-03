/**
 * Component-native release orchestration — capability contract, starter verb
 * set, and the thin interpret driver (epic #551, #554/#556). The pilot AWS
 * leaves have real implementations over an injectable `CloudExecutor` (#557);
 * every other verb remains a typed stub. See https://intentius.io/chant/components/orchestration/
 */

export {
  type Capability,
  type CapabilityInput,
  type CapabilityOutput,
  type DeployContext,
  CapabilityRegistry,
  CapabilityNotImplementedError,
} from "./capability";
export { createCapabilityRegistry, STARTER_VERB_FAMILIES } from "./registry";
export * from "./verbs/index";
export {
  type DriverStep,
  type DriverGate,
  type DriverPhase,
  type DriverComponent,
  type DriverStepRecord,
  type DriverComponentResult,
  type DriverRunResult,
  type ComponentGraph,
  type InterpretRunOptions,
  type WiringValue,
  resolveComponentGraph,
  resolveWiring,
  runComponentDeploy,
  runInterpretDriver,
  DriverGateUnsupportedError,
  DependencyCycleError,
  UnknownDependencyError,
  DriverRunFailure,
} from "./driver";
