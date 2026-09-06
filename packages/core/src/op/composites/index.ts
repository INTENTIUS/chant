/**
 * The Op composites (#2120) — the named verbs an operator authors instead of
 * hand-writing phases: watch, reconcile, apply, converge, and the three audit
 * runners.
 *
 * They lived in a hosting lexicon while a cadence meant a scheduler resource;
 * now that the cadence is `OpConfig.schedule` they are runtime-neutral, each
 * returns `{ op }`, and nothing here imports a hosting lexicon. A project that
 * wants a real scheduler resource pairs one with the Op by hand (the pattern
 * `lexicons/cedar/src/dogwood/replay-op.ts` documents).
 */

export { WatchOp } from "./watch-op";
export type { WatchOpConfig, WatchOpResources } from "./watch-op";
export { ReconcileOp } from "./reconcile-op";
export type { ReconcileOpConfig, ReconcileOpResources } from "./reconcile-op";
export { ApplyOp } from "./apply-op";
export type { ApplyOpConfig, ApplyOpResources } from "./apply-op";
export { ConvergeOp } from "./converge-op";
export type { ConvergeOpConfig, ConvergeOpResources, ConvergeDial } from "./converge-op";
export { WorkflowAuditOp } from "./workflow-audit-op";
export type { WorkflowAuditOpConfig, WorkflowAuditOpResources } from "./workflow-audit-op";
export { PipelineAuditOp } from "./pipeline-audit-op";
export type { PipelineAuditOpConfig, PipelineAuditOpResources } from "./pipeline-audit-op";
export { LexiconUpgradeOp, IN_SCOPE_LEXICONS } from "./lexicon-upgrade-op";
export type { LexiconUpgradeOpConfig, LexiconUpgradeOpResources } from "./lexicon-upgrade-op";
