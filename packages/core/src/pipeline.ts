/**
 * `@intentius/chant/pipeline` (#5324): one TypeScript declaration of a
 * member's delivery pipeline, its stages in promotion order and the waves
 * inside each, folded to a spec before anything runs.
 *
 * A member's `.chant/pipeline.ts` holds the declaration:
 *
 * ```ts
 * import { pipeline } from "@intentius/chant/pipeline";
 *
 * export default pipeline({
 *   name: "shop",
 *   defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
 *   stages: [
 *     { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
 *     { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { quorum: [{ count: 2 }] } },
 *   ],
 * });
 * ```
 *
 * `chant build` folds it (`./pipeline/fold.ts`) and writes the spec to
 * `.chant/pipeline.json`; a file outside the TypeScript-as-data subset is
 * refused with the evaluability rule's id. See the pipeline guide.
 */

import { NEXT_RELEASE } from "./release-floors";
import type { PipelineDeclaration } from "./pipeline/spec";

/**
 * The first chant with the pipeline declaration (#5324): `.chant/pipeline.ts`
 * folded by `chant build`, `chant pipeline spec` and `chant pipeline
 * generate`, stage gates, holds and freeze windows on `components promote`,
 * a wave's `failureTolerance`, and the product helpers here. A product
 * feature-detects the pipeline on this name.
 */
export const PIPELINE_FLOOR = NEXT_RELEASE;

/**
 * The first chant whose pipeline helpers carry a product's job image and
 * install lines and its stage risk and replan keys (#5425): `pipelineFromConfig`
 * maps `environments.<name>.risk` and `replan_dependents`, and the pipeline
 * generator gives the promote, recheck and agent jobs the `image` and
 * `beforeScript` the wave jobs already take, on GitHub, GitLab and Forgejo.
 */
export const PIPELINE_PRODUCT_JOBS_FLOOR = NEXT_RELEASE;

/**
 * The first chant with stages that follow several stages and stages that
 * take one release at a time (#5353): a stage's `after` and `queue` in
 * `.chant/pipeline.ts`, a cycle among stages refused at build, the stage
 * log `components promote` writes at `_gates/<pipeline>/stages.jsonl`, and
 * `stageQueues` in `chant workspace status --json`. A product
 * feature-detects the keys on this name before it writes them.
 */
export const STAGE_GRAPH_FLOOR = NEXT_RELEASE;

/**
 * The first chant whose `workspace status --json` lists `stageQueues` for every stage of each member's pipeline in one read (#5419), each queue on the member whose pipeline it belongs to, also when members share a ledger. A product reads every stage's queue from one status call on this name.
 */
export const STATUS_STAGE_QUEUES_FLOOR = NEXT_RELEASE;

/**
 * The first chant that pauses and resumes a pipeline stage and has its urgent path (#5355): `chant stage pause` and `resume` on the stage's ledger, a paused stage refusing promotion with exit 3, a stage's `pauseAfterRollback`, and a gate's `urgent` rule that `chant components promote --urgent` passes on one proven approval from its role, with the `urgent` notify event.
 */
export const STAGE_PAUSE_URGENT_FLOOR = NEXT_RELEASE;

/**
 * The first chant whose release carries its change risk (#5387): a wave
 * that scores its change set under `holds.risk` writes the record beside its
 * release records, `chant release cut` binds the commit's records to the
 * release on its cut line, and `components promote --release` reads it at
 * each stage gate whose `holds.risk` is set, adding the risk's approval rules
 * over the threshold. The plan note shows how each later stage reads the
 * plan's score, and `workspace status` each cut's. A product feature-detects
 * a later stage's `holds.risk` on this name.
 */
export const RELEASE_RISK_FLOOR = NEXT_RELEASE;

/**
 * The first chant with soaks (#5326): a stage's and a wave's `soak` in
 * `.chant/pipeline.ts` (a duration, checks of the kinds `http`,
 * `prometheus`, `cloudwatch-alarm`, `command`, `health`, `drift`, `apply`
 * and `policy`, each `restart` or `hold` on failure, and overrides by member
 * glob), the `<stage>-soak` gate a person ends one early through, the `soak`
 * notify event, the pipeline's `recheck` schedule with `components promote
 * --pending`, and `decideSoak` for a product that decides a soak itself. A
 * product feature-detects soaks on this name before it writes the keys.
 */
export const SOAK_FLOOR = NEXT_RELEASE;

/**
 * The first chant that enforces the canary (#5327): a stage's `canary` in
 * `.chant/pipeline.ts` holds every stage after it through its soak
 * (`canaryStagesBefore`, `pipelinePromoteSoaks`), and a canary stage takes
 * a soak with checks; an op wave's `canary` marker (`OpWave.canary`, the
 * first wave) holds every later wave's job through its soak, takes its
 * stage's soak when it declares none, and warns with no checks
 * (`opWavesCanaryWarnings`); `components fan-out --canary --wave-gate`
 * holds the waves after the canary through the soak of the pipeline stage
 * it runs in; and lint warns (COR027) on a canary in `environments`. A
 * product feature-detects the marker on this name before it sets it from
 * its `waves.canary`.
 */
