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
 *   - terraformApply: `apply <planFile>` on a stock root, a saved plan only;
 *     `apply -auto-approve` with no plan file on a live root (#2103).
 *   - terraformShow — state, or a saved plan, as JSON and as text.
 *   - choudoufuLivePlan: `live-plan -detailed-exitcode -json -estate=<estate>`,
 *     plus a second `live-plan` for the human render (#2103).
 *   - choudoufuLiveLs: `live-ls -estate=<estate> -json [-consistent]` (#2103).
 *   - choudoufuLiveCheck: `live-check -json`, no cloud calls (#2103).
 *   - choudoufuAdopt: the tag writes that claim an adoption ledger's matches (#2105).
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
  choudoufuLivePlan,
  choudoufuLiveLs,
  choudoufuLiveCheck,
  choudoufuAdopt,
  terraformInitCommand,
  terraformPlanCommand,
  terraformApplyCommand,
  terraformShowCommand,
  choudoufuLiveApplyCommand,
  choudoufuLivePlanCommand,
  choudoufuLiveLsCommand,
  choudoufuLiveCheckCommand,
  terraformEnvironment,
  terraformBinary,
  countPlanChanges,
  countLivePlanUnowned,
  isOlderVersion,
  parseChoudoufuVersion,
  quoteArg,
  DEFAULT_PLAN_FILE,
  DEFAULT_TERRAFORM_BINARY,
  DEFAULT_LIVE_PLAN_DOCUMENT_FILE,
  MIN_CHOUDOUFU_VERSION,
  CHOUDOUFU_PLAN_FILE_REFUSAL,
} from "./terraform";

export type {
  TerraformRootArgs,
  TerraformInitArgs,
  TerraformPlanArgs,
  TerraformApplyArgs,
  TerraformShowArgs,
  ChoudoufuLivePlanArgs,
  ChoudoufuLiveLsArgs,
  ChoudoufuLiveCheckArgs,
  ChoudoufuAdoptArgs,
  TerraformInitResult,
  TerraformPlanResult,
  TerraformApplyResult,
  TerraformShowResult,
  ChoudoufuLivePlanResult,
  ChoudoufuLiveLsResult,
  ChoudoufuLiveCheckResult,
  ChoudoufuAdoptResult,
  AdoptionRefusal,
  PlanChangeCounts,
  LivePlanUnownedCounts,
} from "./terraform";

export { detectLiveEstate } from "./live-detect";
