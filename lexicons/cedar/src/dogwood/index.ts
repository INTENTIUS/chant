/**
 * The dogwood temporal dialect (#1658, epic #1646).
 *
 * A dialect of the cedar lexicon, not a lexicon of its own: `.dw` policies are
 * Cedar policies with temporal clauses, their entity and action schemas are
 * Cedar schemas, and the rendering is shared with the `.cedar` leg. Checks
 * ship under the `DWD` id family, declared on the cedar serializer's
 * `extraRulePrefixes`.
 *
 * Pre-release. Upstream (dogwood-policy/dogwood, Apache-2.0) is a read-only
 * squash-sync mirror with no tags, no releases and no stability statement, and
 * calls itself "NOT intended for production use". The surface here is built
 * against the revision recorded in `./upstream.ts` and re-verified per
 * sub-issue.
 */

export {
  DEFAULT_MAX_WINDOW,
  isWindowParam,
  renderWindow,
  renderWindowValue,
  window,
  windowParam,
  windowSeconds,
  windowValue,
} from "./window";
export type { TemporalWindow, TimeUnit, WindowLike, WindowParam, WindowValue } from "./window";

export {
  and,
  arrayOf,
  binderName,
  bool,
  call,
  compare,
  count,
  ctx,
  decimalOf,
  entityUid,
  exists,
  formerly,
  int,
  interval,
  not,
  predicate,
  previous,
  raw,
  renderCondition,
  renderTerm,
  scopeRef,
  sigilCondition,
  since,
  str,
  sum,
  temporalMarker,
  term,
  tp,
  typedBinder,
  varRef,
  wildcard,
} from "./temporal";
export type {
  AndNode,
  ArrayTerm,
  CallNode,
  ComparisonNode,
  ComparisonOperator,
  CountTerm,
  ExistsNode,
  FormerlyNode,
  IntervalArg,
  MacroArg,
  NotNode,
  PredicateNode,
  PreviousNode,
  RawCondition,
  SigilCondition,
  SinceNode,
  SumTerm,
  TemporalCondition,
  TemporalTerm,
  TermInput,
  TermText,
  TpNode,
  TypedBinder,
  WindowArgument,
} from "./temporal";

export {
  DEFAULT_MACRO_NAMES,
  bind,
  countDistinctWithin,
  countWithin,
  defCedarMacro,
  defTemporalMacro,
  defaultMacroLibrary,
  macroCondition,
  macroTerm,
  macroWindow,
  renderMacroDefinition,
  renderMacroLibrary,
  sumWithin,
} from "./macros";
export type { MacroDefinition, MacroKind } from "./macros";

export {
  concrete,
  declaredEventKinds,
  defaultEventSchema,
  eventDeclaration,
  eventSchema,
  field,
  pinContext,
  pinPrincipal,
  pinResource,
  pinnedField,
  principalType,
  record,
  renderEventSchema,
  resourceType,
  spreadInputs,
  spreadOutputs,
} from "./event-schema";
export type {
  EventDeclaration,
  EventField,
  EventFieldType,
  EventSchema,
  EventSelector,
  NamedField,
  PinTarget,
  SpreadField,
} from "./event-schema";

export {
  DOGWOOD_EVENT_SCHEMA_FILENAME,
  DOGWOOD_EVENT_SCHEMA_TYPE,
  DOGWOOD_LEXICON,
  DOGWOOD_MACRO_FILENAME,
  DOGWOOD_MACRO_LIBRARY_TYPE,
  DOGWOOD_POLICY_FILENAME,
  DOGWOOD_POLICY_TYPE,
  TemporalEventSchema,
  TemporalMacroLibrary,
  TemporalPolicy,
} from "./policy";
export type { EventSchemaProps, MacroLibraryProps, TemporalPolicyProps } from "./policy";

export {
  DOGWOOD_EVENT_SCHEMA_SUFFIX,
  DOGWOOD_POLICY_SUFFIX,
  dogwoodPolicyRecords,
  renderTemporalPolicyText,
  serializeDogwood,
} from "./serialize";
export type { DogwoodPolicyRecord, DogwoodSerializeResult } from "./serialize";

export {
  blankComments,
  dogwoodPolicyFiles,
  dogwoodSchemaFiles,
  effectiveMaxWindowSeconds,
  readEventSchema,
  scanPredicates,
  scanWindowlessOperators,
  scanWindows,
  temporalRegions,
} from "./scan";
export type { DogwoodArtifact, EventSchemaFacts, TemporalPredicateRef, WindowRef } from "./scan";

export { DOGWOOD_UPSTREAM } from "./upstream";

export {
  DOGWOOD_BINARY_ENV,
  DOGWOOD_BINARY_NAME,
  DOGWOOD_SEARCH_ORDER,
  configureDogwoodCli,
  findDogwoodBinary,
  formatDogwoodDiagnostic,
  parseLowerOutput,
  parseReplayOutput,
  parseValidateOutput,
  resetDogwoodCli,
  runDogwoodLower,
  runDogwoodReplay,
  runDogwoodValidate,
} from "./cli";
export type {
  DogwoodBinary,
  DogwoodBinarySource,
  DogwoodBundle,
  DogwoodDiagnostic,
  DogwoodFatal,
  DogwoodLabel,
  DogwoodLowerResult,
  DogwoodLowered,
  DogwoodReplayResult,
  DogwoodRun,
  DogwoodRunner,
  DogwoodUnusable,
  DogwoodValidateResult,
  DogwoodVerdict,
} from "./cli";

// Replay traces (#1661) — typed construction of the §6 line grammar, with
// both-bag population as the default and the weakening as an opt-out.
export {
  auditTrace,
  decimalValue,
  entityRef,
  rawValue,
  renderTrace,
  renderTraceFields,
  renderTraceLine,
  renderTraceValue,
  traceEntity,
  traceEvent,
  traceFixture,
} from "./trace";
export type {
  TraceAuditOptions,
  TraceBags,
  TraceDecimal,
  TraceEntityDecl,
  TraceEntityRef,
  TraceEvent,
  TraceEventInput,
  TraceFields,
  TraceFixture,
  TraceFixtureOptions,
  TraceIssue,
  TraceIssueKind,
  TraceRaw,
  TraceScope,
  TraceTagged,
  TraceValue,
} from "./trace";

// The replay activities (#1661). Contributed by name through
// `src/op/activities/index.ts`; the helpers are here for direct use.
export {
  compareVerdicts,
  dogwoodReplay,
  dogwoodReplayReport,
  renderReplaySummary,
  resolveReplayInputs,
} from "./replay-activity";
export type {
  DogwoodReplayArgs,
  DogwoodReplayReportArgs,
  ExpectedVerdict,
  PolicyReplayDispatch,
  PolicyReplayMode,
  PolicyReplayReport,
  ReplayDivergence,
  ReplayExpectation,
} from "./replay-activity";

// The PolicyReplayOp composite and its typed step builders (#1661).
export {
  DEFAULT_REPLAY_REPORT_PATH,
  PolicyReplayOp,
  dogwoodReplayReportStep,
  dogwoodReplayStep,
} from "./replay-op";
export type {
  DogwoodReplayReportStepOpts,
  DogwoodReplayStepOpts,
  PolicyReplayOpConfig,
  PolicyReplayOpResources,
} from "./replay-op";
