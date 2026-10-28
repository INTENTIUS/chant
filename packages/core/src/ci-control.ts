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
 * - Each project's `consumers.json` joined into one consumer list per
 *   release version, for the release catalog (./control/consumers.ts, #4600).
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

export {
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
  CONSUMERS_CONTRACT,
  CONSUMERS_FILE,
  consumersDocument,
  joinControlConsumers,
  parseConsumersDocument,
  readControlConsumers,
  type ConsumersDocument,
  type ControlConsumers,
  type JoinedConsumers,
  type ProjectConsumers,
  type ProjectConsumersReader,
} from "./control/consumers";
