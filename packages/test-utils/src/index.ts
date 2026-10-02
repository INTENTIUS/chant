export { createTestDir, cleanupTestDir, withTestDir } from "./fs";
export {
  createMockEntity,
  createMockSerializer,
  createMockLintRule,
  createMockLintContext,
  createPostSynthContext,
} from "./fixtures";
export { expectToThrow } from "./assertions";
export { FIXTURE } from "./fixture-constants";
export { describeExample, describeAllExamples, declaredBuildOptions, declaredBuildParams } from "./example-harness";
export type { ExampleHarnessConfig, ExampleOpts } from "./example-harness";
export {
  makePostSynthCtx,
  makePostSynthCtxFromFiles,
  makePostSynthCtxFromJSON,
  runCheck,
  expectNoDiagnostics,
  expectDiagnostic,
} from "./post-synth-harness";
export { createMockPlugin, staticDescribeResources, staticObservation, staticDeepObservation, staticListArtifacts, staticBehaviour } from "./mock-plugin";
export type { MockPluginOptions } from "./mock-plugin";
export { describeObservationConformance } from "./observation-conformance";
export {
  describeBehaviourConformance,
  behaviourConformanceGaps,
  probeTrafficLevel,
  probeReadsEdges,
  probeEdgelessConsistency,
  probeEchoesCoverage,
} from "./behaviour-conformance";
export { describeApplyConformance } from "./apply-conformance";
export { describeWorkspaceKindConformance } from "./workspace-kind-conformance";
export {
  describeWorkspaceReaderConformance,
  runWorkspaceReaderConformance,
  checkReaderRead,
  readerCallProblems,
  READ_CONTRACT_COMMANDS,
  READ_CONTRACT_SCHEMAS,
  READ_CONTRACT_JSON_FLAGS,
  REFERENCE_READS,
} from "./workspace-reader-conformance";
export type { ObservationConformanceConfig, ObservationScenario } from "./observation-conformance";
export type { BehaviourConformanceConfig, BehaviourScenario } from "./behaviour-conformance";
export type { WorkspaceKindConformanceConfig, WorkspaceKindScenario } from "./workspace-kind-conformance";
export type {
  WorkspaceReaderConformanceConfig,
  WorkspaceReaderConformanceOptions,
  WorkspaceReaderConformanceReport,
  WorkspaceReader,
  ChantTransport,
  ChantRun,
  ReadContractCommand,
} from "./workspace-reader-conformance";
export type {
  ApplyConformanceConfig,
  ApplyScenario,
  PruneScenario,
  IdempotenceScenario,
} from "./apply-conformance";
