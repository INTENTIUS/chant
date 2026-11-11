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
export const NEXT_RELEASE = "0.124.91";

/** The first chant with `chant dev local` and `chant dev bundle-check`, `@intentius/chant/local-chant` and `@intentius/chant/bundle-check` (`chantRuntimeTarget`, `chantExternalPlugin`, `checkBundle`): a product built against a chant checkout, and its bundle checked, without its own scripts (#4787). */
export const LOCAL_CHANT_FLOOR = "0.124.86";

/** The first chant with `chant workspace ref-gate` (pre-receive, pre-push, check, status, attach, install) and `refs` in `.chant/trust.json`, the checks a ref update needs evidence for (#4867). */
export const REF_GATE_FLOOR = "0.124.86";

/** The first chant whose overdue check finds a schedule in any pipeline file, and whose `ScheduledWatch` takes a product's `files` and GitLab `schedule` selector (#4789). */
export const OVERDUE_PIPELINE_FILES_FLOOR = "0.124.86";

/** The first chant whose `terraformApplyCapabilityWith` takes `onCommand`, a hook around each engine command `terraform-apply` runs for a root, its reads' upstreams included (#4865). */
export const TERRAFORM_APPLY_COMMAND_HOOK_FLOOR = "0.124.86";

/** The first chant whose terraform lexicon times each root's engine commands and reads its spans and lock waits (`@intentius/chant-lexicon-terraform/engine-timings`, `engineTimings()` as `terraformApplyCapabilityWith`'s `onCommand`), and runs a composed group's commands through that hook (#4887). */
export const TERRAFORM_ENGINE_TIMINGS_FLOOR = "0.124.88";

/** The first chant whose terraform lexicon finds live roots and estates (`live-roots`), places a Terragrunt unit (`terragruntUnitPlace`), reads a state migration's history and revert from its finished lines (`migration-history`), and runs the binary without the forge's tokens (`tokenlessBinaryExec`, `engineEnv`) (#4910). */
export const TERRAFORM_ROOT_HELPERS_FLOOR = "0.124.88";

/** The first chant whose terraform lexicon has one runner of the engine for a product (`engineRunner` in `engine-runner`: a hooked `exec`, `execSync`, `terragrunt` and the tokenless `script`), traces each engine command (`commandTrace`, `commandTraceEnv`), sends each Terragrunt unit's plan through `planTerragruntWave({ onCommand })`, and resolves a live root's record store (`liveRecordStore`, `writtenRecordStore`, `rootBackendAttrs` in `live-roots`) (#4954). */
export const TERRAFORM_ENGINE_RUNNER_FLOOR = "0.124.89";

/** The first chant with `@intentius/chant/forge-flags` (`forgeTargetWith`, `forgeTargetFromFlags`, `apiBaseOf`), `@intentius/chant/chant-install` (`bundledChant`, `chantArgv`, `installChantResolveFallback`) and `noteLimit` and `fitNote` in `@intentius/chant/plan-summary` (#4800). */
export const PRODUCT_HELPERS_FLOOR = "0.124.86";

/** The first chant with `@intentius/chant/ci-image`: `productImageStages`, `productImageDockerfile` and `derivedImageDockerfile` for a product's CI image, and `ciToolFetchScript`, `ciToolInstallLine` and `installCiTool`, the digest-checked engine installs, with the terraform lexicon's `choudoufuInstallLine` checked the same way (#4784). */
export const CI_IMAGE_FLOOR = "0.124.86";

/** The first chant with `@intentius/chant/drift-issue`, whose `keepDriftIssue` keeps one drift issue per environment from a product's words and the drift records (#4790). */
export const DRIFT_ISSUE_FLOOR = "0.124.86";

/** The first chant whose `chant build` with no path builds the config's `sourceDir`, whose root build leaves a top-level `scripts/` out, and whose `@intentius/chant/config` exports `resolveSourceDir`, the one source-dir rule every command shares (#4794). */
export const SOURCE_DIR_RULE_FLOOR = "0.124.86";
/** The first chant whose pulumi lexicon runs `gatedStackExport`, `gatedStackCancel` and `gatedStackMove` on core's `exportStateVersion`, `releaseStateLock` and `runStateMigration`: export by version, the live-run check before a cancel (`liveRuns`, `forge`), and the check that nothing moved between a move's plan and its write (#4808). */
export const PULUMI_STACK_OPS_ON_CORE_FLOOR = "0.124.86";
/** The first chant whose terraform lexicon's state stores read versions (`version`, `hasVersion`, `readVersion`, `isAt`, `listVersions`), with `readStateVersion` and `listStateVersions`, and lock and write a GitLab-managed http backend's state (#4793). */
export const TERRAFORM_STATE_VERSION_READS_FLOOR = "0.124.86";

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

