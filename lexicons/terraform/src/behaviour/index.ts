// The live path for choudoufu roots (#2360): the account as it stands, as a
// behaviour engine's request, and the same producer over the declaration so
// the two sides of the delta are built alike.
export {
  blockAddressOf,
  edgeCoverageOf,
  regionOfArn,
  substituteReferences,
  terraformBehaviourRequest,
  type LiveResourceFacts,
  type LiveResourceStatus,
  type TerraformBehaviourEntity,
  type TerraformBehaviourRequest,
  type TerraformBehaviourRequestOptions,
  type TerraformLiveRead,
} from "./request";
export {
  liveRootsOf,
  predictTerraformBehaviour,
  TERRAFORM,
  type TerraformBehaviourDeps,
  type TerraformPredictOptions,
} from "./predict";
export {
  CATALOGUED_KINDS,
  isUnresolvedKind,
  REFERENCES_NOTHING,
  TERRAFORM_REFERENCE_CATALOG,
} from "./reference-catalog";