export const CANARY_FLOOR = NEXT_RELEASE;

/**
 * The first chant whose stage can request its rollback when its verify or
 * soak fails (#5328): a stage's `onVerifyFail: "hold" | "rollback"` in
 * `.chant/pipeline.ts`, the build's refusal of `rollback` on a stage with a
 * `sql-migrate` step or a step whose kind answers no `releaseInputs`, the
 * `failed`, `rollback-requested`, `rollback-held` and `rolled-back` lines
 * on the stage's ledger, gate `<stage>-rollback`, the `rollback-requested`
 * notify event, and `chant components rollback <stage> --requested`. A
 * product feature-detects the key on this name before it writes it.
 */
export const VERIFY_ROLLBACK_FLOOR = NEXT_RELEASE;

/**
 * The first chant whose `workspace status` shows each pipeline stage
 * (#5342): `members[].pipeline` in `--json`, one entry per stage with the
 * release it runs, its gate, the change risk the gate reads, its soak and
 * the time left, the canary soaks that hold it, a pause and a rollback
 * request, and `soak` on a soak gate's entry in `gates`; the text view adds
 * one line per stage. A product or a dashboard feature-detects the fields
 * on this name.
 */
export const STAGE_STATUS_FLOOR = NEXT_RELEASE;

/**
 * The declaration, typed. It returns its argument: the fold reads the
 * argument's text, and a run that imports the file gets the same object.
 */
export function pipeline(declaration: PipelineDeclaration): PipelineDeclaration {
  return declaration;
}

