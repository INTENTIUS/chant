// Plugin
export { terraformPlugin } from "./plugin";

// Serializer
export { terraformSerializer } from "./serializer";

// The `terraform` config namespace. Importing this package is what brings the
// `terraform` key into `ChantConfig` (#1344), so the augmentation must be
// reachable from the entry point.
export {
  terraformConfigSchema,
  terraformRootSchema,
  type TerraformConfig,
  type TerraformRootConfig,
  type TerraformConfigNamespace,
} from "./config";

// HCL parse: one entity per block, shared by the build path and (from #2085)
// the audit path.
export {
  blocksToEntities,
  parseTerraformRootContent,
  parseTerraformRootDir,
  readLiveSidecarFile,
  splitBundleContent,
  terraformEntity,
  DATA_TYPE,
  LIVE_SIDECAR_FILENAME,
  LIVE_TYPE,
  LOCALS_TYPE,
  MODULE_TYPE,
  OUTPUT_TYPE,
  PROVIDER_TYPE,
  RESOURCE_TYPE,
  TERRAFORM_TYPE,
  VARIABLE_TYPE,
  type BlockBody,
  type TerraformEntity,
  type TerraformFile,
  type TerraformRootMode,
  type TerraformRootModeOptions,
} from "./hcl/parse";

export { renderTerraformRoots, type TerraformRootsResult } from "./hcl/roots";

// Typed Op step builders (#2086). Same names as the activities they wrap, and
// like k3s's they are opt-in from the lexicon root — the activities themselves
// are reached by the registry through `./op/activities`, never from here.
export {
  terraformInit,
  terraformPlan,
  terraformApply,
  terraformShow,
  choudoufuLivePlan,
  choudoufuLiveLs,
  choudoufuLiveCheck,
  choudoufuAdopt,
} from "./op/builders";

// The adoption ledger over `live-plan -json`'s document (#2105). Pure, and
// exported because the ledger's shape is what a project reading an Op's own
// result is reading.
export {
  parseAdoptionCommands,
  readAdoptionLedger,
  renderAdoptionLedger,
  type AdoptionCandidate,
  type AdoptionLedger,
} from "./op/adoption";

// The Init/Plan/Gate/Apply composite (#2086).
export { TerraformApplyOp } from "./composites/terraform-apply-op";
export type {
  TerraformApplyOpConfig,
  TerraformApplyOpResources,
  TerraformGateMode,
} from "./composites/terraform-apply-op";

// The Init/Plan/[Report] drift composite (#2087).
export { TerraformWatchOp } from "./composites/terraform-watch-op";
export type {
  TerraformWatchOpConfig,
  TerraformWatchOpResources,
  TerraformFindingMode,
} from "./composites/terraform-watch-op";

// The Check/Ledger/Gate/Adopt composite (#2105): reconcile for a choudoufu
// estate, and #2089's answer for this backend.
export { TerraformAdoptOp } from "./composites/terraform-adopt-op";
export type { TerraformAdoptOpConfig, TerraformAdoptOpResources } from "./composites/terraform-adopt-op";

// Live observation over `terraform show -json` (#2087). The plugin reaches
// `describeResources` through a dynamic import; the ownership keys are here
// because `ownershipChannel` declares them eagerly.
export { TERRAFORM_STATE_OWNERSHIP_KEYS } from "./state-ownership";
