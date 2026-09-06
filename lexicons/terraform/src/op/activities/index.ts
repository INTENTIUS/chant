/**
 * terraform Op activities — resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `terraform` lexicon. `loadActivities`
 * (`packages/core/src/op/activity-registry.ts`) imports
 * `@intentius/chant-lexicon-terraform/op/activities` and keys every exported
 * function by its name, so there is no plugin member to register:
 *
 *   - terraformInit — `init` with the root's `backendConfig`.
 *   - terraformPlan — `plan -detailed-exitcode -out=<planFile>`, plus both
 *     `show` renders of the written plan.
 *   - terraformApply — `apply <planFile>`, a saved plan only.
 *   - terraformShow — state, or a saved plan, as JSON and as text.
 *
 * The module is dependency-light on purpose: it shells out to the configured
 * binary and reads the `terraform` config namespace, and never touches the
 * lexicon's HCL parse or serializer, so a Temporal worker loads it cheaply.
 * The pure command and environment builders are exported alongside the
 * activities because they are what the tests assert on.
 */
export {
  terraformInit,
  terraformPlan,
  terraformApply,
  terraformShow,
  terraformInitCommand,
  terraformPlanCommand,
  terraformApplyCommand,
  terraformShowCommand,
  terraformEnvironment,
  terraformBinary,
  countPlanChanges,
  quoteArg,
  DEFAULT_PLAN_FILE,
  DEFAULT_TERRAFORM_BINARY,
} from "./terraform";

export type {
  TerraformRootArgs,
  TerraformInitArgs,
  TerraformPlanArgs,
  TerraformApplyArgs,
  TerraformShowArgs,
  TerraformInitResult,
  TerraformPlanResult,
  TerraformApplyResult,
  TerraformShowResult,
  PlanChangeCounts,
} from "./terraform";
