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

// The transport seam #2359's adapter fills.
export { commandEngine, defaultConnect, parseEngineAnswer } from "./engine";
export type { BehaviourEngine, EngineAnswer, EngineConnect, EngineFailure, EngineFigure, EngineOutcome } from "./engine";

// predictBehaviour, with the environment and transport injectable.
export { AUGUR, createAugurPredict } from "./predict-behaviour";
export type { AugurPredictDeps } from "./predict-behaviour";
