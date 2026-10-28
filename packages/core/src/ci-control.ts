/**
 * `@intentius/chant/ci-control` (#4568): the control repo, shared by the CI
 * products built on chant (terragucci, plywood).
 *
 * - The dispatch a member's pipeline sends after its apply on the default
 *   branch, for GitHub, GitLab and Forgejo, and the control repo's own
 *   pipeline that runs the member's dependents (./control/dispatch.ts). The
 *   forge lexicons serialize both: the member's `control-dispatch` job from
 *   the pull request loop's `control` option, and the control repo's file
 *   from each lexicon's `generateControlPipeline`.
 * - The control repo's projects and defaults as `control-entry` records on
 *   its workspace ledger (./control/records.ts).
 * - Reconcile over the product's generator (./control/reconcile.ts).
 * - The apply outcome an op waves pipeline's dispatch carries, and the
 *   control repo's record of each one in `_control/applied.jsonl`
 *   (./control/applied.ts, #4617).
 * - Cross-stack edges marked stale, current or unknown from the entries
 *   and those records, for the pull request note (./control/edges.ts).
 *
 * A product holds the words, the settings it writes into an entry and their
 * check, its generator and its docs. It feature-detects this entry until the
 * chant release that carries {@link CI_CONTROL_FLOOR} is its floor:
 * `controlDispatchRequest`, `putControlEntry` and `reconcileProjects`
 * present means the rest is too.
 */

import { NEXT_RELEASE } from "./release-floors";

/** The first chant with `@intentius/chant/ci-control` (#4568). */
export const CI_CONTROL_FLOOR = NEXT_RELEASE;

/** The first chant that records the applies a dispatch carries and marks cross-stack edges (#4617). `recordControlAppliedFromEnv` present means the rest is too. */
export const CONTROL_APPLIED_FLOOR = NEXT_RELEASE;

export {
  CONTROL_APPLY_OUTCOMES,
  CONTROL_OUTCOME_VAR,
  CONTROL_RUNS_DEPENDENTS,
  type ControlApplyOutcome,
  CONTROL_CHANT_COMMAND,
  CONTROL_DEPENDENTS_FLOOR,
  CONTROL_DISPATCH_JOB,
  CONTROL_MEMBER_VAR,
  CONTROL_NAME,
  CONTROL_OP_VAR,
  CONTROL_READ_TOKEN_ENV,
  CONTROL_READ_TOKEN_SECRET,
  CONTROL_REF,
  CONTROL_REF_DEFAULT,
  CONTROL_SECRET_NAME,
  CONTROL_SHA_VAR,
  CONTROL_TOKEN_ENV,
  CONTROL_TOKEN_SECRET,
  CONTROL_TOKEN_VARS,
  ControlConfigError,
  ControlDispatchError,
  controlDependentsScript,
  controlDispatchEvent,
  controlDispatchJob,
  controlDispatchRequest,
  controlDispatchScript,
  controlPipelineFileName,
  controlPipelinePath,
  controlPipelineSpec,
  controlSettingsProblems,
  controlStatusContext,
  dispatchControl,
  forgeApiBase,
  forgeFromHost,
  parseProjectKey,
  resolveControlTarget,
  type ControlDispatch,
  type ControlDispatchJobSpec,
  type ControlDispatchRequest,
  type ControlDispatchScriptOptions,
  type ControlPipelineSpec,
  type ControlSettingsInput,
  type ControlTarget,
  type ControlTokenPlace,
  type DispatchControlOptions,
  type ProjectKey,
} from "./control/dispatch";
export {
  CONTROL_ENTRY_KIND,
  CONTROL_ENTRY_KINDS,
  CONTROL_ID_PREFIX,
  CONTROL_LEDGER_DIR,
  CONTROL_LEDGER_FILE,
  ControlEntryConflict,
  ControlRecordsError,
  controlConfig,
  controlEntryDigest,
  controlEntryRecordProblems,
  currentControlEntries,
  estateClaims,
  gitControlLedger,
  importControlConfig,
  parseControlEntries,
  putControlEntry,
  readControlEntries,
  retireControlEntry,
  type ControlEntry,
  type ControlEntryKind,
  type ControlEntryRecord,
  type ControlEntryState,
  type ControlLedgerPort,
  type ControlPutResult,
  type ControlSettingsValidator,
  type ControlWriteOptions,
  type ReadControlEntriesOptions,
} from "./control/records";
export {
  cloneUrlOf,
  commandGit,
  describeReconcile,
  gitAuthEnv,
  reconcileBranch,
  reconcileProjects,
  reconcileTokenEnv,
  type ControlFileChange,
  type ControlGenerator,
  type ControlGit,
  type GitAuth,
  type ReconcileOptions,
  type ReconcileOutcome,
  type ReconcileProject,
  type ReconcileTarget,
} from "./control/reconcile";
export {
  CONTROL_APPLIED_FILE,
  CONTROL_APPLIED_KIND,
  applyOutcomeOf,
  controlAppliedProblems,
  gitControlAppliedLedger,
  latestControlApplies,
  parseControlApplied,
  recordControlApplied,
  recordControlAppliedFromEnv,
  type ApplyOutcomeSummary,
  type ControlAppliedRecord,
} from "./control/applied";
export {
  CONTROL_DIR_ENV,
  controlEdgeFactsFromEnv,
  controlMemberOf,
  markCrossStackEdges,
  readControlEdgeFacts,
  remarkCrossStackEdges,
  type ControlEdgeFacts,
  type CrossStackEdge,
  type CrossStackRead,
} from "./control/edges";
