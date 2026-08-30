/**
 * Pinnability gate for helm renders (#1234, epic #1228 Phase 1).
 *
 * `classifyChart` is the entry point the pinned-render pipeline
 * (#1235–#1240) calls before anything is pinned; the survey harness
 * (lexicons/helm/test/survey) asserts its verdicts over a corpus of real
 * upstream charts. This module deliberately imports nothing from the
 * lexicon's generated artifacts, so it loads on a fresh clone and in the
 * survey CI job without a generation step.
 */

export {
  classifyChart,
  type PinnabilityVerdict,
  type PinnabilityReport,
  type ClassifyChartOptions,
  type CapabilityRequirement,
  type ClosedInput,
  type ConditionalHazard,
  type ControlFlowLookup,
  type ValuePositionLookup,
  type RenderEvidence,
  collectOwnTemplateFiles,
} from "./classify";

export {
  actionPipeline,
  extractActions,
  scopeActions,
  type TemplateAction,
  type ActionKind,
  type ScopedAction,
  type ScopeFrame,
} from "./actions";

export {
  UNKNOWN,
  truthy,
  evaluateCondition,
  callReachability,
  parseExpr,
  type Tri,
  type EvalContext,
  type EvalResult,
  type GatePath,
} from "./conditions";

export {
  buildChartInstances,
  mergeValues,
  valueAtPath,
  readChartMeta,
  type ChartInstance,
  type ChartDependency,
  type ChartMeta,
} from "./values";

export {
  splitDocuments,
  sourcePath,
  isCrdSource,
  routeBySource,
  countDifferingLines,
  type RoutedDocuments,
} from "./render-stream";

export {
  localizeOpenInputs,
  diffRenderPair,
  type RenderFn,
  type PinStyle,
  type CandidatePin,
  type LocalizedOccurrence,
  type LocalizedInput,
  type LocalizationReport,
  type LocalizeOptions,
} from "./localize";
