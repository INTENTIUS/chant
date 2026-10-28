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

import { NEXT_RELEASE } from "./release-floors";
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
export const CI_PRODUCT_FLOOR = NEXT_RELEASE;

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
} from "./ci-product-words";
export { driftNotifyFields, productNotifySource, productNotifyWords, productSendOptions, type DriftNotifyInput } from "./notify-product";

/** The first chant with `chant notify relay` and the notify relay buttons (#4611). */
export const NOTIFY_RELAY_FLOOR = NEXT_RELEASE;

/**
 * The first chant whose product pipeline has the comment preview
 * (`previewComment`, `build --pr-loop --preview-comment`) and whose
 * `components pr-plan` takes `--target` (#4620). A product feature-detects
 * `prCommentPreviewJob` and this constant together.
 */
export const PR_PREVIEW_FLOOR = NEXT_RELEASE;
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
export { prApplyComment, prCommentLockJobs, prCommentPreviewJob, prLoopSetup, engineSetupLines, withProductBin, type PrCommentLockJob, type PrCommentPreviewJob } from "./components/pr-pipeline";
export { CI_SERVICES_FLOOR, engineServices, githubServices, gitlabServices, serviceWaitLine, servicesJobEnv, type CiService } from "./components/ci-services";
export { renderPrNote, prStatusContext, prApproveCommand, prApproveCommands, prApproveTargets, prMergeSentence, type PrMemberDetail } from "./pr-loop";
export { upsertPlanNote } from "./pr-post";

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
export {
  activeOtlp,
  configureOtlp,
  OTLP_EXPORTER_FLOOR,
  RunEventTrace,
  type CapabilityTraceFacts,
  type CapabilityTraceSpan,
  type OtlpExporter,
} from "./otlp";
