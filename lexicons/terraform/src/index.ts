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
  splitBundleContent,
  terraformEntity,
  DATA_TYPE,
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
} from "./hcl/parse";

export { renderTerraformRoots, type TerraformRootsResult } from "./hcl/roots";