export * from "./pipeline/spec";
export { foldPipelineSource, pipelineFindingLine, PIPELINE_FOLD_RULE, PIPELINE_MODULE, type PipelineFinding, type PipelineFold } from "./pipeline/fold";
export { artifactsPublishHook, PIPELINE_FIRST_VERSION, promotionOrderOf, pipelineStage, releaseCutHook, stageHeldAt, stageHeldLine, stageWavesName, stageWavesSpec, type StageHeld } from "./pipeline/stages";
export { gitShowPipeline, promoteBase, readMemberPipeline, readPipelineAt, type PipelineRead, type PipelineShow } from "./pipeline/read";
export { pipelineStageSpecFile } from "./pipeline/generate";
export { pipelineStageShow, PROMOTE_STAGE_WAVES_FLOOR, runStageWaves, stageReleaseItems, stageRunSpec, stageRunsWaves, type StageWaveRan, type StageWavesRun } from "./pipeline/stage-waves";
export {
  isReleaseRisk,
  laterStageRisk,
  laterStageRiskLines,
  readReleaseRisk,
  releaseRiskAt,
  releaseRiskOf,
  riskAtThreshold,
  stageRiskRead,
  stageRiskSettings,
  RELEASE_RISK_DIR,
  type ReleaseRisk,
  type StageRiskRead,
  type StageRiskSettings,
  type StageRiskView,
  type WaveRisk,
  type WaveRiskLine,
} from "./lifecycle/release-risk";
export { lineDiff, pipelineChange, pipelineChangeSection, pipelineSoakSection, pipelineSpecLines, type PipelineChange } from "./pipeline/diff";
export {
  decideSoak,
  soakCheckCount,
  soakCheckName,
  soakDurationMs,
  soakGlobMatch,
  soakHoldLines,
  soakOnFail,
  soakProblems,
  soakRuleFor,
  soakSpan,
  soakSummary,
  SOAK_CHECK_KINDS,
  SOAK_MEMBER_KINDS,
  type DecideSoakInput,
  type Soak,
  type SoakCheck,
  type SoakCheckContext,
  type SoakCheckKind,
  type SoakCheckReader,
  type SoakCheckResult,
  type SoakClockState,
  type SoakDecision,
  type SoakHold,
  type SoakOnFail,
  type SoakOverride,
  type SoakRule,
  type SoakSubject,
} from "./pipeline/soak";
export { driftNamedTargets, healthVerdict, runRecordSoakSources, soakCheckReader, type SoakApplyState, type SoakDenial, type SoakExecResult, type SoakSources } from "./pipeline/soak-checks";
export { soakAtGate, stageSoakGate, waveSoakGate, SOAK_FACT_EXPIRY, type SoakGateInput, type SoakGateOutcome } from "./pipeline/soak-gate";
export { pipelinePromoteSoak, pipelinePromoteSoaks, type SoakHeldBy } from "./pipeline/promote";
export { opWavesCanaryWarnings } from "./op/op-waves";
export {
  gitStageArtifactPort,
  parseStageArtifactRecords,
  publishStageArtifacts,
  readStageArtifacts,
  releaseCutFrom,
  resolveStageReads,
  stageArtifactsNote,
  stageArtifactsSpecProblems,
  stageArtifactText,
  stagePublishProblems,
  stageReadsProblems,
  withStageReadVariables,
  STAGE_ARTIFACT_MAX_BYTES,
  STAGE_ARTIFACTS_FILE,
  STAGE_ARTIFACTS_FLOOR,
  STAGE_ARTIFACTS_KIND,
  STAGE_ARTIFACTS_RELEASE_ENV,
  type MemberOutputs,
  type PublishStageArtifactsInput,
  type PublishStageArtifactsResult,
  type ResolvedStageRead,
  type StageArtifactEntry,
  type StageArtifactPort,
  type StageArtifactRead,
  type StageArtifactRecord,
  type StageArtifactSource,
  type StageArtifactValue,
  type StageReadsResult,
} from "./pipeline/artifacts";
export {
  pipelinePromoteAgentSteps,
  pipelinePromoteGates,
  pipelinePromoteSource,
  pipelineStageEntry,
  pipelineStageFinished,
  promotedDigest,
  type AgentPolicyVerdict,
  type PipelineAgentStepsOutcome,
  type PipelineEntryOutcome,
  type PipelineEntryRelease,
  type PipelineGatesOutcome,
  type PipelinePromoteStop,
} from "./pipeline/promote";
export {
  gitStageLogPort,
  memoryStageLogPort,
  parseStageLines,
  replacedIn,
  stageLogPath,
  stageQueueOf,
  stagesInLog,
  succeededIn,
  type StageLine,
  type StageLogPort,
  type StageQueue,
} from "./lifecycle/stage-log";
export {
  pipelineUrgentGate,
  pipelineUrgentUpstream,
  urgentGateName,
  urgentUpstreamStages,
  urgentUpstreamStop,
  type PipelineUrgentOutcome,
} from "./pipeline/promote";
export {
  gitStageLedgerPort,
  memoryStageLedgerPort,
  parseStagePauseLines,
  pauseLine,
  releaseMissingIn,
  resumeLine,
  stagePaused,
  stagePausedLine,
  supersededBy,
  waitingLine,
  waitingReleases,
  STAGE_LEDGER_FILE,
  STAGE_LINE_KINDS,
  type StageLedgerPort,
  type StageLineKind,
  type StageMemberState,
  type StageMemberStateName,
  type StagePauseLine,
  type StageRelease,
} from "./pipeline/stage-ledger";
export {
  agentAnswerProblems,
  agentStepGateRule,
  agentStepRiskLevels,
  agentStepSchemaDigest,
  agentStepSettings,
  checkedAgentAnswer,
  gitStageAgentAnswerPort,
  parseStageAgentAnswerRecords,
  readStageAgentAnswers,
  runStageAgentSteps,
  stageAgentKeyEnvs,
  stageAgentPolicyInput,
  stageAgentSteps,
  stageAgentStepsHold,
  stageAgentStepsProblems,
  stageAgentStepsSpecProblems,
  AGENT_STEP_KEY_ENV,
  AGENT_STEP_TIMEOUT_MINUTES,
  AGENT_STEP_TRIGGER,
  STAGE_AGENT_ANSWER_KIND,
  STAGE_AGENT_ANSWERS_FILE,
  STAGE_AGENT_STEPS_FLOOR,
  type AgentStepModel,
  type AgentStepRead,
  type AgentStepSettings,
  type PipelineAgentStep,
  type PolicyAgentAnswer,
  type RunStageAgentStepsInput,
  type StageAgentAnswerPort,
  type StageAgentAnswerRecord,
} from "./pipeline/agent-steps";
export {
  failureDetail,
  heldReason,
  memberLines,
  memberStateOf,
  memberStatesOf,
  previousRelease,
  requestedRollbackCommand,
  requestedRollbackGate,
  requestStageRollback,
  rollbackMembers,
  soakFailureOf,
  rolledBackLine,
  stageFailures,
  stageOnVerifyFail,
  stageRollbackGate,
  standingRollbackRequest,
  verifyRollbackProblems,
  MIGRATION_STEP_KIND,
  ROLLBACK_REQUEST_EXPIRY,
  type PreviousRelease,
  type ReleaseCheck,
  type RequestedRollbackGate,
  type RollbackCapabilityView,
  type RollbackStepView,
  type StageRollbackInput,
  type StageRollbackOutcome,
} from "./pipeline/verify-rollback";
export { failedVerify, isVerifyStep, VERIFY_STEP_KINDS } from "./components/verify-step";
export {
  checkPipelineFile,
  pipelineFromConfig,
  pipelineSource,
  STAGE_HOOKS_KEY_FLOOR,
  writePipelineFile,
  type AgentStepConfig,
  type ApprovalRuleConfig,
  type ApprovalRulesConfig,
  type PipelineConfigInput,
  type PipelineEnvironmentConfig,
  type PipelineFileCheck,
  type PipelineSourceOptions,
  type StageHookConfig,
} from "./pipeline/product";
