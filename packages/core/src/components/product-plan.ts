/**
 * The product plan (#4799): the pull request plan jobs of a product whose
 * plan step runs its own plan verb, in place of `chant components pr-plan`.
 *
 * #4550 ruling A put the plan side of a product's pipeline on the pull
 * request loop. The 2026-11-09 amendment (#4799) reads it as "pr-plan or the
 * product's plan verb": sql-yodeler plans an environment with `yodel plan`
 * and terragucci its roots with `terragucci plan`, and neither has a
 * component graph for `pr-plan` to plan. Each keeps its plan verb, and chant
 * writes the jobs around it, as it does for `pr-plan`:
 *
 * - the plan job checks the change out with the token given to its fetches
 *   alone, starts every later step without the forge tokens (#4295), and
 *   runs the plan verb last, which writes a `PrReport` (`pr-plan.json`) or
 *   a product's plan note hand-off (`pr-plan-note.json`, ../pr-plan-note.ts)
 *   into {@link PR_LOOP_REPORT_DIR}. The job hands the directory on.
 * - the plan-note job checks out the target branch's commit, takes the
 *   directory back, keeps it as the run's artifact, and posts the note and
 *   the plan status with `chant components pr-post` (../pr-post.ts), which
 *   renders either file. On GitLab it is the target-branch job `pr-post
 *   --open`, as for `pr-plan` (#4328).
 *
 * With `targets`, one plan job and one plan-note job per target (an
 * environment, for sql-yodeler) in the one workflow, each with only that
 * target's own variables and secrets, and an optional write probe before the
 * plan. A target is the note's and the status's member: `pr-post --member
 * <target>`, so each target has its note and its `<product>/plan/<target>`.
 * With `evidence`, a target's note job (GitLab: `<target>-plan-evidence`)
 * signs `plan:<target>` and `policy:<target>` (#4978,
 * `targetEvidenceCheck`): one target's plan says nothing of another's.
 *
 * The forge lexicons render these descriptors
 * (`generateProductPlanPipeline` in each): the products call them in
 * process, with no component graph.
 */

import type { ForgeKind } from "../pr-forge";
import type { CiRunner } from "../ci-jobs";
import type { CiProductWords } from "../ci-product-words";
import type { PrPlanNoteWords } from "../pr-plan-note";
import { assertPipelineEvidence, evidenceIdTokens, evidenceKeyEnv, evidenceKeyless, gitlabOpenEvidenceDir, openEvidenceLines, planEvidenceLines, type PipelineEvidence } from "../ci-evidence-jobs";
import { gitlabPlanJobName, PR_LOCK_JOB, PR_LOOP_REPORT_DIR, PR_PLAN_NOTE_JOB, prLoopPassedEnv, prLoopPostJob, prLoopRunner, withProductBin, type PrLoopPipelineOptions } from "./pr-pipeline";
import { LOCK_REACH_ENV } from "../lifecycle/reach-locks";
import { GITHUB_JOB_TOKEN } from "../ci-jobs";
import { cloudLogin, type CloudLoginSpec } from "../ci-login";
import type { OpWaveRunStep } from "../lexicon";
import { controlNoteCheckout, type ControlNoteCheckout, type ControlTarget } from "../control/dispatch";
import { commentLine, productStatusContext } from "../ci-product-words";
import { PLAN_WATCHES_ENV, scheduledWatchProblem, type ScheduledWatch } from "../op/schedule-overdue";
import { PLAN_RUN_OP, PLAN_RUN_RECORD_FILE } from "../pr-plan-record";
import { idTokenVar, tradedClouds, type CloudTradeSpec } from "../ci-identity";
import { prNoteMarker } from "../pr-loop";
import { PRODUCT_MARKER_NAME } from "../pr-plan-note";

/** The variable the plan-note job reads the product's note words from (#4799), as JSON. Set from the pipeline, never from the report. */
export const PR_PLAN_NOTE_WORDS_ENV = "CHANT_PLAN_NOTE_WORDS";

/** One target the product plans in a job of its own (#4799): an environment, for sql-yodeler. */
export interface ProductPlanTarget {
  /** The target's name: `{target}` in the command, the job names, and the note's member. Letters, digits, `-` and `_`. */
  name: string;
  /** Variables for this target's plan job alone, as the forge reads them. A forge token's name is refused. */
  variables?: Record<string, string>;
  /** Secrets for this target's plan job alone, as `{ <variable>: <secret> }`, mapped as the pull request loop's `secrets` are. */
  secrets?: Record<string, string>;
  /**
   * A shell line run before the plan that fails the job when the target's
   * credentials can write, such as sql-yodeler's `yodel config check <env>
   * --write-probe`. It runs with the target's variables, after the forge
   * tokens are dropped.
   */
  writeProbe?: string;
  /**
   * This target's cloud login (#4899, #4931), in place of the plan's
   * {@link ProductPlanOptions.login}: chant's login from the OIDC token file
   * (`@intentius/chant/ci-login`, #4788), run before the write probe.
   */
  login?: CloudLoginSpec;
  /** OIDC tokens this target's plan job requests besides its login's, `{ <variable>: <audience> }`, in place of the plan's {@link ProductPlanOptions.idTokens}. */
  idTokens?: Record<string, string>;
  /** This target's trade (#4963), in place of the plan's {@link ProductPlanOptions.trade}. A target gives one of `login` and `trade`. */
  trade?: CloudTradeSpec;
}

/**
 * What the comment re-plan does besides answering the plan command (#4963),
 * `replan: { ... }` in place of `replan: true`.
 */
export interface ProductPlanReplanOptions {
  /**
   * Re-plan from `workflow_dispatch` too, on GitHub and Forgejo: the inputs
   * `pr` (the pull request) and `argument` (default `argument`; the target,
   * or the one word {@link PLAN_ARGUMENT_ENV} reads, such as terragucci's
   * `root`). Either forge lets only someone who can write to the repository
   * dispatch, so the decision asks no permission for it. On GitLab a web
   * pipeline of the target branch with `CHANT_PREVIEW_PR` and
   * `CHANT_PREVIEW_COMMENT` is the dispatch already, so it renders nothing
   * more there.
   */
  dispatch?: boolean | { argument?: string };
  /**
   * Reply to a `/<product>` comment no other job takes (#4963), on GitHub
   * and Forgejo: a word that is not the plan command, a target that is none
   * of the plan's, and a pull request from a fork with `forks: "skip"`. The
   * reply names the commands. `others` are the comments the product's own
   * jobs answer, such as `/terragucci apply`: the re-plan leaves them alone.
   * With targets, the first target's re-plan job replies. GitLab's
   * note-commands job answers every comment already.
   */
  reply?: boolean | { others?: string[] };
  /**
   * Reply "not affected" for a re-plan narrowed to one argument the change
   * does not reach (#4963): when the hand-off's note says `nothing` (or a
   * `PrReport` says `nothing`), the re-plan's note job comments
   * `<product>: <argument> is not affected by this pull request, so
   * nothing was planned.` and leaves the note and the status as they were
   * (`pr-post --not-affected <argument>`).
   */
  notAffected?: boolean;
}

/**
 * A step a product's plan job runs before its setup lines (#4899): a shell
 * line (`run`), or on GitHub and Forgejo an action (`uses`), such as a
 * cache restore. A `run` step starts without the forge tokens, as every
 * step after the checkout does. GitLab has no actions, so it leaves a
 * `uses` step out; its generator's `cache` is GitLab's cache.
 */
export interface ProductPlanSetupStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

/**
 * The comment re-plan (#4899): `/<product> <plan word>` (or a words' alias
 * for the plan command) plans an open pull request again. With `targets`,
 * `/<product> plan <target>` plans that target alone, and the bare command
 * plans every target. Without targets, the one word after the command
 * reaches the plan verb as {@link PLAN_ARGUMENT_ENV}, such as terragucci's
 * root.
 */