/** The first chant whose Op waves pipeline takes `waveJobs` and `recordPlans`, a product's login, report, artifact and plans-job inputs, so it edits nothing chant wrote (#4791). */
export const OP_WAVES_JOB_INPUTS_FLOOR = "0.124.86";

/** The first chant with `@intentius/chant/floor-table` (`FLOOR_TABLE`, `floorVersion`, `chantMeets`), every floor as one table, and `chant dev dead-guards` with `@intentius/chant/dead-guards` (`findDeadGuards`), which fails on a feature-detect the product's chant pin meets (#4792). */
export const FLOOR_TABLE_FLOOR = "0.124.86";

/** The first chant with `@intentius/chant/ci-login`: `githubCloudLogin`, `gitlabCloudLogin` and `forgejoCloudLogin` render a job's AWS, GCP and Azure login from the OIDC token file, per target too (#4788). */
export const CLOUD_LOGIN_FLOOR = "0.124.86";

/** The first chant whose generated pipelines sign evidence for each named check they run, with `chant ci evidence`, `ci check` signing each hook, and an Op waves spec's `evidence.requires` (#4870). */
export const CHECK_EVIDENCE_FLOOR = "0.124.86";

/** The first chant that accepts local evidence (#4868): `local` in `.chant/trust.json`, `chant ci evidence sign --local`, and `chant ci check` skipping a hook whose current local evidence the policy at base accepts. */
export const LOCAL_EVIDENCE_FLOOR = "0.124.86";

/** The first chant that signs runner statements keyless from the CI job's OIDC identity and verifies them against `keyless` in `.chant/trust.json`, with `evidence.identity: "oidc"` in the generators (#4869). */
export const KEYLESS_EVIDENCE_FLOOR = "0.124.87";

/** The first chant whose waves generators run each wave's policy as a step of its own (`chant run wave --policy-only`; on GitLab a `<wave job>-policy` job) and sign its checks in a `<wave job>-evidence` job with `chant ci evidence sign --from-job`, from the forge's record of the wave job's steps, so a wave that trades cloud credentials signs keyless with `evidence.identity: "oidc"` instead of being refused (#4926). */
export const WAVE_EVIDENCE_JOB_FLOOR = "0.124.88";

/** The first chant whose cloud login leaves the region to the job unless the spec names one, takes `sameStep` to export into the step that runs it, accepts an AWS spec with no role (the token file alone), and whose trade sets `CHANT_CLOUD_TRADED` so a login's targets file is told from a trade's (#4930). */
export const CLOUD_LOGIN_SAME_STEP_FLOOR = "0.124.88";

/** The first chant whose `chant release workflow` sets up QEMU in the cut and publish jobs for the platforms `release.images` builds that the runner can't (`docker/setup-qemu-action` at its pin on GitHub and Forgejo, a `tonistiigi/binfmt` run line on GitLab), and whose `release.images` command entries take `platforms` (#4876). */
export const RELEASE_WORKFLOW_QEMU_FLOOR = "0.124.88";

/** The first chant whose npm publish target refuses at plan time a package that would carry an image archive the release records (`publish-npm-carries-image`), naming the file and the `files` entry that leaves it out (#4934). */
export const NPM_CARRIES_IMAGE_FLOOR = "0.124.88";
/** The first chant with `driftRunFingerprint` in `@intentius/chant/drift-issue` and `lexiconDriftRecords` in `@intentius/chant/drift-record`, whose `chant lifecycle diff --live --json` writes a lexicon's `absent`, and whose sql lexicon reports a declared object the server lacks as `missing` instead of `pending` (#4896). */
export const LIVE_DRIFT_RECORDS_FLOOR = "0.124.88";

/** The first chant whose `chant sql types --path` prints where `sql-types.d.ts` is by the source-dir rule, the path `sqlTypesPath` answers (#4897). */
export const SQL_TYPES_PATH_FLOOR = "0.124.88";
/** The first chant whose forge target carries its web `origin` (`forgeTargetWith`) and whose `@intentius/chant/forge-flags` has `jobForgeTarget`, a job's target or undefined where the job cannot reach the forge, so a product keeps no target type of its own (#4888). */
export const FORGE_TARGET_ORIGIN_FLOOR = "0.124.88";

