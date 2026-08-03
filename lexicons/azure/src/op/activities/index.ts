/**
 * Azure Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `azure` lexicon. Contributes the resource-group
 * lifecycle (`azGroupEnsure`/`azGroupDelete`) that an ARM `nativeApply` needs.
 */
export { azGroupEnsure, azGroupDelete, azGroupEnsureCommand, azGroupDeleteCommand } from "./azure";
export type { AzGroupEnsureArgs, AzGroupDeleteArgs } from "./azure";

// floci-az (Azure emulator) lifecycle — the typed twin of aws's flociUp/Down, so
// the trio's Azure op boots/tears down the emulator as a modeled step, not a shell.
export {
  flociAzUp,
  flociAzDown,
  flociAzRunCommand,
  flociAzRmCommand,
  flociAzExistsCommand,
  flociAzHealthUrl,
  flociAzEndpoint,
} from "./floci-az";
export type { FlociAzUpArgs, FlociAzDownArgs } from "./floci-az";

export {
  azApply,
  azDelete,
  pruneArmOrphans,
  toApplyResult,
  deleteArmResource,
  listGroupResources,
  chantOwnershipTags,
  isChantOwned,
  evalArm,
  evalArmString,
  armResourceUrl,
  armResourceBody,
  armDependencies,
  orderArmResources,
} from "./az-apply";
export type { AzApplyArgs, ArmEvalCtx, ArmResource, ArmListItem, AzHttp } from "./az-apply";
