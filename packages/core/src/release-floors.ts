/**
 * The version of the next chant release (#4480, #4473).
 *
 * A contract floor added since the last release, the first chant that can
 * write a field, names the release that ships it. That release has no number
 * until the maintainer cuts it, so every such floor is this constant, and the
 * schema and docs text that repeats a floor ("written by chant X and newer",
 * the "Fields added within version 1" rows) is listed in
 * scripts/release-floors.ts, which checks it agrees.
 *
 * To set the number: `npx tsx scripts/release-floors.ts --set <version>`
 * rewrites this constant and every listed text. `just release` refuses to
 * cut a version when any floor names a version that is neither a published
 * release nor the one being cut.
 *
 * After the cut, a floor stays at the value it was released with. Once the
 * release is published, `just release-floors --freeze <version>` writes the
 * version into every floor that names this constant as a literal, and moves
 * this constant to the next patch (#4501). The check fails while a floor
 * still names this constant after its version shipped.
 */
export const NEXT_RELEASE = "0.124.85";

/** The first chant whose overdue check finds a schedule in any pipeline file, and whose `ScheduledWatch` takes a product's `files` and GitLab `schedule` selector (#4789). */
export const OVERDUE_PIPELINE_FILES_FLOOR = NEXT_RELEASE;

/** The first chant whose `terraformApplyCapabilityWith` takes `onCommand`, a hook around each engine command `terraform-apply` runs for a root, its reads' upstreams included (#4865). */
export const TERRAFORM_APPLY_COMMAND_HOOK_FLOOR = NEXT_RELEASE;

/** The first chant with `@intentius/chant/forge-flags` (`forgeTargetWith`, `forgeTargetFromFlags`, `apiBaseOf`), `@intentius/chant/chant-install` (`bundledChant`, `chantArgv`, `installChantResolveFallback`) and `noteLimit` and `fitNote` in `@intentius/chant/plan-summary` (#4800). */
export const PRODUCT_HELPERS_FLOOR = NEXT_RELEASE;

/** The first chant whose terraform lexicon's `terraform-apply` reads take `dir` and `workspace`, and read an upstream with `resolveRoot`'s binary and `readEnv` (terragucci issue 1303). */
export const TERRAFORM_APPLY_INSTANCE_READS_FLOOR = "0.124.80";

/** The first chant whose terraform lexicon's `terraform-apply` takes `binary`, and `terraformApplyCapabilityWith({ resolveRoot })` gives each root its own binary (terragucci issue 1303). */
export const TERRAFORM_APPLY_ROOT_BINARY_FLOOR = "0.124.80";

/** The first chant whose op wave hands a step's capability the wave's `cwd` (`DeployContext.cwd`), where `terraform-apply` looks for `chant.config.*` and `terragrunt-apply` runs when the step names neither (#4854). */
export const OP_WAVE_STEP_CWD_FLOOR = "0.124.80";

/** The first chant whose terraform lexicon's `terraform-apply` takes `workspace`: init in `default`, then `workspace select -or-create=true`, and plan, apply and output in it (#4854). */
export const TERRAFORM_APPLY_WORKSPACE_FLOOR = "0.124.80";

/** The first chant whose change-set member can carry `outputs`, the outputs its plan changes, and counts a member with any as a change (#4849). */
export const CHANGE_SET_OUTPUTS_FLOOR = "0.124.79";

/** The first chant whose terraform lexicon's `terragruntApplyCapability` takes `resolveUnit` and plans a wave as one `run --all` per pair of pinned releases (#4849). */
export const TERRAGRUNT_UNIT_PINS_FLOOR = "0.124.79";

/** The first chant whose sql lexicon's `yodelCommitSpec("new", ...)` takes `envs`, so `--replace-own` reads those histories as the reader (#4815). */
export const YODEL_NEW_ENVS_FLOOR = "0.124.78";

/** The first chant whose sql lexicon's `yodelRefusalReply` reads yodel rebase's conflict refusal as yodel prints it, `<a> and the migrations after <p> up to <b>` or `<a> and the chain ending at <b>` (#4821). */
export const YODEL_CONFLICT_REPLY_FLOOR = "0.124.78";

/** The first chant with `@intentius/chant/ci-note-commands`, `chant components pr-notes` and the GitLab pipeline's `note-commands` job (`--note-commands`), and whose forge reads answer `branchRuns` and `pullRequestsUpdated` (#4785). */
export const NOTE_COMMANDS_FLOOR = "0.124.80";

/** The first chant whose forge reads answer `compare`, `job` and, on GitLab, `artifactFile`, and whose `RunJob` names its `run`, `ref`, `tag` and `url` (#4862). */
export const PR_FORGE_COMPARE_READS_FLOOR = "0.124.80";

/** The first chant whose forge reads answer `headRuns`, `run`, `runJobs` and `artifacts`: a head's workflow runs (GitLab's pipelines), a run, its jobs and its artifacts by name (#4846). */
export const PR_FORGE_RUN_READS_FLOOR = "0.124.80";

/** The first chant whose `@intentius/chant/pr-forge-reads` exports the forge reads beside the clients (#4809). */
export const PR_FORGE_READS_FLOOR = "0.124.78";

/** The first chant whose GitLab `scheduledRuns` takes `schedule`, the selector of an Op's `gitlab.scheduleRule` (#4813). */
export const SCHEDULED_RUNS_SELECTOR_FLOOR = "0.124.78";