export interface ProductPlanReplanJob {
  /** `replan` or `replan-<target>` on GitHub and Forgejo, `replan` or `<target>-replan` on GitLab. */
  jobName: string;
  /** `replan-note` or `replan-note-<target>`, `<target>-replan-note` on GitLab. */
  noteJobName: string;
  /** The comments it answers: the plan command, then each alias for it that is on. */
  comments: string[];
  /** Aliases whose words name a variable that turns them on, with that variable. */
  gated: Array<{ comment: string; when: string }>;
  /** The note job's command and variables, which read the pull request and head from the re-plan job. */
  post: { command: string; env: Record<string, string>; setup?: string[] };
  /** The artifact the note job (GitHub, Forgejo) or the re-plan job (GitLab) keeps the directory as. */
  artifact: string;
  /** With `dispatch` (#4963), GitHub and Forgejo: the `workflow_dispatch` input that names the argument. */
  dispatch?: { argument: string };
  /** With `reply` (#4963), GitHub and Forgejo, on one re-plan job: the product's prefix and the comments other jobs answer. */
  reply?: { prefix: string; others: string[] };
  /** With `notAffected` (#4963): the note job's command carries `--not-affected`, and reads the argument as {@link PLAN_ARGUMENT_ENV}. */
  notAffected?: true;
}

/** The variable a comment re-plan's one argument reaches the plan verb in (#4899). Empty on a pull request's own plan. */
export const PLAN_ARGUMENT_ENV = "CHANT_PLAN_ARGUMENT";

/** The file the note job's own lines write extra notices to, one a line (#4931): `pr-post` adds them under the note's counts. */
export const PLAN_NOTE_NOTICES_ENV = "CHANT_PLAN_NOTE_NOTICES";

/** The product plan (#4799): {@link ProductPipelineOptions.plan}. */
export interface ProductPlanOptions {
  /**
   * The product's plan verb, as one shell line: `{target}` is the target's
   * name and `{output}` the directory the plan-note job takes back
   * ({@link PR_LOOP_REPORT_DIR}). It reads `$BASE_SHA` and `$PR_NUMBER`, and
   * writes `pr-plan.json` or `pr-plan-note.json` there. It runs as given,
   * not through the words' `bin`: it is the product's command, not chant's.
   */
  command: string;
  /** One plan job per target. Absent: one plan job, named as the pull request loop's. */
  targets?: ProductPlanTarget[];
  /**
   * `skip`: a pull request from a fork runs no plan and no note job (on
   * GitHub and Forgejo it carries no token and no OIDC; on GitLab, a fork's
   * merge request pipeline runs in the fork). The product's check job,
   * which holds no credentials, still runs for it. Default: every pull
   * request plans.
   */
  forks?: "skip";
  /** The artifact the plan-note job keeps the directory as. Default `chant-pr-plan`, or `chant-pr-plan-<target>`. */
  artifact?: string;
  /** The words a plan note hand-off renders with (`renderPlanNote`'s `note`), passed to the note job as {@link PR_PLAN_NOTE_WORDS_ENV}. */
  noteWords?: PrPlanNoteWords;
  /** The workflow's name (GitHub and Forgejo) or the pipeline's (GitLab). Default `chant-pr-<env>`. */
  workflow?: string;
  /**
   * Variables for the whole plan job (#4899), every step of it: the job's
   * `env` on GitHub and Forgejo, its `variables` on GitLab. A forge token's
   * name is refused.
   */
  env?: Record<string, string>;
  /**
   * The plan job's cloud login (#4899, #4931), for every target without
   * its own: chant's login from the OIDC token file
   * (`@intentius/chant/ci-login`, #4788), after the setup lines and before
   * the write probe. The job asks for the OIDC token: `id-token: write`
   * (Forgejo `enable-openid-connect`), GitLab `id_tokens`.
   */
  login?: CloudLoginSpec;
  /**
   * OIDC tokens the plan job requests for a login the product's command
   * does itself (#4931), `{ <variable>: <audience> }`: GitLab `id_tokens`,
   * and `id-token: write` on GitHub and Forgejo, where the command asks the
   * forge for its token by audience.
   */
  idTokens?: Record<string, string>;
  /**
   * Post the plan status pending ("planning") before the checkout (#4899),
   * on GitHub and Forgejo, from a step that alone holds the job's token.
   * The job asks for `statuses: write`. GitLab's plan job holds no token,
   * so there the pipeline's own status says the plan runs.
   */
  pending?: boolean;
  /**
   * The control repo the plan reads (#4899), as terragucci reads it for
   * estate ownership: chant's read-only fetch of its `chant/lifecycle`
   * (`controlNoteCheckout`), right after the checkout and before any of the
   * change's code runs. It sets `CHANT_CONTROL_DIR`.
   */
  controlRead?: ControlTarget;
  /** Steps after the checkout and the control read, before the setup lines (#4899): a cache restore, an install. */
  setup?: ProductPlanSetupStep[];
  /**
   * A shell line run after the plan verb whatever its exit (#4899), such as
   * sql-yodeler's `yodel report {target} --out {output}/report`, in the plan
   * step, so it is not a step after the change's code. `{target}` and
   * `{output}` are filled as in `command`. The step then exits with the plan
   * verb's status. What it writes under `{output}` is kept with the report.
   */
  report?: string;
  /**
   * One run at a time per pull request (#4899): a workflow-level
   * `concurrency` group `<group>-<pull request>` on GitHub and Forgejo
   * (default group: the workflow's name), cancelling the run before it when
   * `cancelInProgress`. A comment's run, with `replan`, is in a group of its
   * own comment, so a comment never cancels a plan. On GitLab
   * `cancelInProgress` makes the plan jobs `interruptible`, which GitLab's
   * auto-cancel of redundant pipelines stops.
   */
  concurrency?: { group?: string; cancelInProgress?: boolean };
  /**
   * The comment re-plan (#4899, {@link ProductPlanReplanJob}). The words
   * need a plan command. On GitHub the commenter must be an owner, member or
   * collaborator; on Forgejo the job asks the forge whether the commenter
   * can write. On GitLab the note-commands job (`noteCommands`) starts a
   * pipeline of the target branch for the comment, which runs the re-plan
   * jobs whose target the comment names.
   */
  replan?: boolean | ProductPlanReplanOptions;
  /**
   * The plan job's trade (#4963): chant's trade of the job's OIDC token for
   * the plan identities' own credentials (`@intentius/chant/ci-identity`,
   * #4296), before the change is checked out, as terragucci's re-plan
   * trades. The plan job and the re-plan job trade in a step of their own
   * (GitHub, Forgejo: after the pending status and the re-plan's decision,
   * before the checkout; GitLab: the script's first lines, before the
   * re-plan checks out the head), and every later step starts without the
   * variables a token is requested with, so the change's code holds the
   * traded credentials and no OIDC token. Give one of `login` and `trade`.
   */
  trade?: CloudTradeSpec;
  /**
   * The previous note's product marker for the plan verb (#4963), on GitHub
   * and Forgejo: a step before the checkout, which alone holds the job's
   * token, finds the pull request's note by chant's marker and sets
   * `CHANT_PLAN_PREVIOUS_MARKER` to the body of its second line, the
   * product's own (`noteWords.productMarker`, a hand-off's `marker`), so a
   * plan verb such as `yodel plan` reads the digest subject it left there
   * and says what moved. Empty when there is no note yet. The body was
   * checked against the marker's pattern before chant posted it, and is
   * checked again. Needs `noteWords.productMarker`. GitLab's plan job holds
   * no token to read a note with, so it takes none.
   *
   * @deprecated #4972: hand the plan's `subject` in the plan note hand-off
   * instead. The note job compares it with the previous note's on every
   * forge and says what changed, so the plan job reads no note. This option
   * still works on GitHub and Forgejo.
   */
  previousMarker?: boolean;
  /**
   * Lines the note job runs (#4931), on GitHub and Forgejo, in the job that
   * holds the token and none of the change's code: `before` after the report
   * is taken back and before `pr-post`, `after` once it posted. A `before`
   * line may write notices, one a line, to the file
   * `$CHANT_PLAN_NOTE_NOTICES` names, and `pr-post` adds them under the
   * note's counts, such as terragucci's notice naming whose review does not
   * count. They reach the job's token as `GITHUB_TOKEN`. GitLab's note job
   * posts every open merge request's note in one run, so it takes none.
   *
   * With `pullRequest` (#4963) the lines also read the pull request and the
   * commit planned as `PR_NUMBER` and `HEAD_SHA`, the note's own, which in
   * a re-plan's note job come from the re-plan job, such as terragucci's
   * notice and approval status, which ask the forge about the head.
   */
  noteSteps?: { before?: string[]; after?: string[]; pullRequest?: boolean };
  /**
   * The product's own scheduled jobs the note job checks for having stopped
   * (#4888), such as terragucci's drift job: each a `ScheduledWatch` with
   * its cron, the files the product's generator wrote it in, and on GitLab
   * its schedule selector. The note job holds the token the plan job lacks,
   * so `pr-post` asks the forge when each last ran, in its checkout of the
   * target branch's commit, and adds the line for one that is overdue under
   * the note's counts. They reach it as `CHANT_PLAN_WATCHES`, from the
   * pipeline, never from the plan job's report.
   */
  watches?: ScheduledWatch[];
  /**
   * A run record for the plan job (#4899), as `chant ci run plan --in-place`
   * writes one for `pr-plan`'s: Op `pr-plan` in the run ledger,
   * `<env>/runs__pr-plan.jsonl` on `chant/lifecycle`. The plan job holds no
   * token, so its plan step writes the record into the hand-off
   * ({@link PLAN_RUN_RECORD_FILE}) once the plan verb and the report line ran,
   * and the note job, which holds the token, appends it to the ledger and
   * pushes it with the note (`pr-post --record-run <plan job>`). The note job
   * reads the record as data: it keeps the record's id, times and exit code,
   * and names the op, environment, commit, run and status from what it knows
   * itself. The note job then asks `contents: write` on GitHub and Forgejo.
   * Unsigned, as `pr-plan`'s is (#4328). Default off.
   */
  record?: boolean;
  /**
   * What the lock job locks under `locks: "plan"` (#4979): the targets the
   * change reaches, by the product's reach line, in place of what a
   * `PrReport` selected. `command` is one shell line that prints the target
   * names the change from `$BASE_SHA` to `$HEAD_SHA` reaches, one a line,
   * reading the change's files as data from git (`git diff`, `git show`),
   * such as terragucci's roots, Terragrunt units or Atmos instances. It
   * runs at the target branch's commit, after chant fetched the pull
   * request's head and checked it is the head the job was started for
   * (`chant lock --reach`, ../lifecycle/reach-locks.ts), so none of the
   * change's code runs in the job that holds the write token. `gate` names
   * the lock file, `_locks/<gate>.json` (default the pull request loop's).
   *
   * GitHub and Forgejo run one `lock` job on each push of a pull request
   * from this repository, beside the plan, and the `unlock` job on close.
   * On GitLab, where a merge request's pipeline is built from its own files,
   * the `lock` job runs in the target branch's plan notes pipeline and locks
   * every open merge request (`--open`), releasing the locks of one that is
   * no longer open; with `noteCommands` the comment lock and unlock jobs
   * answer `/<product> lock` and `/<product> unlock` there too.
   */
  reach?: { command: string; gate?: string };
}