/** The first chant with `actorFromEnv` (`@intentius/chant/actor`), `forgeTargetLiveRuns` and `forgeLiveRunsOf` in `@intentius/chant/state-unlock`, and a pulumi lexicon whose stack ops take the product's `approveCommand`, with `pulumiStackLockToCancel` and `pulumiMoveDestStack`, a move naming its own `--dest` from both sides' `project` (#4911). */
export const STACK_OPS_PRODUCT_HELPERS_FLOOR = "0.124.88";

/** The first chant with `@intentius/chant/forge-remote` (`forgeOfRemote`, `forgeOfCheckout`, `forgeKindOfHost`), the forge and repository a checkout's origin remote names, and a pulumi `gatedStackCancel` that reads the forge's runs from it on a laptop (#4920). */
export const FORGE_REMOTE_FLOOR = "0.124.88";
/** The first chant with `chant dev generated-check` (`chantGenerated` in a product's root package.json, `@intentius/chant/generated-check`) and `chant dev local-image` (`localChantImage` in `@intentius/chant/local-chant`): a drift check of a product's committed generated files, and an image build with the product's chant, local or pinned, without the product's own scripts (#4909). */
export const GENERATED_CHECK_FLOOR = "0.124.88";

/** The first chant whose `chant dev local` keeps the product's peer dependencies installed and packs the checkout at its `NEXT_RELEASE`, and whose root build of a project with no `sourceDir` leaves its top-level `migrations/` out, with the sql lexicon opening no `.sql` file under a `migrations` directory (#4921). */
export const LOCAL_CHANT_NEXT_RELEASE_FLOOR = "0.124.88";

/** The first chant whose `chantExternalPlugin` keeps external only the chant packages it is given, by default the ones in the package's `dependencies`, so a product that bundles its lexicons uses it as is (#4922). */
export const CHANT_EXTERNAL_PACKAGES_FLOOR = "0.124.88";

/** The first chant whose `ciToolInstallLine` takes `sudo` and `binDir` and a root under a shell variable, for a job that is not root, whose `CI_TOOL_SHA256` records terraform 1.14.9, terragrunt 1.2.0 and the AWS CLI 2.37.9, and whose Pulumi lexicon's `ciFetchScript` and `PINNED_SHA256` are ci-image's (#4908). */
export const CI_IMAGE_NON_ROOT_FLOOR = "0.124.88";

/** The first chant whose `productImageStages` stages type as the docker lexicon's `DockerfileStage[]` under `exactOptionalPropertyTypes`, so `new Dockerfile({ stages: productImageStages(spec) })` compiles (#4932). */
export const CI_IMAGE_DOCKER_STAGES_FLOOR = "0.124.88";

/** The first chant whose setup steps (`OpSetupStep`: an Op waves spec's wave and job group `setup`, a scheduled Op's `setup`, `release.workflow.setup`) take a `name`, rendered as the step's name on GitHub and Forgejo (#4932). */
export const OP_SETUP_STEP_NAME_FLOOR = "0.124.88";

/** The first chant whose cloud login takes `restart` (log in, then start the step's script again without the token request variables, and empty the token files when the step exits), sets `CHANT_CLOUD_TOKEN_FILES` for `LOGIN_CLEAR_TOKENS`, takes a full token URL as GCP's `stsEndpoint`, and whose GitLab trade evaluates its exports without writing a file (#4912). */
export const CLOUD_LOGIN_RESTART_FLOOR = "0.124.88";

/** The first chant whose `chant build --pr-loop` takes `evidence` (`--evidence-runner-key-secret`, `--evidence-identity oidc`, `--evidence-audience`) and signs the plan job's `plan` and `policy` checks in its note job on GitHub, GitLab and Forgejo (#4935). */
export const PR_LOOP_EVIDENCE_FLOOR = "0.124.88";

/** The first chant whose pull request pipelines take `checkJob` (`--check-job`): a check job that runs `chant ci check` on the pull request's commit with no token or runner identity, and with `evidence` a `check-evidence` job that signs each passed hook from its report with `chant ci evidence sign --from-report .chant/check` (#4935). */
export const CHECK_JOB_FLOOR = "0.124.88";

/** The first chant whose GitLab pipelines sign evidence in the target branch's plan notes pipeline, in jobs that name the `chant-evidence` environment, with `chant ci evidence sign --open`, and whose `pr-post --open --evidence-dir` ends each merge request's note with the checks line; no job of a merge request pipeline holds the runner key (#4914). */
export const GITLAB_OPEN_EVIDENCE_FLOOR = "0.124.88";

