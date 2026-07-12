export { chantBuild } from "./build";
export type { ChantBuildArgs } from "./build";

export { kubectlApply } from "./kubectl";
export type { KubectlApplyArgs } from "./kubectl";

// helm activity relocated to the helm lexicon (#809) — loadActivities(["helm"])
// provides helmInstall. The helmInstall step builder stays in core.

export { waitForStack } from "./wait";
export type { WaitForStackArgs } from "./wait";

// gitlab activity relocated to the gitlab lexicon (#809) — loadActivities(["gitlab"])
// provides gitlabPipeline. The gitlabPipeline step builder stays in core.

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

// Sprites (Fly product) moved to the fly lexicon — a lexicon owns its own
// product's activities. `loadActivities(["fly"])` now provides the sprite
// activities + the spritzer emulator lifecycle. See lexicons/fly/src/op/activities.
//
// Cloud-specific appliers likewise live in their own lexicons (aws → floci,
// gcp → gcpApply, azure → az group) and are loaded from there by the core
// activity registry per the project's configured lexicons. k3d stays here — it
// is cloud-agnostic (vanilla Kubernetes), not a single product's surface.

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
