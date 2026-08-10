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
  parseValidateOutput,
  resetDogwoodCli,
  runDogwoodLower,
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
  DogwoodRun,
  DogwoodRunner,
  DogwoodUnusable,
  DogwoodValidateResult,
} from "./cli";
