/**
 * `@intentius/chant/ci-product` (#4550): what a CI product built on chant's
 * pull request pipeline imports. terragucci and plywood pass their words
 * here and get the same jobs, the same note and the same statuses, in their
 * own words.
 *
 * A product feature-detects this entry until the chant release that carries
 * {@link CI_PRODUCT_FLOOR} is its floor: `productPipelineJobs`, `approveLine`
 * and `assertProductWords` present means the rest is too.
 */

import type { CiProductWords, CiProductWordsInput } from "./ci-product-words";
import type { ProductMcpHook } from "./cli/mcp/product-tools";
import type { ProductWaveHook } from "./op/op-waves-after-plan";
import { OTLP_EXPORTER_FLOOR } from "./otlp";
import { NEXT_RELEASE } from "./release-floors";

/**
 * The first chant with the product pipeline (#4550): the words, the
 * `pull-request` op-wave approval source, `runCommandInProcess(argv, {
 * words })`, the lexicons' `ciSetup`, and the member detail sections of the
 * note (#4573).
 */
export const CI_PRODUCT_FLOOR = "0.124.55";

export {
  activeProductWords,
  approveLine,
  assertProductWords,
  CHANT_APPROVE_TEMPLATE,
  CHANT_NOTIFY_WAVE_TEMPLATE,
  CHANT_OVERRIDE_TEMPLATE,
  CHANT_WORDS,
  CI_PRODUCT_APPLY_MODES,
  CI_PRODUCT_COMMANDS,
  CI_PRODUCT_STAGES,
  CiProductWordsError,
  commandWord,
  commentLine,
  isChantWords,
  notifyWaveLabel,
  overrideLine,
  parseProductComment,
  productActionFromEnv,
  PRODUCT_ACTION_ENV,
  PRODUCT_ACTION_EVENT_FLAG,
  productContext,
  productStatusContext,
  productWaveGate,
  productWordsProblems,
  resolveProductWords,
  setActiveProductWords,
  withProductWords,
  type ApproveLineInput,
  type CiProductAlias,
  type CiProductApplyMode,
  type CiProductApproval,
  type CiProductCommand,
  type CiProductNotifyWords,
  type CiProductNotifyWordsInput,
  type CiProductStage,
  type CiProductWords,
  type CiProductWordsInput,
  type OverrideLineInput,
  type ParsedProductComment,
  type ProductActionRequest,
} from "./ci-product-words";
export { driftNotifyFields, NOTIFY_MESSAGE_WORDS_FLOOR, productNotifySource, productNotifyWords, productSendOptions, type DriftNotifyInput } from "./notify-product";

/** The first chant with `chant notify relay` and the notify relay buttons (#4611). */
export const NOTIFY_RELAY_FLOOR = "0.124.55";

/**
 * The first chant whose product pipeline has the comment preview
 * (`previewComment`, `build --pr-loop --preview-comment`) and whose
 * `components pr-plan` takes `--target` (#4620). A product feature-detects
 * `prCommentPreviewJob` and this constant together.
 */
export const PR_PREVIEW_FLOOR = "0.124.55";
export {
  decideRelayClick,
  handleRelayRequest,
  NOTIFY_RELAY_POINTS_FLOOR,
  relayPrincipalFor,
  RELAY_ENV,
  slackRelayClick,
  slackSignature,
  startRelayServer,
  teamsRelayClick,
  teamsSignature,
  verifySlackRequest,
  verifyTeamsRequest,
  type RelayAnswer,
  type RelayClick,
  type RelayDeps,
  type RelayPending,
  type RelayRequest,
  type RelayResponse,
  type RelaySettings,
} from "./notify-relay";
export {
  componentWaveOutputsFile,
  componentWaveSteps,
  componentWavesSpec,
  productAgentSpec,
  productCommand,
  productDriftAgent,
  productPipelineJobs,
  productWavesSpec,
  productWavesSpecFile,
  PRODUCT_WAVES_SPEC_DIR,
  type ComponentWaveStepOptions,
  type ComponentWaveSteps,
  type ComponentWavesSpecOptions,
  type ProductAgentOptions,
  type ProductPipelineJobs,
  type ProductPipelineOptions,
} from "./components/product-pipeline";
export { prActionJob, PR_ACTION_JOB, prApplyComment, prCommentLockJobs, prCommentPreviewJob, prLoopSetup, engineSetupLines, withProductBin, type PrActionJob, type PrActionJobOptions, type PrCommentLockJob, type PrCommentPreviewJob } from "./components/pr-pipeline";

