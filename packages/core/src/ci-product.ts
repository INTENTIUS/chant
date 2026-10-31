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
export { driftNotifyFields, productNotifySource, productNotifyWords, productSendOptions, type DriftNotifyInput } from "./notify-product";

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
 */
export { PRODUCT_MCP_PROPOSE_FLOOR, PRODUCT_TOOL_PROPOSE_WORDS } from "./cli/mcp/product-tools";
export type { McpToolContribution } from "./mcp/types";
export {
  activeOtlp,
  configureOtlp,
  OTLP_EXPORTER_FLOOR,
  RunEventTrace,
  type CapabilityTraceFacts,
  type CapabilityTraceSpan,
  type OtlpExporter,
} from "./otlp";
