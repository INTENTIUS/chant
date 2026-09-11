// Plugin
export { augurPlugin } from "./plugin";

// Serializer
export { augurSerializer, collectProfiles, AUGUR_PROFILES_VERSION } from "./serializer";
export type { SerializedProfile } from "./serializer";

// The one declared resource: the question, not the estate.
export { Profile, PROFILE_TYPE } from "./resources";

// The coverage table (#2357) — which entity types reach an engine, and which
// are declared unmapped. Exported because a consumer rendering a report wants
// to say why a row is missing, and the reason is written down here rather than
// transcribed.
export {
  ENGINE_KINDS,
  ENGINE_KINDS_BY_ENTITY_TYPE,
  DECLARED_UNMAPPED,
  augurCoverageTable,
  coverageFor,
  isEngineKind,
  unmappedDetail,
} from "./mapping";
export type { CoverageRow, CoverageVerdict, EngineKind, EngineKindMapping } from "./mapping";

// The request, built offline from chant's typed source.
export { AUGUR_REQUEST_VERSION, buildEngineRequest, renderEngineRequest, sizeOf } from "./request";
export type { EngineEdge, EngineNode, EngineRequest, WithheldEntity } from "./request";

// The engine level over the contract's transport (#2373): the parse of an
// `augur/v1` answer, the command transport, and the chooser that routes a URL
// to core's HTTP transport.
export {
  AUGUR,
  commandEngine,
  commandTransport,
  connectWith,
  defaultConnect,
  figureProblems,
  parseEngineAnswer,
  transportEngine,
} from "./engine";
export type {
  BehaviourEngine,
  EngineAnswer,
  EngineConnect,
  EngineFigure,
  EngineOutcome,
  ParsedEngineAnswer,
} from "./engine";

// predictBehaviour, with the environment and transport injectable.
export { createAugurPredict } from "./predict-behaviour";
export type { AugurPredictDeps } from "./predict-behaviour";