/** The lock job a product plan with {@link ProductPlanOptions.reach} writes (#4979): its command and the values the command reads. */
export interface ProductPlanReachLock {
  jobName: typeof PR_LOCK_JOB;
  command: string;
  env: Record<string, string>;
  runner?: CiRunner;
}

/**
 * The reach lock job (#4979), under `locks: "plan"` with `reach`: `chant lock
 * --reach` through the words' bin, with the reach line as
 * {@link LOCK_REACH_ENV}. On GitHub and Forgejo it locks the pull request of
 * the event; on GitLab every open merge request into the branch.
 */
export function productPlanReachLock(forge: ForgeKind, loop: Pick<PrLoopPipelineOptions, "locks" | "runners"> & { plan: Pick<ProductPlanOptions, "reach"> }, words: CiProductWords): ProductPlanReachLock | undefined {
  const reach = loop.plan.reach;
  if (!reach) return undefined;
  if (loop.locks !== "plan") throw new Error("the product plan's reach says what the lock job locks, and there is none without locks: \"plan\"; set locks: \"plan\", or drop reach");
  if (!reach.command.trim()) throw new Error("the product plan's reach.command is empty; give the line that prints the targets a change reaches");
  if (/[\r\n]/.test(reach.command)) throw new Error("the product plan's reach.command is one shell line");
  if (reach.gate !== undefined) {
    // The lock file's name, as ../lifecycle/target-lock.ts takes it.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(reach.gate)) throw new Error(`the product plan's reach.gate ${JSON.stringify(reach.gate)} is not a lock file name: letters, digits, '.', '_' and '-', starting with a letter or digit`);
  }
  const gate = reach.gate !== undefined ? ["--gate", reach.gate] : [];
  const github = forge !== "gitlab";
  const line = github
    ? ["chant", "lock", "--reach", "--pr", '"$PR_NUMBER"', "--head", '"$HEAD_SHA"', "--base", '"$BASE_SHA"', "--stage", "plan", ...gate, "--forge", forge]
    : ["chant", "lock", "--reach", "--open", "--base", '"$CI_COMMIT_SHA"', "--stage", "plan", ...gate, "--forge", "gitlab"];
  const env: Record<string, string> = github
    ? { PR_NUMBER: "${{ github.event.pull_request.number }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}", GITHUB_TOKEN: GITHUB_JOB_TOKEN, [LOCK_REACH_ENV]: reach.command }
    : { [LOCK_REACH_ENV]: reach.command };
  const runner = prLoopRunner(loop, "default");
  return { jobName: PR_LOCK_JOB, command: withProductBin(line.join(" "), words.bin), env, ...(runner !== undefined ? { runner } : {}) };
}

/** The file a product plan job writes its run record to under the hand-off directory, and the Op it is recorded under: `pr-plan`'s (#4899, ../pr-plan-record.ts). */
export { PLAN_RUN_OP, PLAN_RUN_RECORD_FILE } from "../pr-plan-record";

/** The variable the plan step reads the record's op, environment and labels from (#4899), as JSON. */
export const PLAN_RUN_RECORD_ENV = "CHANT_PLAN_RECORD";

