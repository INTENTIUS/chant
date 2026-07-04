/**
 * Component-native release orchestration — capability contract, starter verb
 * set, and the thin interpret driver (epic #551, #554/#556). The pilot AWS
 * leaves have real implementations over an injectable `CloudExecutor` (#557);
 * every other verb remains a typed stub. See https://intentius.io/chant/components/orchestration/
 */

export {
  type Archetype,
  type Wiring,
  type StackOutputReference,
  type BuildSpec,
  type Step,
  type Gate,
  type Phase,
  type Component,
  phase,
  gate,
  stackOutput,
  inferArchetype,
  projectToJson,
  isComponent,
} from "./component";
export {
  type DiscoveredComponent,
  type ComponentDiscoveryResult,
  discoverComponents,
} from "./discover";
export {
  type ListedComponent,
  type ListComponentsResult,
  type DescribedComponent,
  type DescribeComponentResult,
  type ComponentGraphResult,
  type GenerateLexicon,
  type GenerateComponentsResult,
  type RunComponentsOptions,
  type RunComponentsResult,
  type ResolvedComponentTargets,
  listComponents,
  describeComponent,
  computeComponentGraph,
  generateComponentsPipeline,
  runComponents,
  findComponentGate,
  resolveComponentTargets,
} from "./cli-support";
export {
  type GeneratedJob,
  type GenerateGitlabOptions,
  type GenerateGitlabResult,
  generateGitlabPipeline,
} from "./generate-gitlab";
export { renderDriverHuman, renderDriverJson } from "./driver-output";
export {
  type Capability,
  type CapabilityInput,
  type CapabilityOutput,
  type DeployContext,
  CapabilityRegistry,
  CapabilityNotImplementedError,
} from "./capability";
export { createCapabilityRegistry, STARTER_VERB_FAMILIES } from "./registry";
export {
  type CapabilityPlugin,
  type CapabilityManifest,
  isCapabilityPlugin,
} from "./capability-plugin";
export {
  CapabilityManifestSchema,
  type CapabilityManifestParsed,
  validateCapabilityManifest,
} from "./capability-plugin-schema";
export {
  loadCapabilityPlugin,
  loadCapabilityPlugins,
  registerCapabilityPlugins,
  buildCapabilityRegistry,
  type BuildCapabilityRegistryOptions,
  MalformedCapabilityPluginError,
  DuplicateCapabilityKindError,
} from "./capability-plugin-loader";
export { starterCapabilityPlugin } from "./starter-plugin";
export * from "./verbs/index";
export * from "./builders";
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
  resolveStepInput,
  runComponentDeploy,
  runInterpretDriver,
  DriverGateUnsupportedError,
  DependencyCycleError,
  UnknownDependencyError,
  DriverRunFailure,
} from "./driver";
export {
  EcsFargateComponent,
  type EcsFargateComponentConfig,
  LambdaComponent,
  type LambdaComponentConfig,
  SingleHostComposeComponent,
  type SingleHostComposeComponentConfig,
} from "./presets/index";
export {
  type ComponentTemporalCodegen,
  type ComponentTemporalCodegenOptions,
  loadComponentTemporalCodegen,
} from "./temporal-codegen-loader";