/** The first chant whose `chant ci check` takes `--summary <file>` and whose `checkReportSummary` renders the check report's markdown section, so a product's check step runs chant's check stage and keeps the section in its own report (#4914). */
export const CHECK_SUMMARY_FLOOR = "0.124.88";

/** The first chant whose pull request pipelines take `refGateStatus` (`--ref-gate-status`): a `ref-gate` job that runs `chant workspace ref-gate status` for the pull request's commit, and on GitLab `ref-gate status --open` for every open merge request (#4935). */
export const REF_GATE_STATUS_JOB_FLOOR = "0.124.88";

/** The first chant with `@intentius/chant/ref-gate-rules` (`refGateRulesAt`), `require` in `checkPrRequires`, `refGateStatus` in `pipelineContract` and `ci forge-check --ref-gate-status`, `@intentius/chant/ref-gate-init` (`refGateInitPlan`, `writeRefGateInit`), and a pre-receive refusal that prints the command recording the override request (#4913). */
export const REF_GATE_PIECES_FLOOR = "0.124.88";

/** The first chant whose `chant release cut --yes` pushes `chant/lifecycle` again when the remote refuses it, and exits non-zero untagged (`release-record-not-pushed`) when the release record never lands, so the release workflow does not push the tag (#4965). */
export const RELEASE_CUT_RECORD_FLOOR = "0.124.89";

/** The first chant whose release cut refuses, before it records or tags, a release whose npm publish target would carry an image archive (`publish-npm-carries-image`), and whose GitLab release workflow runs the binfmt image by digest from `IMAGE_PINS` (#4941). */
export const RELEASE_CUT_CARRIES_IMAGE_FLOOR = "0.124.89";
/** The first chant whose `ciToolFetchScript` and `ciToolInstallLine` take `download: "node"`, a fetch and unzip with node for an image with no curl or unzip, whose `CI_TOOL_SHA256` records just 1.36.0 and act 0.2.89 and checks them against their releases' checksums files, and whose overdue check deepens a shallow checkout before it dates a pipeline file (#4952). */
export const CI_TOOL_NODE_DOWNLOAD_FLOOR = "0.124.89";

/** The first chant whose `chant build -o <dir>/` writes a build's additional files (a docker project's Dockerfiles) into the directory with no primary file, whose `chantGenerated` renders take a `module` and its `export` (a `{ path: text }` object or a function returning one) and `chant dev render <module> <export>` writes them in place, and whose `chant ci workflow` and `chant release workflow` write into `chant dev generated-check`'s render tree with no `--output` (#4950). */
export const RENDER_KINDS_FLOOR = "0.124.89";

/** The first chant whose sql lexicon's `chant lifecycle diff --live` addresses a table's columns by name (`columns[#country].default.expr`), compares a ClickHouse table's column order as `columnOrder`, and reports a column the server has and the declaration does not as pending, and whose `lexiconDriftRecords` counts a deep read's pending changes (that column, a ClickHouse or Postgres privilege granted by hand) as drift (#4944). */
export const SQL_LIVE_COLUMNS_FLOOR = "0.124.89";

/** The first chant whose `driftNotifyFields` takes `stacks`, each member's drift records, and from them names the drifted members and computes the run's fingerprint (#4944). */
export const DRIFT_NOTIFY_STACKS_FLOOR = "0.124.89";

/** The first chant whose workspace member's pull request pipeline takes `evidence`, `checkJob` and `refGateStatus` (`chant build --pr-loop` in a member), signing the member's plan job as `plan:<member>` and `policy:<member>` (`ci evidence sign --member`, `memberEvidenceCheck`) and running the check job in the member's directory (#4964). */
export const MEMBER_SIGNED_CHECKS_FLOOR = "0.124.89";

/** The first chant whose `checkJob` takes `{ services, env, before, dir, args }` (`PrCheckJobOptions`: service containers, the check step's variables and lines, the report directory, the arguments after `--base`) and whose github, forgejo and gitlab lexicons render the check, check evidence and ref gate jobs for a product's own workflow (`productCheckJobs`, `forgejoProductCheckJobs`, `gitlabProductCheckJobs`) (#4964). */
export const PRODUCT_CHECK_JOBS_FLOOR = "0.124.89";

