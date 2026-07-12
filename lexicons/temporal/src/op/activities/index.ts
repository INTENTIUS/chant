export { chantBuild } from "./build";
export type { ChantBuildArgs } from "./build";

export { kubectlApply } from "./kubectl";
export type { KubectlApplyArgs } from "./kubectl";

export { helmInstall } from "./helm";
export type { HelmInstallArgs } from "./helm";

export { waitForStack } from "./wait";
export type { WaitForStackArgs } from "./wait";

export { gitlabPipeline } from "./gitlab";
export type { GitlabPipelineArgs } from "./gitlab";

export { shellCmd } from "./shell";
export type { ShellCmdArgs } from "./shell";

export { httpCheck, statusOk } from "./http-check";
export type { HttpCheckArgs, HttpFetch } from "./http-check";

export { lifecycleSnapshot, lifecycleDiff } from "./lifecycle";
export type { LifecycleSnapshotArgs, LifecycleDiffArgs, LifecycleDiffResult } from "./lifecycle";

export { chantTeardown } from "./teardown";
export type { ChantTeardownArgs } from "./teardown";

export { k3dUp, k3dDown, k3dUpCommand, k3dDownCommand, k3dExistsCommand } from "./k3d";
export type { K3dUpArgs, K3dDownArgs } from "./k3d";

// Sprites (#762): imperative, checkpointable sandbox activities. Loaded by name
// through `loadActivities(["temporal"])`; the fake lives in `sprites-fake.ts`
// and is imported only by tests (not re-exported here — it is not an activity).
export {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  spriteDestroy,
  listCheckpoints,
  resolveSpritesEndpoint,
  defaultSpritesHttp,
  spriteCreateBody,
  spriteExecBody,
  spriteCheckpointBody,
  parseCreateResponse,
  parseExecResponse,
  parseCheckpointResponse,
  parseCheckpointsResponse,
  pickCheckpointByComment,
  DEFAULT_SPRITES_BASE_URL,
} from "./sprites";
export type {
  SpritesHttp,
  SpriteCreateArgs,
  SpriteCreateResult,
  SpriteExecArgs,
  SpriteExecResult,
  SpriteCheckpointArgs,
  SpriteCheckpointResult,
  SpriteCheckpointInfo,
  SpriteRestoreArgs,
  SpriteListCheckpointsArgs,
  SpriteDestroyArgs,
} from "./sprites";

// spritzer (the Sprites API emulator) Docker lifecycle — the twin of fly's
// flapsUp/flapsDown. `spritesUp`/`spritesDown` resolve by name so an Op can
// boot/tear down the emulator as a modeled step; the sprite activities target it
// via SPRITES_BASE_URL.
export {
  spritesUp,
  spritesDown,
  spritesRunCommand,
  spritesRmCommand,
  spritesExistsCommand,
  spritesHealthUrl,
  spritesEndpoint,
} from "./sprites-emulator";
export type { SpritesUpArgs, SpritesDownArgs } from "./sprites-emulator";

// Cloud-specific appliers were relocated to their own lexicons (aws → floci,
// gcp → gcpApply, azure → az group) and are loaded from there by the core
// activity registry per the project's configured lexicons. k3d stays here — it
// is cloud-agnostic (vanilla Kubernetes).

export { reconcilePr } from "./reconcile";
export type { ReconcilePrArgs, ReconcileResult, ReconcileMode, ReconcileEntry } from "./reconcile";

export { nativeApply, compensateApply } from "./apply";
export type { NativeApplyArgs, CompensateApplyArgs, ApplyTarget, DeleteMode } from "./apply";

export { waitForArgoSync, defaultArgoStatusFetcher, ArgoSyncFailedError } from "./argo";
export type { WaitForArgoSyncArgs, ArgoAppStatus, ArgoStatusFetcher } from "./argo";

export { policyGate } from "./policy";
export type { PolicyGateArgs } from "./policy";

export { workflowSupplyChainAudit, collectAuditRefs, defaultActionRefResolver } from "./workflow-audit";
export type {
  WorkflowAuditArgs,
  WorkflowAuditResult,
  WorkflowAuditMode,
  WorkflowAuditFinding,
  WorkflowAuditFindingKind,
  ActionRefResolver,
  ActionRefResolution,
} from "./workflow-audit";

export { pipelineSupplyChainAudit, collectPipelineRefs, defaultGitlabRefResolver } from "./pipeline-audit";
export type {
  PipelineAuditArgs,
  PipelineAuditResult,
  PipelineAuditMode,
  PipelineAuditFinding,
  PipelineAuditFindingKind,
  PipelineRefKind,
  GitlabRefResolver,
  PipelineRefResolution,
} from "./pipeline-audit";

export {
  lexiconUpgrade,
  isPinned,
  isRolling,
  severityToLabel,
  upgradeBranchName,
  upgradePrTitle,
  buildUpgradeSummary,
} from "./lexicon-upgrade";
export type {
  LexiconUpgradeArgs,
  LexiconUpgradeResult,
  LexiconUpgradeMode,
  SupportedLexicon,
  SemverLabel,
  CheckPinnedFn,
  CheckRollingFn,
  GhRunner,
  ApplyBumpFn,
} from "./lexicon-upgrade";
