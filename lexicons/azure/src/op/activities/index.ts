/**
 * Azure Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `azure` lexicon. Contributes the resource-group
 * lifecycle (`azGroupEnsure`/`azGroupDelete`) that an ARM `nativeApply` needs.
 */
export { azGroupEnsure, azGroupDelete, azGroupEnsureCommand, azGroupDeleteCommand } from "./azure";
export type { AzGroupEnsureArgs, AzGroupDeleteArgs } from "./azure";

export {
  azApply,
  evalArm,
  evalArmString,
  armResourceUrl,
  armResourceBody,
  armDependencies,
  orderArmResources,
} from "./az-apply";
export type { AzApplyArgs, ArmEvalCtx, ArmResource, AzHttp } from "./az-apply";