/** The first chant whose `checkJob` takes `artifacts: { paths, reports }` (`PrCheckArtifacts`), which GitLab's check job keeps beside its report as `artifacts:paths` and `artifacts:reports`, such as a lint hook's `codequality` report (#4988). */
export const CHECK_JOB_ARTIFACTS_FLOOR = "0.124.90";

/** The first chant whose GitLab Op waves pipeline with a runner key hands it to no wave job: each deciding wave's `<wave job>-evidence` job names the `chant-evidence` environment and signs `plan:<wave>` from the wave job (#4964). */
export const GITLAB_WAVE_KEY_SCOPE_FLOOR = "0.124.89";

/** The first chant with `actorOf` and `actorOrder` in `@intentius/chant/actor`: the actor fallback with `GITHUB_TRIGGERING_ACTOR` ahead of the forge's actor and git's `user.name` before the login, each place switched on or off by the caller (#4966). */
export const ACTOR_ORDER_FLOOR = "0.124.89";

/** The first chant whose `actorOf({ env, repo })` runs `git config` in `repo` with the `env` it is given rather than the process's, so a job's `GIT_CONFIG_GLOBAL` or `HOME` picks the `user.name` it reads (#5005). */
export const ACTOR_GIT_ENV_FLOOR = NEXT_RELEASE;

/** The first chant with `@intentius/chant/ci-base` (`ciBaseRef`), the base a CI job measures a change from (the pull request's target branch, else the default branch for a push to another branch), and whose `chant ci check` defaults `--base` to it (#4966). */
export const CI_BASE_REF_FLOOR = "0.124.89";

/** The first chant with `@intentius/chant/planned-files` (`planFile`, `planRemoval`, `writePlannedFiles`, `staleGeneratedFiles`): an init's planned files with their modes, written or removed in one call, and the generated files a product no longer renders, found by their header (#4966). */
export const PLANNED_FILES_FLOOR = "0.124.89";

/** The first chant whose `planFile` in `@intentius/chant/planned-files` takes bytes (`Uint8Array` or `Buffer`) as well as text: `writePlannedFiles` writes them unchanged and the plan compares them with the file byte for byte (#5006). */
export const PLANNED_BYTES_FLOOR = NEXT_RELEASE;

/** The first chant whose `pipelineContract` takes `jobs`, the jobs a product builds from its own config, beside or in place of `pipelines`, so a product's forge check gets the required statuses and `refGateStatus` from chant (#4966). */
export const FORGE_CHECK_OWN_JOBS_FLOOR = "0.124.89";

/** The first chant whose `chant components pr-apply --before-merge` waits for the ref gate's status: the status the policy at base sets for the target branch is passed as `require` to the `checks` require (#4966). */
export const BEFORE_MERGE_REF_GATE_FLOOR = "0.124.89";

/** The first chant whose product plan with `targets` and `evidence` signs each target's plan job as `plan:<target>` and `policy:<target>` (`ci evidence sign --member <target>`, `targetEvidenceCheck`, `productPlanEvidenceChecks`), and whose `refGateInitPlan` takes `targets` and names those checks in the `refs` rule (#4978). */
export const TARGET_SIGNED_CHECKS_FLOOR = "0.124.89";

/** The first chant whose Op waves generators take `renderSpec` (the wave jobs run `chant run wave --render-spec`, and `CHANT_WAVES_SPEC_COMMAND` names the product command that prints the spec at the commit in `CHANT_WAVES_SPEC_AT`), so a product whose spec is built from its config at base renders its wave jobs, policy step, evidence job and cloud trade through chant (#4982). */
export const RUNTIME_WAVES_SPEC_FLOOR = "0.124.89";

/** The first chant whose `chant run resume` (`resumeGateRun`) on GitLab retries a wave job's `<wave job>-evidence` with the wave job when the evidence job already ran, and whose `ci evidence sign --from-job` waits for a job it reads to finish, so a resumed wave's evidence job signs from the new try (#4978). */
export const GITLAB_WAVE_EVIDENCE_RETRY_FLOOR = "0.124.89";

/** The first chant whose terraform lexicon's engine runs carry what a product's own command tracing read: `runBinary` and the engine runner's `exec` and `execSync` answer stderr apart (`Ran.stderr`) and a spawn failure's message (`Ran.error`), a hook's `after` gets a binary that could not be started as a null code with `error`, `commandTrace` ends that span with the message, and `composeCommandHooks` runs a product's own hook and `commandTrace` as one `onCommand` (#5007). */
export const TERRAFORM_COMMAND_TRACE_FLOOR = NEXT_RELEASE;