/**
 * The product plan (#4799): `productPipelineJobs(forge, env, { words,
 * productPlan })` runs the product's plan verb in place of `pr-plan`, one
 * plan job and one plan-note job per target, each with only its target's
 * variables and secrets and an optional write probe, and `pr-post` posts the
 * plan note hand-off the verb wrote (`planNoteHandoff`, `PR_PLAN_NOTE_FILE`
 * in `@intentius/chant/pr-plan-note`). The forge lexicons render the
 * workflow in process with no component graph: `generateProductPlanPipeline`
 * (github), `generateForgejoProductPlanPipeline` (forgejo) and
 * `generateGitlabProductPlanPipeline` (gitlab), each under
 * `components/product-plan-pipeline`. A product feature-detects on this
 * floor.
 */
export const PRODUCT_PLAN_FLOOR = "0.124.86";
export { productPlanJobs, PR_PLAN_NOTE_WORDS_ENV, type ProductPlanJob, type ProductPlanOptions, type ProductPlanTarget } from "./components/product-plan";
export { planNoteHandoff, PR_PLAN_NOTE_FILE, type PrPlanNoteHandoff } from "./pr-plan-note";

/**
 * The first chant whose product plan carries the plan-job steps beside the plan verb and the note job's own lines (#4899, #4931): `productPlan.login` and a target's `login` (ci-login) with the job's OIDC token, `idTokens`, `pending`, `controlRead`, `setup` steps, job-level `env`, `report`, `concurrency`, the comment re-plan `replan`, and `noteSteps`; a hand-off's `marker` kept under the note words' `productMarker`; and the note job's notices and overdue Ops under a hand-off's counts.
 */
export const PRODUCT_PLAN_STEPS_FLOOR = NEXT_RELEASE;
export { PLAN_ARGUMENT_ENV, PLAN_NOTE_NOTICES_ENV, type ProductPlanReplanJob, type ProductPlanSetupStep } from "./components/product-plan";

/**
 * Day-2 actions in the product pipeline (#4654): the `action` comment
 * command counted as answered by the product's own workflow
 * (`productPipelineJobs(forge, env, { words, actions: true })`), or the
 * pipeline's own action job (`actionJob`, `build --pr-loop --action-job`),
 * which answers the comment and a dispatch with a member and an action
 * input, and runs the product's action verb with `--from-event`. The verb
 * reads what was asked with `productActionFromEnv`. A product
 * feature-detects on this floor.
 */
export const PRODUCT_ACTIONS_FLOOR = "0.124.58";
export { CI_SERVICES_FLOOR, engineServices, githubServices, gitlabServices, serviceWaitLine, servicesJobEnv, type CiService } from "./components/ci-services";
export { renderPrNote, prStatusContext, prApproveCommand, prApproveCommands, prApproveTargets, prMergeSentence, type PrMemberDetail } from "./pr-loop";
export { upsertPlanNote } from "./pr-post";

/**
 * The approval status before merge (#4630): under a `pr-review` wave, the
 * op waves generators add a job that posts `<product>/approval` on each
 * open pull request's head. A product feature-detects on
 * `APPROVAL_STATUS_FLOOR`.
 */
export const APPROVAL_STATUS_FLOOR = "0.124.56";
/**
 * The approval status for `pull-request` waves too (#4630, 2026-10-28
 * ruling): the generators add the record-plans and approval-status jobs for
 * a spec whose waves take the pull request's own approval, and the status
 * reads that approval's coverage of each wave's change set. A product such
 * as plywood, whose waves all take `approval: pull-request`, feature-detects
 * on this floor.
 */
export const APPROVAL_STATUS_PULL_REQUEST_FLOOR = "0.124.56";
export { opWavesPostsApprovalStatus } from "./op/op-waves";
export { approvalStatusOf, headWaveHolds, postApprovalStatus, postOpenApprovalStatuses, type ApprovalStatus, type ApprovalStatusInput } from "./op/approval-status";

/**
 * Responses to pipeline events (#4629): a refused wave's diff, a failed
 * apply's triage and the pull request description check, in the product's
 * words. `productPipelineJobs(forge, env, { words, respond, decide })` turns
 * them on and off; a product feature-detects on `CI_RESPOND_FLOOR`.
 */
export const CI_RESPOND_FLOOR = "0.124.56";

