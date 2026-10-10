export { Op, phase, activity, gate, effect, build, kubectlApply, helmInstall, helmInstallPinned, waitForStack, waitForReady,
         gitlabPipeline, lifecycleSnapshot, shell, sourceArchive, releasePlan, releaseRecord, composeChangeSet, lifecyclePlanChangeSet, readChangeSetPart, releaseRollbackPlan, releaseRollbackRecord, decide, ensureSecret, teardown, envTeardown, k3dUp, k3dDown,
         k3sInstall, k3sUninstall, flociUp, flociDown,
         flociAzUp, flociAzDown, flociGcpUp, flociGcpDown, httpCheck,
         azGroupEnsure, azGroupDelete, azApply, azDelete, awsApply, awsDelete, gcpApply, gcpDelete, policyGate,
         guardValidate, workEvidence,
         spriteCreate, spriteExec, spriteCheckpoint, spriteRestore, listCheckpoints, spriteDestroy,
         spriteWriteFile, spriteReadFile, spriteListDir, spriteRemove,
         spriteApplyNetworkPolicy, spriteApplyServices,
         spriteTaskCreate, spriteTaskRefresh, spriteTaskRelease,
         spritesUp, spritesDown } from "./builders";
export { OpResource } from "./resource";
export { sleep } from "./activity-runtime";
export { emulatorLifecycle, emulatorsOf, endpointEnvVars, hostPortInUse } from "./emulator-lifecycle";
export type { EmulatorSpec, EmulatorCapability, EmulatorDeclaration, EmulatorIdentity, EmulatorUpArgs, EmulatorLifecycle } from "./emulator-lifecycle";
export { checkFreshness, compare, formatResult, latestRelease, parseVersion, unpinned } from "./emulator-freshness";
export type { FreshnessResult } from "./emulator-freshness";
export type { OpConfig, OpSchedule, OpWorkLease, PhaseDefinition, StepDefinition, ActivityStep, GateStep, EffectStep, OutcomeAttribute } from "./types";
export { outcomeAttributesOf, WORK_LEASE_STEP_ID, DRIFT_EXIT_CODE } from "./types";
export {
  RunWorkLease, workLeaseOutput, stewardWorkHolder, workLeaseProblems, workLeaseNeedsRunItem, LEASE_LOST, WORK_BRANCH_PREFIX,
} from "./work-lease-run";
export type { WorkLeaseOutput, WorkLeaseRunResult, WorkClaimOutcome, RunWorkLeaseOptions } from "./work-lease-run";
export { isValidCronExpression, cronSyntaxMessage, cronMatches, cronDueBetween } from "./cron";
export {
  WatchOp, ReconcileOp, ApplyOp, ConvergeOp,
  WorkflowAuditOp, PipelineAuditOp, LexiconUpgradeOp, IN_SCOPE_LEXICONS,
  BehaviourOp,
} from "./composites";
export type {
  WatchOpConfig, WatchOpResources,
  ReconcileOpConfig, ReconcileOpResources,
  ApplyOpConfig, ApplyOpResources,
  ConvergeOpConfig, ConvergeOpResources, ConvergeDial,
  WorkflowAuditOpConfig, WorkflowAuditOpResources,
  PipelineAuditOpConfig, PipelineAuditOpResources,
  LexiconUpgradeOpConfig, LexiconUpgradeOpResources,
  BehaviourOpConfig, BehaviourOpResources,
} from "./composites";
export type {
  ConvergeSymptom, ResourceSymptom, ResourceObservation, ObservedResource, ResourceStatus,
} from "../lifecycle/symptoms";
export { parseResourceObservation, CONVERGE_RESOURCE_ENV } from "../lifecycle/symptoms";
export { receiptActivities, receiptCheckInput } from "./receipt-store";
export type {
  ReceiptStore, EffectReceiptRef, ReceiptCheckInput, ReceiptActivities, ReceiptActivityOptions,
  ReceiptReadArgs, ReceiptReadResult, ReceiptWriteArgs,
  ReceiptStalenessArgs, ReceiptStalenessResult, ReceiptStaleFinding,
} from "./receipt-store";
export { discoverOps } from "./discover";
export type { DiscoveredOp, OpDiscoveryResult } from "./discover";
export { generateOpsPipeline, generateOpWavesPipeline, withOpSchedules } from "./generate-pipeline";
export type { GenerateOpsPipelineResult, GenerateOpWavesPipelineResult } from "./generate-pipeline";
export {
  OP_WAVE_DEFAULT_APPLY,
  OP_WAVE_GATE_POLICIES,
  assertOpWavesSpec,
  opWaveJobs,
  opWaveRecordPath,
  opWaveShare,
} from "./op-waves";
export type { OpWave, OpWaveGatePolicy, OpWaveJob, OpWaveRun, OpWavesSpec } from "./op-waves";
export { opWaveNeedsApproval, parseOpWavesSpec, readOpWavePolicy, runOpWave } from "./op-waves-run";
export type { OpWaveDecision, OpWaveMember, OpWavePlanFile, RunOpWaveOptions, RunOpWaveResult } from "./op-waves-run";
export { loadActivities, loadProfiles, resolveActivity } from "./activity-registry";
export type { ActivityFn } from "./activity-registry";
export { loadActivityContracts, mergeActivityContracts } from "./activity-contract-registry";
export type { LexiconActivityContractContributor } from "./activity-contract-registry";
export { ACTIVITY_PROFILES, ACTIVITY_PROFILE_NAMES, MAX_STEP_TIMEOUT } from "./activity-profiles";
export type { ActivityProfile, ActivityProfileName } from "./activity-profiles";
export { NonRetryableActivityError, nonRetryableFailure } from "./activity-failure";
export { runOpLocally, parseDuration, OpRunFailure } from "./local-executor";
export type { StepRecord, OpRunResult, RunOpOptions } from "./local-executor";
export { currentOpRun, withOpRunContext } from "./run-context";
export type { OpRunContext, PassedGate } from "./run-context";
export { evaluateGate, gitGateLedgerPort, memoryGateLedgerPort, approveCommand, describeGateMismatch, gateIsSealed } from "./gate";
export type { GateLedgerPort, GateCheck, GateCheckInput, PendingGatePush, GateDigestMismatch, GateQuorumProgress, GateTally } from "./gate";
export { tallyGateApprovals, approverOf } from "./gate";
export {
  gateApprovalProblems, gatePolicyRequest, gatePolicyVersion, isGatePolicyRef, loadGatePolicyEvaluator, GATE_APPROVAL_MODES,
} from "./gate-approval";
export type {
  GateApproval, GateApprovalMode, GateApprover, GateContextValue, GatePolicyAnswer, GatePolicyDecision,
  GatePolicyEvaluator, GatePolicyRef, GatePolicyRequest, GateQuorum, ResolvedGateApproval,
} from "./gate-approval";
export {
  gatePlanSummary, gatePlanSummaryOfResult, changeSetOfResult, GATE_PLAN_CONTEXT_KEY, GATE_PLAN_ADDRESS_LIMIT,
} from "./gate-plan-context";
export type { GatePlanSummary } from "./gate-plan-context";
export {
  computePlanDigest, isPlanDigest, describePlanDigest, samePlanDigest, PLAN_DIGEST_ALGORITHM, PLAN_DIGEST_PREFIX,
} from "../lifecycle/plan-digest";
export { gateName, usesDeprecatedGateKey, DEPRECATED_GATE_KEY_WARNING } from "./gate-name";
export type { GateNamed } from "./gate-name";
export { gatePointOf, gatePointProblems, gatePointInputs, gateSubject, GATE_POINT_INPUTS, DEFAULT_GATE_POINT_PASS } from "./gate-point";
export type { GatePoint, GatePointFacts } from "./gate-point";
export { evaluatePointGate, workspaceGatePointAsker } from "./gate-point-run";
export type { GatePointAsker, GatePointQuestion, GatePointRequest, PointGateCheck, PointGateInput } from "./gate-point-run";
export { createLocalOpRuntime } from "./runtimes/local";
export { runStateOf } from "./runtime";
export type {
  OpRuntimeProvider, OpRunHandle, OpRunStartOptions, OpGateResolveOptions, OpRunState, OpRunStatus,
  OpRunRecord, OpRunRecordInput, OpRunPhaseRecord, OpRunStepRecord,
} from "./runtime";
export { buildOpIR, serializeOpIR, opConfigFromIR, OP_IR_FORMAT_VERSION } from "./op-ir";
export type {
  OpIR, OpIRPhase, OpIRStep, OpIRActivityStep, OpIRGateStep, OpIREffectStep, OpIRActivityContract,
} from "./op-ir";
export { renderHuman, renderJson } from "./local-output";
export {
  activityContract, isActivityContract, collectActivityContracts, validateActivitySteps, KNOWN_ACTIVITY_PROFILES,
  pathExistsInSchema,
} from "./activity-contract";
export type { ActivityContract, ActivityContractIssue } from "./activity-contract";
export { stepOutput, isStepOutputRef, collectStepOutputRefs, validateStepOutputRefs, validateStepOutputRefScope, makeOutProxy } from "./step-output-ref";
export type { StepOutputRef, WithStepRefs } from "./step-output-ref";
export type { NamedActivityStep } from "./builders";
export {
  eq, neq, gt, gte, lt, lte, truthy, falsy, allOf, anyOf,
  evaluatePredicate, isWellFormedPredicate, predicateReferencesField,
  run, report,
  when, duplicateRuleIds,
  DEFAULT_FLAP_THRESHOLD,
} from "./converge-rule";
export type {
  FieldComparisonOp, FieldTruthinessOp,
  FieldComparisonPredicate, FieldTruthinessPredicate, AllOfPredicate, AnyOfPredicate, SymptomPredicate,
  RunAction, ReportAction, RuleAction, ConvergeRule,
} from "./converge-rule";
export {
  discoverConvergeOps, runOperatorRound, runOperatorForever, formatRoundLine,
  formatSignalLine, DEFAULT_OPERATOR_INTERVAL_MS, acquireStewardLease,
  acquireStewardTurn, STEWARD_TURN_WAIT_MS, createBesideState, waitForBesideRuns, stopBesideRuns,
} from "./operator";
export type { BesideState } from "./operator";
export {
  spawnBesideRun, inProcessBesideLauncher, holdBesideLease, askReady, DEFAULT_READY_TIMEOUT_MS,
} from "./steward-beside";
export type { BesideStart, BesideExit, BesideHandle, BesideLauncher, BesideWhy, HeldBesideLease, ReadyAnswer } from "./steward-beside";
export {
  declareSteward, isStewardDeclaration, stewardFormFor, stewardOpConfig, normaliseStewardForm, stewardLeaseName,
  stewardTurnLeaseName, stewardBesideOf, stewardBesideFor, stewardTurnOps, readinessKeys,
  STEWARD_KIND, STEWARD_FORMS, STEWARD_NAME_PATTERN, DEFAULT_STEWARD_ENV,
} from "./steward";
export type {
  StewardDeclaration, StewardDeclarationConfig, StewardForm, StewardFormSpec, StewardOpInput,
  StewardBeside, StewardBesideInput,
} from "./steward";
export { discoverStewards } from "./discover";
export {
  askPointInRun, brokeredModelAsk, isPointWait, PointWait, DEFAULT_INFERENCE_CAPABILITY,
} from "./steward-points";
export type { AskPointInRunOptions, BrokeredModelAsk, WaitingPoint } from "./steward-points";
export { GateWait, isGateWait } from "./gate-wait";
export {
  currentStewardTurn, enterStewardTurn, setStewardTurn, resetStewardTurn, STEWARD_ENV,
} from "./steward-turn";
export type { StewardTurn } from "./steward-turn";
export { reportRunActivity, readInFlightRun, RUN_ACTIVITY_ENV, RUN_ID_ENV } from "./run-live";
export type { InFlightRun, InFlightRecord, InFlightPhase, InFlightActivityLine } from "./run-live";
export type { DiscoveredSteward, StewardDiscoveryResult } from "./discover";
export type {
  OperatorTickEvent, OperatorRoundOptions, OperatorLoopOptions,
  ChangeSubscriber, OperatorSignalEvent,
} from "./operator";
export { createChangeSignalGate, DEFAULT_SIGNAL_FLOOR_MS } from "./change-signal";
export type { ChangeSignalGate, ChangeSignalGateOptions, WakeReason } from "./change-signal";
export { classifyOpVerbClass, isGated } from "./op-verb-class";
export type { OpVerbClass } from "./op-verb-class";
export { takeProfileAndId } from "./builders";

// The factory reference Op (#3406, ws-087).
export { factoryOp, factoryOpConfig, factoryReady } from "./factory";
// The factory's rules themselves (#3406) are values in workspace code, which no level 0 command may load (#2526), so only their
// types are re-exported here. An orchestrator's own tools, such as a retry command a UI runs, import the values from
// `@intentius/chant/workspace/factory-rules`.
export type { FactoryItem, FactoryContext, FactoryClaim, FactoryHold, RetryState } from "../workspace/factory-rules";
export type { FactoryOpOptions } from "./factory";