/** One plan job and its note job, for one target or for the whole pipeline (#4799). */
export interface ProductPlanJob {
  /** The target, when the plan has targets. Also the note's and the status's member. */
  target?: string;
  /** The plan job: `plan` or `plan-<target>` on GitHub and Forgejo, `plan` or `<target>-plan` on GitLab, where `pr-post --open` finds it by that name. */
  jobName: string;
  /** The note job: `plan-note` or `plan-note-<target>`, `<target>-plan-note` on GitLab. */
  noteJobName: string;
  /** The plan verb's line, `{target}` and `{output}` filled. */
  command: string;
  /** The plan step's variables: `BASE_SHA`, `PR_NUMBER`, the pipeline's passed variables and secrets, then the target's. No forge token. */
  env: Record<string, string>;
  /** The target's write probe. */
  writeProbe?: string;
  /** The note job's command and variables. */
  post: { command: string; env: Record<string, string> };
  /** The artifact the note job (GitHub, Forgejo) or the plan job (GitLab) keeps the directory as. */
  artifact: string;
  /** Where the plan job runs: the loop's `plan` runner. */
  runner?: CiRunner;
  /** Where the note job runs: the loop's `default` runner. */
  noteRunner?: CiRunner;
  /**
   * With the pipeline's `evidence` (#4870): the lines that sign the plan
   * job's `plan` and `policy` checks from its report (with a target,
   * `plan:<target>` and `policy:<target>`, #4978), and their variables
   * (the runner key from its secret). GitHub and Forgejo run them in the
   * note job before `pr-post`; GitLab in a job of their own, `jobName`, in
   * the target branch's plan notes pipeline before the note job (#4914),
   * which keeps `dir` as its artifact and names the environment
   * `GITLAB_EVIDENCE_ENVIRONMENT`; the note job reads `dir`
   * (`--evidence-dir`). Signing keyless (#4869), the job asks for an OIDC
   * token: `idToken` (GitHub's `id-token: write`, Forgejo's
   * `enable-openid-connect`) or GitLab's `idTokens`.
   */
  evidence?: { lines: string[]; env: Record<string, string>; jobName?: string; dir?: string; idToken?: true; idTokens?: Record<string, { aud: string }> };
  /** The job's own variables (#4899), every step's. */
  jobEnv?: Record<string, string>;
  /** The cloud login's steps (#4931), after the setup lines and before the write probe. GitLab: their lines in the script. */
  login?: OpWaveRunStep[];
  /** The OIDC tokens the plan job requests (#4931), `{ <variable>: <audience> }`: the login's and the product's own. */
  idTokens?: Record<string, string>;
  /** The pending status posted before the checkout (#4899), on GitHub and Forgejo. */
  pending?: { context: string; description: string };
  /** The control repo read after the checkout (#4899). */
  control?: ControlNoteCheckout;
  /** The steps before the setup lines (#4899). */
  setup?: ProductPlanSetupStep[];
  /** The report line after the plan verb (#4899), `{target}` and `{output}` filled. */
  report?: string;
  /** The comment re-plan's jobs for this target (#4899). */
  replan?: ProductPlanReplanJob;
  /** The note job's own lines (#4931); with `pullRequest` (#4963) they read `PR_NUMBER` and `HEAD_SHA`. */
  noteSteps?: { before: string[]; after: string[]; pullRequest?: true };
  /** The trade before the checkout (#4963), and on GitLab the `id_tokens` it reads (in `idTokens` too). */
  trade?: CloudTradeSpec;
  /** With `previousMarker` (#4963): the note's marker and the product marker's name the read step looks for. */
  previous?: { marker: string; name: string };
  /** With `record` (#4899): the plan step writes the run record, `env` its op, environment and labels as {@link PLAN_RUN_RECORD_ENV}; the note job's command records it. */
  record?: { env: Record<string, string> };
}

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The pull request loop's options the product plan's jobs do not carry, and what each needs. Each is refused with `plan` (#4799). */
const NOT_WITH_PLAN: ReadonlyArray<[keyof PrLoopPipelineOptions, string]> = [
  ["applyBeforeMerge", "the apply before merge runs pr-apply on pr-plan's report"],
  ["applyOnMerge", "the apply on merge runs on op waves, from the waves spec"],
  ["waveGate", "the apply on merge runs on op waves, from the waves spec"],
  ["previewComment", "the comment preview re-runs pr-plan"],
  ["staleNotes", "the stale marking names one note per pipeline"],
  ["identity", "the identity trade runs before pr-plan's checkout; give the product plan's trade or login (or a target's) instead"],
  ["build", "the plan verb builds what it plans"],
  ["buildCommand", "the plan verb builds what it plans"],
  ["refresh", "--refresh is a pr-plan flag"],
  ["parallelism", "--parallelism is a pr-plan flag"],
  ["commentTargets", "--comment-targets is a pr-plan flag"],
  ["events", "--events-json is a pr-plan flag"],
  ["reportUrl", "--report-url is a pr-plan flag"],
  ["prEnvironment", "the pull request environment jobs run pr-env"],
  ["actionJob", "the action job is in chant build --pr-loop's workflow"],
  ["control", "the control read is the pr-plan report's cross-stack edges"],
  ["decide", "the description check reads pr-plan's report"],
];

/**
 * The product plan's jobs for `forge` (#4799). `words` are the pipeline's,
 * already checked. Throws on a target name that is not one, a name given
 * twice, a target variable that is a forge token, and a pull request loop
 * option the product plan does not carry.
 */
export function productPlanJobs(forge: ForgeKind, env: string, loop: PrLoopPipelineOptions & { plan: ProductPlanOptions }, words: CiProductWords, evidence?: PipelineEvidence): ProductPlanJob[] {
  const plan = loop.plan;
  for (const [key, why] of NOT_WITH_PLAN) {
    const value = loop[key];
    if (value !== undefined && value !== false) throw new Error(`the product plan (plan) takes no ${key}: ${why}`);
  }
  // #4946: GitHub's and Forgejo's product plan writes the lock jobs around the plan verb's PrReport.
  // #4979: GitLab's locks what each open merge request reaches, from the plan notes pipeline, so it needs the reach line.
  if (loop.locks && forge === "gitlab" && !plan.reach) throw new Error("the product plan (plan) takes locks on GitLab only with reach: a merge request's pipeline is built from its own files, so the lock job runs in the target branch's plan notes pipeline and locks what reach prints for each open merge request");
  // #4899: GitLab's comment commands start the re-plan, so the note-commands job comes with it.
  if (loop.noteCommands && !plan.replan) throw new Error("the product plan (plan) takes no noteCommands without replan: the note-commands job starts its comment re-plan");
  if (!plan.command.trim()) throw new Error("the product plan's command is empty; give the product's plan verb");
  const targets = plan.targets;
  if (targets !== undefined && targets.length === 0) throw new Error("the product plan's targets are empty; leave targets out for one plan job");
  const seen = new Set<string>();
  for (const t of targets ?? []) {
    if (!TARGET_NAME.test(t.name)) throw new Error(`the product plan's target ${JSON.stringify(t.name)} is not a name of letters, digits, - and _`);
    if (seen.has(t.name)) throw new Error(`the product plan names target ${t.name} twice`);
    seen.add(t.name);
  }
  const github = forge !== "gitlab";
  const shared = prLoopPassedEnv(forge, loop);
  const jobEnv = plan.env ? prLoopPassedEnv(forge, { variables: plan.env }) : {};
  for (const key of Object.keys(jobEnv)) {
    if (key in shared) throw new Error(`the product plan's env ${key} is the pipeline's too; give it once`);
  }
  for (const s of plan.setup ?? []) {
    if ((s.run === undefined) === (s.uses === undefined)) throw new Error(`the product plan's setup step ${JSON.stringify(s.name ?? s.run ?? s.uses ?? "")} gives one of run and uses`);
    if (s.run !== undefined && s.with !== undefined) throw new Error(`the product plan's setup step ${JSON.stringify(s.name ?? s.run)} runs a line, and only a uses step takes with`);
  }
  if (plan.concurrency?.group !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(plan.concurrency.group)) throw new Error(`the product plan's concurrency group ${JSON.stringify(plan.concurrency.group)} is not a name of letters, digits, ., - and _`);
  const replanComments = plan.replan ? replanCommentsOf(words) : undefined;
  // #4963: what the re-plan does besides the plan command.
  const replanOpts: ProductPlanReplanOptions = typeof plan.replan === "object" ? plan.replan : {};
  const dispatchArg = replanOpts.dispatch ? (typeof replanOpts.dispatch === "object" && replanOpts.dispatch.argument !== undefined ? replanOpts.dispatch.argument : "argument") : undefined;
  if (dispatchArg !== undefined && (dispatchArg === "pr" || !/^[a-z][a-z0-9_-]*$/.test(dispatchArg))) throw new Error(`the product plan's replan.dispatch.argument ${JSON.stringify(dispatchArg)} is not an input name of lowercase letters, digits, - and _ other than pr`);
  const others = typeof replanOpts.reply === "object" ? (replanOpts.reply.others ?? []) : [];
  for (const o of others) {
    if (!o.startsWith(`/${words.product} `) && !o.startsWith(`/${words.product}\t`) && o !== `/${words.product}`) throw new Error(`the product plan's replan.reply.others ${JSON.stringify(o)} is not a /${words.product} comment`);
    if (/['\r\n]/.test(o)) throw new Error(`the product plan's replan.reply.others ${JSON.stringify(o)} holds a quote or a line break`);
  }
  if (plan.previousMarker && !github) throw new Error("the product plan's previousMarker reads the pull request's note before the checkout, with the job's token, and GitLab's plan job holds no token to read a merge request's notes with; leave previousMarker out on GitLab");
  const productMarker = plan.noteWords?.productMarker;
  if (plan.previousMarker && (productMarker === undefined || !PRODUCT_MARKER_NAME.test(productMarker))) throw new Error("the product plan's previousMarker reads the note's product marker, and the note words name none; give noteWords.productMarker");
  if (plan.noteSteps && !github && ((plan.noteSteps.before?.length ?? 0) > 0 || (plan.noteSteps.after?.length ?? 0) > 0)) {
    throw new Error("the product plan's noteSteps run in the note job of one pull request, and GitLab's note job posts every open merge request's note in one run (pr-post --open); leave noteSteps out on GitLab");
  }
  const planRunner = prLoopRunner(loop, "plan");
  const noteRunner = prLoopRunner(loop, "default");
  const base = github
    ? { BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}" }
    : { BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" };
  for (const w of plan.watches ?? []) {
    const problem = scheduledWatchProblem(w);
    if (problem) throw new Error(`the product plan's watches: ${problem}`);
  }
  if (new Set((plan.watches ?? []).map((w) => w.op)).size !== (plan.watches ?? []).length) throw new Error("the product plan's watches name an Op twice");
  // The note job's variables from the pipeline: the note words, and the product's watches (#4888).
  const noteWords: Record<string, string> = {
    ...(plan.noteWords ? { [PR_PLAN_NOTE_WORDS_ENV]: JSON.stringify(plan.noteWords) } : {}),
    ...(plan.watches?.length ? { [PLAN_WATCHES_ENV]: JSON.stringify(plan.watches) } : {}),
  };
  const fill = (line: string, name: string | undefined): string => line.replaceAll("{target}", name ?? env).replaceAll("{output}", PR_LOOP_REPORT_DIR);
  const control = plan.controlRead ? controlNoteCheckout(forge, plan.controlRead, words) : undefined;
  const one = (target?: ProductPlanTarget): ProductPlanJob => {
    const name = target?.name;
    const jobName = github ? (name ? `plan-${name}` : "plan") : gitlabPlanJobName(name);
    const noteJobName = github ? (name ? `${PR_PLAN_NOTE_JOB}-${name}` : PR_PLAN_NOTE_JOB) : name ? `${name}-${PR_PLAN_NOTE_JOB}` : PR_PLAN_NOTE_JOB;
    const own = target ? prLoopPassedEnv(forge, { ...(target.variables ? { variables: target.variables } : {}), ...(target.secrets ? { secrets: target.secrets } : {}) }) : {};
    for (const key of Object.keys(own)) {
      if (key in shared) throw new Error(`target ${name}'s ${key} is the pipeline's too; give it on the target or on the pipeline`);
      if (key in jobEnv) throw new Error(`target ${name}'s ${key} is the product plan's env too; give it once`);
    }
    const post0 = prLoopPostJob(forge, env, name, words);
    // #4899: the note job records the plan job's run, named by that job.
    const post1 = plan.record ? { ...post0, command: `${post0.command} --record-run ${jobName}` } : post0;
    // #4914: on GitLab the signing job of the same pipeline keeps each merge request's evidence, which the note's checks line reads.
    const post = evidence && !github ? { ...post1, command: `${post1.command} --evidence-dir ${gitlabOpenEvidenceDir(jobName)}` } : post1;
    // The note job reads its own plan job's result, by that job's name.
    const postEnv: Record<string, string> = github ? { ...post.env, PLAN_RESULT: `\${{ needs.${jobName}.result }}`, ...noteWords } : { ...post.env, ...noteWords };
    // #4931: the target's login, else the plan's, from the OIDC token file (ci-login, #4788).
    // #4963: a target's own login or trade stands in for both of the plan's.
    const own2 = target?.login !== undefined || target?.trade !== undefined;
    const loginSpec = own2 ? target?.login : plan.login;
    const tradeSpec = own2 ? target?.trade : plan.trade;
    if (loginSpec && tradeSpec) throw new Error(`the product plan${name ? `'s target ${name}` : ""} gives both login and trade; the trade leaves no token for a login to read, so give one`);
    if (tradeSpec && tradedClouds(tradeSpec).length === 0) throw new Error(`the product plan${name ? `'s target ${name}` : ""} trades for no identity; give the trade a cloud`);
    const login = loginSpec ? cloudLogin(forge, loginSpec) : undefined;
    const tradeTokens: Record<string, string> = tradeSpec ? Object.fromEntries(tradedClouds(tradeSpec).map((c) => [idTokenVar(c), tradeSpec[c]!.audience])) : {};
    const ownTokens = target?.idTokens ?? plan.idTokens;
    for (const [v, aud] of Object.entries(ownTokens ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`the product plan's id token ${JSON.stringify(v)} is not a variable name`);
      if (!aud.trim() || /\s/.test(aud)) throw new Error(`the product plan's id token ${v} names no audience`);
      if (login && v in login.idTokens && login.idTokens[v] !== aud) throw new Error(`the product plan's id token ${v} is the login's, with another audience`);
      if (v in tradeTokens && tradeTokens[v] !== aud) throw new Error(`the product plan's id token ${v} is the trade's, with another audience`);
    }
    const idTokens = { ...(login?.idTokens ?? {}), ...tradeTokens, ...(ownTokens ?? {}) };
    const artifact = plan.artifact ? (name ? `${plan.artifact}-${name}` : plan.artifact) : name ? `chant-pr-plan-${name}` : "chant-pr-plan";
    // #4963: on GitHub and Forgejo the first re-plan job replies to the comments no other job takes.
    const replies = github && Boolean(replanOpts.reply) && (targets === undefined || target === targets[0]);
    const replan0 = replanComments
      ? {
          ...replanJobOf(forge, env, words, name, artifact, noteWords, { notAffected: replanOpts.notAffected === true }),
          ...replanComments,
          ...(github && dispatchArg !== undefined ? { dispatch: { argument: dispatchArg } } : {}),
          ...(replies ? { reply: { prefix: `/${words.product}`, others } } : {}),
          ...(replanOpts.notAffected ? { notAffected: true as const } : {}),
        }
      : undefined;
    const replan = replan0 && plan.record ? { ...replan0, post: { ...replan0.post, command: `${replan0.post.command} --record-run ${replan0.jobName}` } } : replan0;
    const record = plan.record ? { env: { [PLAN_RUN_RECORD_ENV]: JSON.stringify({ op: PLAN_RUN_OP, env, labels: { Env: env, Pipeline: "pr", Job: "plan", ...(name ? { Target: name } : {}) } }) } } : undefined;
    const noteBefore = plan.noteSteps?.before ?? [];
    const noteAfter = plan.noteSteps?.after ?? [];
    return {
      ...(name ? { target: name } : {}),
      jobName,
      noteJobName,
      command: fill(plan.command, name),
      env: { ...base, ...shared, ...own },
      ...(target?.writeProbe ? { writeProbe: target.writeProbe } : {}),
      post: { command: post.command, env: postEnv },
      artifact,
      ...(planRunner !== undefined ? { runner: planRunner } : {}),
      ...(noteRunner !== undefined ? { noteRunner } : {}),
      // #4978: a target's plan job plans that target alone, so its checks are `plan:<target>` and `policy:<target>`.
      ...(evidence ? { evidence: planEvidenceOf(forge, evidence, words, jobName, { ...(plan.forks === "skip" ? { noForks: true } : {}), ...(name ? { member: { name, reportPath: PR_LOOP_REPORT_DIR } } : {}) }) } : {}),
      ...(Object.keys(jobEnv).length > 0 ? { jobEnv } : {}),
      ...(login && login.steps.length > 0 ? { login: login.steps } : {}),
      ...(Object.keys(idTokens).length > 0 ? { idTokens } : {}),
      ...(plan.pending && github ? { pending: { context: productStatusContext(words, "plan", name), description: "planning" } } : {}),
      ...(control ? { control } : {}),
      ...(plan.setup?.length ? { setup: plan.setup } : {}),
      ...(plan.report ? { report: fill(plan.report, name) } : {}),
      ...(replan ? { replan } : {}),
      ...(noteBefore.length > 0 || noteAfter.length > 0 ? { noteSteps: { before: noteBefore, after: noteAfter, ...(plan.noteSteps?.pullRequest ? { pullRequest: true as const } : {}) } } : {}),
      ...(record ? { record } : {}),
      ...(tradeSpec ? { trade: tradeSpec } : {}),
      ...(plan.previousMarker && productMarker ? { previous: { marker: prNoteMarker(env, name), name: productMarker } } : {}),
    };
  };
  return targets ? targets.map(one) : [one()];
}

/** The comments the re-plan answers (#4899): the plan command, then the words' aliases for it. Refused when the words name no plan command. */
function replanCommentsOf(words: CiProductWords): { comments: string[]; gated: Array<{ comment: string; when: string }> } {
  const command = commentLine(words, "plan");
  if (!command) throw new Error(`the product plan's replan answers /${words.product} <plan command>, and the words name no plan command; name one in the words' commands, or drop replan`);
  const aliases = words.aliases.filter((a) => a.command === "plan");
  return { comments: [command, ...aliases.filter((a) => a.when === undefined).map((a) => a.from)], gated: aliases.filter((a) => a.when !== undefined).map((a) => ({ comment: a.from, when: a.when! })) };
}

/** The re-plan's jobs for one target (#4899), its comments filled in by the caller. */
function replanJobOf(forge: ForgeKind, env: string, words: CiProductWords, name: string | undefined, artifact: string, noteWords0: Record<string, string>, opts: { notAffected?: boolean } = {}): Omit<ProductPlanReplanJob, "comments" | "gated"> {
  const github = forge !== "gitlab";
  const jobName = github ? (name ? `${REPLAN_JOB}-${name}` : REPLAN_JOB) : name ? `${name}-${REPLAN_JOB}` : REPLAN_JOB;
  const noteJobName = github ? (name ? `${REPLAN_NOTE_JOB}-${name}` : REPLAN_NOTE_JOB) : name ? `${name}-${REPLAN_NOTE_JOB}` : REPLAN_NOTE_JOB;
  // pr-post reads the pull request and the head from the re-plan job, never the comment. GitLab's is GitHub's line with its own --forge.
  const command0 = github ? prLoopPostJob(forge, env, name, words).command : prLoopPostJob("github", env, name, words).command.replace(" --forge github ", " --forge gitlab ");
  // #4963: the argument the re-plan was narrowed to, which pr-post answers "not affected" for when the change does not reach it.
  const command = opts.notAffected ? `${command0} --not-affected "$${PLAN_ARGUMENT_ENV}"` : command0;
  const noteWords = opts.notAffected && github ? { ...noteWords0, [PLAN_ARGUMENT_ENV]: `\${{ needs.${jobName}.outputs.argument }}` } : noteWords0;
  const post = github
    ? {
        command,
        env: {
          PR_NUMBER: `\${{ needs.${jobName}.outputs.pr }}`,
          HEAD_SHA: `\${{ needs.${jobName}.outputs.head }}`,
          PLAN_RESULT: `\${{ needs.${jobName}.result }}`,
          GITHUB_TOKEN: GITHUB_JOB_TOKEN,
          ...noteWords,
        },
      }
    : {
        // GitLab: the merge request from the pipeline's variable, its head again from the remote, and the re-plan job's result from its artifact.
        command: command.replace(' --result "$PLAN_RESULT"', ""),
        env: { PR_NUMBER: `$${GITLAB_REPLAN_PR_VAR}`, ...noteWords },
        setup: ['HEAD_SHA="$(git ls-remote origin "refs/merge-requests/$PR_NUMBER/head" | cut -f1)" && export HEAD_SHA'],
      };
  return { jobName, noteJobName, post, artifact: `${artifact}-replan` };
}

/** The comment re-plan's job and its note job (#4899). */
export const REPLAN_JOB = "replan";
export const REPLAN_NOTE_JOB = "replan-note";

/**
 * The GitLab variables the note-commands job starts a re-plan's pipeline
 * with (#4899): the comment preview's (`CHANT_PREVIEW_PR`,
 * `CHANT_PREVIEW_COMMENT`), so `pr-notes --preview-comment` starts it.
 */
export const GITLAB_REPLAN_PR_VAR = "CHANT_PREVIEW_PR";
export const GITLAB_REPLAN_COMMENT_VAR = "CHANT_PREVIEW_COMMENT";

/** A regular expression's body that matches `text` literally, for a GitLab rule's `/.../`. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

/**
 * The GitLab rule condition that the re-plan pipeline's comment asks for
 * `target` (#4899): the command alone, or with the target's name. Without
 * a target, the command with at most one word after it.
 */
export function gitlabReplanCommentIf(replan: Pick<ProductPlanReplanJob, "comments" | "gated">, target?: string): string {
  const arg = target ? `( +${literal(target)})?` : "( +[A-Za-z0-9_.\\/@+=,:-]+)?";
  const one = (c: string): string => `$${GITLAB_REPLAN_COMMENT_VAR} =~ /^${literal(c)}${arg} *$/`;
  return [...replan.comments.map(one), ...replan.gated.map((g) => `($${g.when} && ${one(g.comment)})`)].join(" || ");
}

/**
 * The re-plan job's first step on GitHub and Forgejo (#4899), with the job's
 * token in its environment alone, before anything is checked out: it reads
 * the comment from the event file (never as an expression in a script),
 * decides whether it asks this job to plan, asks the forge for the pull
 * request (open; from this repository with `forks: "skip"`) and, with
 * `CHANT_REPLAN_PERMISSION` set (Forgejo, whose payload says nothing of the
 * commenter), whether the commenter can write. It writes `go=1`, `pr`,
 * `head`, `base` and `argument` to the step's outputs.
 */
export const REPLAN_DECIDE_JS = replanDecideJs();

/**
 * The re-plan's decision script (#4899) with what `replan`'s options add
 * (#4963). With neither it is {@link REPLAN_DECIDE_JS}, as before.
 *
 * - `dispatch`: on `workflow_dispatch` the pull request is the `pr` input
 *   and the argument the input `CHANT_REPLAN_DISPATCH_ARGUMENT` names;
 *   a `pr` that is not a number, or an argument that is not one plain
 *   word, fails the job. No permission is asked: only a writer dispatches.
 * - `reply`: a comment that starts with `CHANT_REPLAN_PRODUCT` and is not
 *   the plan command, nor one of `CHANT_REPLAN_OTHERS`, a target that is
 *   none of the plan's, and a fork's pull request with `forks: "skip"`
 *   get a reply comment with the reason, once the commenter's permission
 *   is known (Forgejo). A dispatch's reason goes to the log alone.
 */
export function replanDecideJs(opts: { dispatch?: boolean; reply?: boolean } = {}): string {
  const { dispatch = false, reply = false } = opts;
  const replyLine = reply
    ? [
        // The reply, as the product: on a dispatch the log alone.
        `const post=async(t)=>{say(t);${dispatch ? "if(dispatch)return;" : ""}const r=await fetch(api+"/repos/"+repo+"/issues/"+n+"/comments",{method:"POST",headers:{authorization:"token "+process.env.CHANT_REPLAN_TOKEN,accept:"application/json","content-type":"application/json"},body:JSON.stringify({body:product.slice(1)+": "+t})});if(!r.ok)console.error("chant: the reply was not posted: the forge answered "+r.status)};`,
      ]
    : [];
  return [
    'const fs=require("fs");',
    'const say=(m)=>console.log("chant: "+m);',
    'const out=(k,v)=>fs.appendFileSync(process.env.GITHUB_OUTPUT,k+"="+v+"\\n");',
    "let e;try{e=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,\"utf8\"))}catch{say(\"the event file does not read, so nothing is planned again\");process.exit(0)}",
    ...(dispatch ? ['const dispatch=process.env.GITHUB_EVENT_NAME==="workflow_dispatch",inputs=e.inputs&&typeof e.inputs==="object"?e.inputs:{};'] : []),
    'const body=String((e.comment&&e.comment.body)||"").trim();',
    'const cmds=JSON.parse(process.env.CHANT_REPLAN_COMMANDS||"[]");',
    'for(const g of JSON.parse(process.env.CHANT_REPLAN_GATED||"[]")){const v=process.env[g.when]||"";if(v&&v!=="0"&&v!=="false")cmds.push(g.comment)}',
    "let arg;",
    ...(reply ? ['let refusal;const product=process.env.CHANT_REPLAN_PRODUCT||"",others=JSON.parse(process.env.CHANT_REPLAN_OTHERS||"[]");const says=(c)=>body===c||body.startsWith(c+" ")||body.startsWith(c+"\\t");'] : []),
    ...(dispatch
      ? [
          'if(dispatch){const pv=String(inputs.pr==null?"":inputs.pr).trim();if(!pv){say("the dispatch names no pull request");process.exit(0)}if(!/^[1-9][0-9]{0,9}$/.test(pv)){console.error("chant: the dispatch\\u0027s pr input is a pull request number, like 42");process.exit(1)}',
          'const k=process.env.CHANT_REPLAN_DISPATCH_ARGUMENT||"argument",a=String(inputs[k]==null?"":inputs[k]).trim();if(a&&!/^[A-Za-z0-9_.\\/@+=,:-]+$/.test(a)){console.error("chant: the dispatch\\u0027s "+k+" input is one word of letters, digits and _./@+=,:-");process.exit(1)}arg=a}else ',
        ]
      : []),
    'for(const c of cmds){if(body===c){arg="";break}if(body.startsWith(c+" ")){const r=body.slice(c.length).trim();if(/^[A-Za-z0-9_.\\/@+=,:-]+$/.test(r)){arg=r;break}}}',
    reply
      ? 'if(arg===undefined){if(product&&says(product)&&!others.some(says)){refusal="the commands are "+cmds.concat(others).map((c)=>"`"+c+"`").join(", ")}else{say("the comment asks for no plan");process.exit(0)}}'
      : 'if(arg===undefined){say("the comment asks for no plan");process.exit(0)}',
    'const target=process.env.CHANT_REPLAN_TARGET||"",targets=JSON.parse(process.env.CHANT_REPLAN_TARGETS||"[]");',
    reply
      ? 'if(targets.length&&arg&&!targets.includes(arg)){refusal=arg+" is none of "+targets.join(", ")+", so nothing is planned again";arg=""}'
      : 'if(targets.length&&arg&&!targets.includes(arg)){say(arg+" is none of "+targets.join(", ")+", so nothing is planned again");process.exit(0)}',
    'if(targets.length&&arg&&arg!==target){say("the comment plans "+arg+" again, not "+target);process.exit(0)}',
    dispatch
      ? 'const n=dispatch?Number(String(inputs.pr).trim()):e.issue&&e.issue.number;if(!dispatch&&(!Number.isInteger(n)||!(e.issue.pull_request||e.is_pull))){say("the comment is not on a pull request");process.exit(0)}'
      : 'const n=e.issue&&e.issue.number;if(!Number.isInteger(n)||!(e.issue.pull_request||e.is_pull)){say("the comment is not on a pull request");process.exit(0)}',
    'const api=String(process.env.GITHUB_API_URL||"").replace(/\\/+$/,""),repo=process.env.GITHUB_REPOSITORY;',
    'const get=async(p)=>{const r=await fetch(api+"/repos/"+repo+p,{headers:{authorization:"token "+process.env.CHANT_REPLAN_TOKEN,accept:"application/json"}});if(!r.ok)throw new Error(p+" answered "+r.status);return r.json()};',
    ...replyLine,
    "(async()=>{",
    ...(reply
      ? [
          // Who asked comes first: a commenter who cannot write gets no reply.
          `if(process.env.CHANT_REPLAN_PERMISSION${dispatch ? "&&!dispatch" : ""}){const who=e.comment&&e.comment.user&&e.comment.user.login;const p=who?await get("/collaborators/"+encodeURIComponent(who)+"/permission"):{};`,
          'if(!["owner","admin","maintain","write"].includes(p.permission)){say((who||"the commenter")+" cannot write to "+repo+", so nothing is planned again");return}}',
          "if(refusal){await post(refusal);return}",
          'const pr=await get("/pulls/"+n);',
          'if(pr.state!=="open"){say("pull request "+n+" is not open, so it is not planned again");return}',
          'const same=Boolean(pr.head&&pr.head.repo&&pr.head.repo.full_name===repo);',
          'if(!same&&process.env.CHANT_REPLAN_FORKS==="skip"){await post("pull request "+n+" is from a fork, and its code never runs with this repository\\u0027s credentials, so it is not planned again");return}',
        ]
      : [
          'const pr=await get("/pulls/"+n);',
          'if(pr.state!=="open"){say("pull request "+n+" is not open, so it is not planned again");return}',
          'const same=Boolean(pr.head&&pr.head.repo&&pr.head.repo.full_name===repo);',
          'if(!same&&process.env.CHANT_REPLAN_FORKS==="skip"){say("pull request "+n+" is from a fork, and its code never runs with this repository\\u0027s credentials");return}',
          `if(process.env.CHANT_REPLAN_PERMISSION${dispatch ? "&&!dispatch" : ""}){const who=e.comment&&e.comment.user&&e.comment.user.login;const p=who?await get("/collaborators/"+encodeURIComponent(who)+"/permission"):{};`,
          'if(!["owner","admin","maintain","write"].includes(p.permission)){say((who||"the commenter")+" cannot write to "+repo+", so nothing is planned again");return}}',
        ]),
    'const sha=/^[0-9a-f]{40}$/;if(!sha.test(String(pr.head&&pr.head.sha))||!sha.test(String(pr.base&&pr.base.sha)))throw new Error("the pull request names no head or base commit");',
    'out("go","1");out("pr",String(n));out("head",pr.head.sha);out("base",pr.base.sha);out("argument",arg);',
    'say("planning pull request "+n+" again at "+pr.head.sha.slice(0,12)+(arg?" for "+arg:""))',
    '})().catch((err)=>{console.error("chant: the re-plan could not decide: "+(err&&err.message?err.message:String(err)));process.exit(1)});',
  ].join("");
}

/**
 * The previous note's read step on GitHub and Forgejo (#4963): `node -e`,
 * from `/`, with the job's token in `CHANT_PREVIOUS_TOKEN` alone. It pages
 * through pull request `CHANT_PREVIOUS_PR`'s comments for the one whose
 * first line is `CHANT_PREVIOUS_NOTE` (chant's marker), takes its second
 * line's body when it is `<!-- <CHANT_PREVIOUS_NAME> <body> -->` and the
 * body is plain words, and appends `CHANT_PLAN_PREVIOUS_MARKER=<body>` to
 * `$GITHUB_ENV`, empty when there is none. A forge that refuses is a
 * warning: the plan verb plans without it.
 */
export const PREVIOUS_MARKER_JS = [
  'const fs=require("fs");',
  'const api=String(process.env.GITHUB_API_URL||"").replace(/\\/+$/,""),repo=process.env.GITHUB_REPOSITORY,n=process.env.CHANT_PREVIOUS_PR||"";',
  'const note=process.env.CHANT_PREVIOUS_NOTE||"",name=process.env.CHANT_PREVIOUS_NAME||"";',
  'const put=(v)=>fs.appendFileSync(process.env.GITHUB_ENV,"CHANT_PLAN_PREVIOUS_MARKER="+v+"\\n");',
  'const esc=(s)=>s.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&");',
  'const own=new RegExp("^<!-- "+esc(name)+"(?: ([A-Za-z0-9_.,\\\\/@+=:-]+(?: [A-Za-z0-9_.,\\\\/@+=:-]+)*))? -->$");',
  'if(!/^[0-9]+$/.test(n)){console.log("chant: no pull request to read the previous note of");put("");process.exit(0)}',
  "(async()=>{",
  "for(let page=1;page<=50;page++){",
  'const r=await fetch(api+"/repos/"+repo+"/issues/"+n+"/comments?per_page=100&limit=50&page="+page,{headers:{authorization:"token "+process.env.CHANT_PREVIOUS_TOKEN,accept:"application/json"}});',
  'if(!r.ok)throw new Error("the forge answered "+r.status);',
  "const list=await r.json();if(!Array.isArray(list)||list.length===0)break;",
  'for(const c of list){const lines=String(c&&c.body||"").replace(/\\r\\n/g,"\\n").split("\\n");if(lines[0]!==note)continue;const m=own.exec(lines[1]||"");const v=m&&m[1]&&m[1].length<=4096?m[1]:"";put(v);console.log("chant: the previous note"+(v?" carries "+name:" carries no "+name));return}',
  "}",
  'put("");console.log("chant: the pull request has no note yet")',
  '})().catch((err)=>{put("");console.log("chant: the previous note was not read: "+(err&&err.message?err.message:String(err)))});',
].join("");

/** The GitLab re-plan's lines that set {@link PLAN_ARGUMENT_ENV} from the comment's one word after the command (#4899), which the rule already held to plain characters. */
export function gitlabReplanArgumentLines(replan: Pick<ProductPlanReplanJob, "comments" | "gated">): string[] {
  const byLength = [...replan.comments, ...replan.gated.map((g) => g.comment)].sort((a, b) => b.length - a.length);
  return [
    `case "$${GITLAB_REPLAN_COMMENT_VAR}" in ${byLength.map((c) => `"${c}"*) chant_rest="\${${GITLAB_REPLAN_COMMENT_VAR}#"${c}"}" ;;`).join(" ")} *) chant_rest="" ;; esac`,
    `${PLAN_ARGUMENT_ENV}="$(printf '%s' "$chant_rest" | tr -d ' ')" && export ${PLAN_ARGUMENT_ENV}`,
  ];
}

/**
 * The pending step's script on GitHub and Forgejo (#4899): `node -e`, from
 * `/`, posting the plan status pending at `CHANT_PENDING_SHA` with the token
 * in `CHANT_PENDING_TOKEN`. A forge that refuses it is a warning: the note
 * job sets the status the plan ends with.
 */
export const PENDING_JS = [
  'const api=String(process.env.GITHUB_API_URL||"").replace(/\\/+$/,""),repo=process.env.GITHUB_REPOSITORY,sha=process.env.CHANT_PENDING_SHA||"";',
  'if(!/^[0-9a-f]{40}$/.test(sha)){console.log("chant: no commit to say the plan started on");process.exit(0)}',
  'const run=process.env.GITHUB_SERVER_URL&&process.env.GITHUB_RUN_ID?process.env.GITHUB_SERVER_URL+"/"+repo+"/actions/runs/"+process.env.GITHUB_RUN_ID:undefined;',
  'fetch(api+"/repos/"+repo+"/statuses/"+sha,{method:"POST",headers:{authorization:"token "+process.env.CHANT_PENDING_TOKEN,accept:"application/json","content-type":"application/json"},body:JSON.stringify({state:"pending",context:process.env.CHANT_PENDING_CONTEXT,description:process.env.CHANT_PENDING_DESCRIPTION,...(run?{target_url:run}:{})})})',
  '.then((r)=>console.log(r.ok?"chant: "+process.env.CHANT_PENDING_CONTEXT+" is pending":"chant: the forge answered "+r.status+" to the pending status"),(err)=>console.log("chant: the pending status was not posted: "+err.message));',
].join("");

/**
 * The plan step's lines for the plan verb (#4899): the verb, then the
 * report line whatever the verb's exit, then the step exits with the verb's
 * status. Without a report line, the verb alone.
 */
export function planVerbLines(p: Pick<ProductPlanJob, "command" | "report" | "record">): string[] {
  if (!p.report && !p.record) return [p.command];
  return [
    ...(p.record ? ['chant_plan_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"'] : []),
    "chant_plan_exit=0",
    `${p.command} || chant_plan_exit=$?`,
    ...(p.report ? [`${p.report} || echo "chant: the report line exited $?" >&2`] : []),
    // #4899: the run record goes into the hand-off, for the note job to keep on chant/lifecycle.
    ...(p.record ? [`CHANT_PLAN_EXIT="$chant_plan_exit" CHANT_PLAN_STARTED="$chant_plan_started" node -e '${PLAN_RECORD_JS}' ${PR_LOOP_REPORT_DIR} || echo "chant: the plan's run record was not written" >&2`] : []),
    '[ "$chant_plan_exit" -eq 0 ] || exit "$chant_plan_exit"',
  ];
}

/**
 * The plan step's record line (#4899): `node -e`, writing the run record of
 * the plan verb into the directory it is given, {@link PLAN_RUN_RECORD_FILE}.
 * It reads the op, environment and labels from {@link PLAN_RUN_RECORD_ENV},
 * the verb's exit from `CHANT_PLAN_EXIT`, its start from
 * `CHANT_PLAN_STARTED`, and the commit from git. The shape is an
 * `OpRunRecordInput` (../op/runtime.ts) with no run origin, which the note
 * job names.
 */
export const PLAN_RECORD_JS = [
  'const fs=require("fs"),path=require("path"),cp=require("child_process"),crypto=require("crypto");',
  "const c=JSON.parse(process.env.CHANT_PLAN_RECORD||\"{}\"),dir=process.argv[1];",
  'const code=Number(process.env.CHANT_PLAN_EXIT||"1"),ended=new Date().toISOString(),started=new Date(Date.parse(process.env.CHANT_PLAN_STARTED||"")||Date.now()).toISOString();',
  'let sha="";try{sha=cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()}catch{}',
  'const ok=code===0,status=ok?"ok":"fail",ms=Math.max(0,Date.parse(ended)-Date.parse(started));',
  'const rec={id:crypto.randomUUID(),op:c.op,env:c.env,started,ended,status,labels:c.labels||{},outcomes:{},phases:[{name:"plan",status,steps:[{fn:"shellCmd",status,durationMs:ms,...(ok?{}:{error:"command exited "+code})}]}],...(sha?{gitSha:sha}:{}),...(ok?{}:{failure:{code:"command-failed",reason:"the plan verb exited "+code,phase:"plan",exitCode:code}})};',
  `fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"${PLAN_RUN_RECORD_FILE}"),JSON.stringify(rec)+"\\n");`,
].join("");

/**
 * The evidence step of one plan job (#4870), as {@link ProductPlanJob.evidence}.
 * #4964: for a workspace member's pipeline (`member`) the checks are signed
 * as `plan:<member>` and `policy:<member>` (`--member`), and on GitLab the
 * report is read from the plan job's artifact at the member's `reportPath`.
 * #4978: a product plan target's plan job is signed the same way, under the
 * target's name.
 */
export function planEvidenceOf(forge: ForgeKind, evidence: PipelineEvidence, words: CiProductWords, planJob: string, opts: { noForks?: boolean; member?: { name: string; reportPath: string } } = {}): NonNullable<ProductPlanJob["evidence"]> {
  assertPipelineEvidence(evidence);
  const key = evidenceKeyEnv(forge, evidence);
  const bin = words.bin;
  const member = opts.member ? { member: opts.member.name } : {};
  if (forge === "gitlab") {
    // #4914: the job runs in the target branch's plan notes pipeline, before the note job, and signs every open
    // merge request's settled plan job from its artifact; no job of a merge request pipeline holds the key.
    const dir = gitlabOpenEvidenceDir(planJob);
    return {
      jobName: `${planJob}-evidence`,
      lines: openEvidenceLines({ job: planJob, dir: opts.member?.reportPath ?? PR_LOOP_REPORT_DIR, out: dir, ...(bin ? { bin } : {}), ...(opts.noForks ? { noForks: true } : {}), ...member }),
      env: key,
      dir,
      ...(evidenceKeyless(evidence) ? { idTokens: evidenceIdTokens(evidence) } : {}),
    };
  }
  return {
    lines: planEvidenceLines({ dir: PR_LOOP_REPORT_DIR, at: '"$HEAD_SHA"', base: '"$BASE_SHA"', result: '"$PLAN_RESULT"', ...(bin ? { bin } : {}), ...member }),
    env: { HEAD_SHA: "${{ github.sha }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}", PLAN_RESULT: `\${{ needs.${planJob}.result }}`, ...key },
    ...(evidenceKeyless(evidence) ? { idToken: true as const } : {}),
  };
}

/** The GitHub and Forgejo condition that a pull request is from this repository, not a fork (#4799). */
export const SAME_REPOSITORY_IF = "github.event.pull_request.head.repo.full_name == github.repository";

/** The GitLab rule condition that a merge request's source project is the project itself (#4799). */
export const GITLAB_SAME_PROJECT_IF = "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID";