/**
 * `chant build --pr-loop` carries `--merge auto --merge-token-env <VAR>
 * [--merge-method <m>]` (#4636), `--respond <list>`, `--decide-backend` and
 * `--decide-model` (#4629) into the generated pull request jobs. Before it
 * the build parsed them and wrote jobs without them; a product that writes
 * its pull request jobs with the build feature-detects on this floor.
 */
export const PR_LOOP_BUILD_FLAGS_FLOOR = "0.124.56";

/**
 * A repository's own jobs in the generated pipeline file (#4769):
 * `mergeOwnJobs` adds a map of jobs (or `readOwnJobsFile`'s) after chant's
 * and refuses a name chant's file has or a GitLab keyword; `keepOwnJobs`
 * carries over the old file's jobs that run neither `chant` nor the
 * product's bin. `chant build --components --generate <forge> --own-jobs
 * <file>` and `--keep-own-jobs` do the same on the build line. A product
 * feature-detects on `OWN_JOBS_FLOOR`.
 */
export {
  GITLAB_RESERVED_JOB_NAMES,
  GITLAB_TOP_KEYWORDS,
  isGeneratedJob,
  jobBlocks,
  jobNames,
  keepOwnJobs,
  mergeOwnJobs,
  OWN_JOB_NAME,
  OWN_JOBS_FLOOR,
  OWN_JOBS_FORGES,
  OWN_JOBS_LINE,
  OwnJobsError,
  ownJobsOf,
  ownJobsProblems,
  ownJobsYAML,
  readOwnJobsFile,
  type KeepOwnJobsOptions,
  type MergeOwnJobsOptions,
  type OwnJobsForge,
} from "./ci-own-jobs";

/**
 * The Forgejo generators write a workflow-level run group a product asks for
 * (#4771): `runGroup: "pull-request"` on the components pipeline (`chant
 * build --components --generate forgejo --run-group pull-request`) and
 * `runGroup: "commit"` on an op waves spec (its `options`, or `chant run
 * --generate forgejo --spec <file> --run-group commit`). A workflow with a
 * group of its own keeps it, and GitHub and GitLab files are unchanged. A
 * product feature-detects on this floor.
 */
export const FORGEJO_RUN_GROUP_FLOOR = "0.124.77";
export { RUN_GROUP_KEYS, type RunGroupKey } from "./lexicon";

/**
 * `chant build --pr-loop` takes the control repo (#4772): `--control <repo>`
 * and `--control-setting <key>=<value>` (op, member, readTokenSecret, and
 * the rest of the control settings) are the pull request loop's `control`,
 * so the note job the build writes reads the control repo's records itself,
 * the step `productPipelineJobs(...).post.control` returns. A product that
 * writes its pipeline with the build feature-detects on this floor.
 */
export const PR_LOOP_CONTROL_FLOOR = "0.124.77";
export {
  CI_RESPOND_DEFAULTS,
  CI_RESPOND_ENV,
  CI_RESPONSES,
  parseRespondList,
  renderRefusedDiff,
  renderTriage,
  respondList,
  resolveResponses,
  type CiRespondEvent,
  type CiResponses,
  type DescriptionFinding,
  type FailedApply,
  type RefusedDiff,
} from "./ci-respond";
export { respondDescription, respondOpWave, respondPrApply, triageOfOpWave, triageOfPrReport, refusedOfOpWave, refusedOfPrReport } from "./ci-respond-run";

/**
 * Run one chant command line in this process with the product's words
 * (ruling C): what a product's bin calls for every command its verbs map
 * onto, and for the `chant ...` lines the generated jobs run through it. The
 * CLI loads on the first call, so importing this entry stays light.
 */
export async function runChantInProcess(argv: string[], words: CiProductWordsInput | CiProductWords, options: { mcp?: ProductMcpHook; wave?: ProductWaveHook } = {}): Promise<number> {
  const { runCommandInProcess } = await import("./cli/main");
  return runCommandInProcess(argv, { words, ...(options.mcp ? { mcp: options.mcp } : {}), ...(options.wave ? { wave: options.wave } : {}) });
}

/**
 * The agent job (#4616): `productPipelineJobs(forge, env, { words, agent })`
 * returns the agent's Op spec, and `productDriftAgent` the `agent` of a
 * scheduled drift Op; `chant run --generate` writes both. Feature-detect on
 * `CI_AGENT_FLOOR`.
 */
export { CI_AGENT_FLOOR, agentForbiddenPaths, type AgentSettings, type OpAgentSpec } from "./ci-agent";

/**
 * The agent guard (#4770): a Claude Code PreToolUse hook on Bash and a
 * wrapper per engine binary that refuse an agent's apply, approve or
 * override. A product passes its words (its name, the refusal) and rules
 * (engines, their refused subcommands and flags, its own refused commands)
 * to `installAgentGuard`, and `agentGuard` checks a command line in process
 * with the same rule. Feature-detect on `AGENT_GUARD_FLOOR`.
 */
export {
  AGENT_GUARD_FLOOR,
  agentGuard,
  agentGuardScript,
  agentGuardWrapper,
  CLAUDE_SETTINGS_LOCAL,
  CLAUDE_SETTINGS_SHARED,
  installAgentGuard,
  withAgentGuardHook,
  type AgentGuard,
  type AgentGuardEngine,
  type AgentGuardInstall,
  type AgentGuardInstallOptions,
  type AgentGuardRules,
  type AgentGuardSpec,
  type AgentGuardVerdict,
  type AgentGuardWords,
} from "./agent-guard";

/**
 * After-plan hooks in a wave job's process (#4614): `runChantInProcess(["run",
 * "wave", ...], words, { wave: { afterPlan, capabilities } })`, or
 * `runOpWave({ afterPlan })` from `@intentius/chant/op`. Feature-detect on
 * `OP_WAVE_AFTER_PLAN_FLOOR`.
 */
export { OP_WAVE_AFTER_PLAN_FLOOR } from "./op/runtime";
export type { OpWaveAfterPlanHook, OpWaveAfterPlanResult, OpWaveAfterPlanRun, ProductWaveHook } from "./op/op-waves-after-plan";

/**
 * The standing pending gates waiting on a plan digest, with the pull request
 * a `pr-<n>` gate belongs to (#4607): what a product's approve verb reads so
 * a person types only the digest. Feature-detect on `pendingGatesByPlan`;
 * the ledger's git code loads on its first call. `parseRequiresList` checks
 * a product's `apply.requires` before it becomes `pr-apply --requires`.
 */
export { pendingGatesByPlan, pullRequestOfOp, standingPendingByPlan, type PendingGateByPlan, type PendingGatesByPlanOptions } from "./lifecycle/gate-pending-by-plan";
export { parseRequiresList, PR_APPLY_REQUIRES, type PrApplyRequire } from "./pr-requires";

/**
 * Telemetry and MCP (#4555). A product's bin configures the exporter once
 * with its prefix (`configureOtlp({ prefix })`, or leaves it to its words),
 * and passes its MCP tools as `runChantInProcess(["serve", "mcp"], words, {
 * mcp: hook })`. Feature-detect on `configureOtlp` and
 * `PRODUCT_MCP_HOOK_FLOOR`: present means both are.
 */
export const PRODUCT_MCP_HOOK_FLOOR = OTLP_EXPORTER_FLOOR;
export type { ProductMcpContext, ProductMcpHook } from "./cli/mcp/product-tools";

/**
 * The `--propose` tier (chant#4655): `runChantInProcess(["serve", "mcp",
 * "--read-only", "--propose"], words, { mcp: hook })`, or `propose: true` on
 * the hook, serves the read-only server's tools plus the product tools that
 * declare `forgeWrite: true` on their `McpToolContribution`, tools that open
 * a pull request or a comment and do nothing else. A product's own tool and
 * hook types widen from `readOnly: true` to `readOnly: true` or `forgeWrite:
 * true` for these, and its hook gains `propose?: boolean`. Feature-detect on
 * `PRODUCT_MCP_PROPOSE_FLOOR`: on an older chant the read-only server drops a
 * `forgeWrite` tool, and `--propose` is not a flag it parses.
 *
 * `tools/list` gives each tool's MCP annotations from `MCP_TOOL_ANNOTATIONS_FLOOR`
 * on (chant#4823): `readOnly: true` and `forgeWrite: true` set `readOnlyHint`
 * and `destructiveHint`, and a contribution's `annotations` add the rest.
 */
export { MCP_TOOL_ANNOTATIONS_FLOOR, PRODUCT_MCP_PROPOSE_FLOOR, PRODUCT_TOOL_PROPOSE_WORDS } from "./cli/mcp/product-tools";
export type { McpToolContribution, ToolAnnotations } from "./mcp/types";
export {
  activeOtlp,
  configureOtlp,
  OTLP_EXPORTER_FLOOR,
  RunEventTrace,
  type CapabilityTraceFacts,
  type CapabilityTraceSpan,
  type OtlpExporter,
} from "./otlp";
