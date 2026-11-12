/**
 * The product pipeline (#4550): the one chant generator terragucci's and
 * plywood's pull request jobs come from. The two differ only in the words
 * and presets each passes.
 *
 * Under the 2026-10-27 ruling (A, hybrid) the plan side is the pull request
 * loop's: the plan job (`pr-plan`), the plan-note job (`pr-post`) and the
 * comment jobs. The apply on merge runs on op waves: one job per wave, each
 * running `chant run wave`, whose plan and apply steps come from chant's
 * capabilities (#4545 for Terraform, #4541 for Pulumi and plunge). The spec
 * names the steps; this module fills the op and gate names from the words
 * and leaves the steps as the spec gives them.
 *
 * Approvals (ruling B) are a preset: `per-wave` keeps each wave's own digest
 * (terragucci), and `pull-request` lets the pull request's approval apply
 * every wave whose plan its change set covers (plywood), through the op
 * waves' `pull-request` approval source (../op/op-waves.ts).
 *
 * The jobs come back as the descriptors the forge lexicons already
 * serialize (`PrLoopJob`, `OpWaveJob`). A product adds its own jobs to the
 * same map before it writes the file.
 */

import type { ForgeKind } from "../pr-forge";
import { layerWaves } from "../gated-waves";
import { opWaveBinArgv, opWaveJobs, opWavesControlTarget, type OpWave, type OpWaveJob, type OpWavesSpec } from "../op/op-waves";
import { controlNoteCheckout, type ControlNoteCheckout } from "../control/dispatch";
import {
  assertProductWords,
  CHANT_WORDS,
  CI_PRODUCT_COMMANDS,
  commentLine,
  productStatusContext,
  type CiProductApplyMode,
  type CiProductCommand,
  type CiProductWords,
  type CiProductWordsInput,
} from "../ci-product-words";
import { checkJobOptions, PR_LOOP_REPORT_DIR, prActionJob, prCommentLockJobs, prCommentPreviewJob, prLoopJobs, prLoopPostJob, prLoopRunner, prNoteCommandsJob, prStaleJob, withProductBin, type PrActionJob, type PrCommentLockJob, type PrCommentPreviewJob, type PrLoopJob, type PrLoopPipelineOptions } from "./pr-pipeline";
import type { DriverComponent } from "./driver";
import type { OpWavesPipelineOptions, ScheduledOpSpec } from "../lexicon";
import type { CiRunner } from "../ci-jobs";
import { resolveAgentSpec, type OpAgentSpec } from "../ci-agent";
import { resolveCommitSpec, type OpCommitSpec } from "../ci-commit";
import type { CiResponses } from "../ci-respond";
import { planEvidenceOf, productPlanContext, productPlanJobs, productPlanReachLock, type ProductPlanJob, type ProductPlanOptions, type ProductPlanReachLock } from "./product-plan";
import { gitlabOpenEvidenceDir, type PipelineEvidence } from "../ci-evidence-jobs";
import { prCheckJob, prRefGateJob, type PrCheckJob, type PrRefGateJob } from "./pr-checks";
import { COMMENT_JOBS_ENV, PR_COMMENT_JOB, type CommentJobs } from "../ci-comment-commands";
import { GITHUB_JOB_TOKEN } from "../ci-jobs";
import type { OpWavesBeforeMerge } from "../op/before-merge";
import { defaultPipelineFiles, type WavesBeforeMergeJobs } from "../op/before-merge-decide";
import { opWavesDispatchInputs, opWavesInputsRenamed, opWavesNamer, opWavesWorkflowFile, type OpWavesJobNames } from "../op/op-waves-names";
import { opWaveSplitJobs } from "../op/op-waves-split";
import type { PrApplyRequire } from "../pr-requires";
import { LOCK_REACH_ENV } from "../lifecycle/reach-locks";

/** Where the generator writes a product's waves spec, which chant reads at base (#4550). */
export const PRODUCT_WAVES_SPEC_DIR = ".chant/op-waves";

/** The waves spec file of op `name`: `.chant/op-waves/<name>.spec.json`. */
export function productWavesSpecFile(name: string): string {
  return `${PRODUCT_WAVES_SPEC_DIR}/${name}.spec.json`;
}

/** What {@link productPipelineJobs} takes: the pull request loop's options, the words, and the waves the merge applies. */
export interface ProductPipelineOptions extends Omit<PrLoopPipelineOptions, "words" | "waveGate" | "applyOnMerge"> {
  words: CiProductWordsInput | CiProductWords;
  /** The workspace member the pipeline is for. */
  member?: string;
  /**
   * The waves the apply on merge runs, as the product's config maps onto
   * them. Absent: a merge records the plan (the record job), and a release
   * deploys it.
   */
  waves?: OpWavesSpec;
  /** Where the spec is written, from the job's directory. Default {@link productWavesSpecFile}. */
  wavesSpecFile?: string;
  /**
   * The product runs an agent job that answers its agent command (#4616):
   * `true` for the defaults, or the agent's settings. The pipeline then
   * returns the agent's Op spec, which the product writes and generates with
   * `chant run --generate <forge> --spec <file>` as it does its other
   * scheduled Ops.
   */
  agent?: boolean | ProductAgentOptions;
  /**
   * The product's commit jobs (#4722) that answer a comment: each one's
   * `word` maps onto `commit` in the words, and `/<product> <word>` runs its
   * command on the pull request's head and pushes the change. The pipeline
   * returns each one's Op spec, which the product writes and generates as
   * it does the agent's. A commit job after a check rides on the check's own
   * Op spec instead ({@link productCheckCommit}).
   */
  commits?: ProductCommitOptions[];
  /**
   * The product answers its `action` command (#4654) from a workflow of its
   * own, such as terragucci's action workflow: `true` counts the command as
   * answered, so words that map a word onto `action` are not refused, and
   * `comments.action` names the comment. The pipeline writes no job for it.
   * A product with no workflow of its own sets `actionJob` instead, and the
   * pipeline writes the job ({@link ProductPipelineJobs.action}).
   */
  actions?: boolean;
  /**
   * The apply on merge from the component graph (#4588), when `waves` is
   * absent: the spec `pr-apply --wave-gate` runs, a wave per layer of
   * `components`, each run a component planned and applied through the
   * component plan-wave and apply-wave steps, a wave whose plan the approval
   * does not cover waiting at `<waveGate>-wave-<k>`. `base` is what the
   * steps measure the change from, by default `HEAD^1`, the commit before
   * the merge.
   */
  componentWaves?: { components: readonly Pick<DriverComponent, "name" | "dependsOn">[]; waveGate?: string; base?: string };
  /**
   * The responses to pipeline events (#4629, `../ci-respond.ts`): a refused
   * wave's diff and a failed apply's triage, on by default, and the
   * description check, off by default. The apply jobs carry them as
   * `CHANT_RESPOND`, the waves spec as its `respond`.
   */
  respond?: CiResponses;
  /**
   * The decide service the description check asks (#4629): a
   * `decide.backends` entry of chant.config at the target branch, and the
   * pinned model. Needed with `respond.description: "check"`.
   */
  decide?: { backend: string; model: string };
  /**
   * The product's own plan verb in place of `chant components pr-plan`
   * (#4799, the 2026-11-09 amendment of #4550 ruling A: "pr-plan or the
   * product's plan verb"): one plan job per target, each with only that
   * target's variables and secrets, and a plan-note job that posts the
   * `PrReport` or plan note hand-off the verb wrote ({@link ProductPlanOptions}).
   * The jobs come back as {@link ProductPipelineJobs.productPlan}, and the
   * forge lexicons' `generateProductPlanPipeline` renders them. Absent: the
   * plan job runs `pr-plan`, as before.
   */
  productPlan?: ProductPlanOptions;
  /**
   * The pipeline's runner identity (#4870): the secret holding the runner
   * key `.chant/trust.json` lists. The product plan's jobs then sign the
   * plan job's `plan` and `policy` checks ({@link ProductPlanJob.evidence}).
   * Absent: nothing is signed, and the jobs are as before.
   */
  evidence?: PipelineEvidence;
  /**
   * The comment job (#4946), GitHub and Forgejo: one job on every
   * `/<product>` comment (and every alias's) that answers what no other job
   * of the pipeline takes, with `chant components pr-comment`: a refusal,
   * a command the pipeline has no job for (the words' `replies`, else
   * chant's), and with waves on merge the re-run of a merged pull request's
   * apply. The jobs it leaves comments to are the ones these options write.
   * On GitLab the note-commands job answers every note already; refused
   * there. `{ jobName }` (#5027) names the job, such as terragucci's
   * `apply-comment`. Default `comment`.
   */
  commentJob?: boolean | ProductCommentJobOptions;
  /**
   * GitLab's note poll under the product's names (#5038), with
   * `noteCommands`: its job's name (default `note-commands`), its stage
   * (default the job's name), and the variable and value a pipeline
   * schedule starts it with (default `CHANT_NOTE_COMMANDS` and `1`), such
   * as terragucci's `comments` job, which `TERRAGUCCI_SCHEDULE=comments`
   * starts. Its resource group is its name. Refused on GitHub and Forgejo,
   * whose comment job is `commentJob`.
   */
  noteCommandsJob?: ProductNoteCommandsJobOptions;
  /**
   * The waves' job names (#5027), the Op waves generators' `jobNames`
   * (#5022): `waves.pipeline` carries them to the generator, `waves.jobs`
   * takes them, and the comment job's re-run of a merged pull request's
   * apply looks for the jobs under them (`CHANT_COMMENT_JOBS`
   * `applyJobs`). Absent: chant's names, and the re-run looks for
   * `RERUN_APPLY_JOBS`. Needs `waves` (or `componentWaves`).
   */
  wavesJobNames?: OpWavesJobNames;
  /**
   * Waves before merge (#4984, maintainer decision 2026-11-10): `/<product>
   * apply [wave-<n>]` on an open pull request runs the waves on its head.
   * The comment job (GitHub, Forgejo; needs `commentJob`) or the note poll
   * (GitLab; needs `noteCommands`) decides it by the product plan's rules
   * (../op/before-merge-decide.ts): this repository's pull request into the
   * default branch, its head unmoved, `requires` met, every plan status
   * passed on the head, none of `pipelineFiles` touched, and with the
   * product plan's `reach` the locks at stage apply. It records the head
   * and the decision's digest on `chant/lifecycle` and starts the waves
   * workflow for it, whose guard admits that head alone. After the last
   * wave, `merge: "auto"` merges the pull request at that head and releases
   * its locks. Needs `waves` (or `componentWaves`).
   */
  wavesBeforeMerge?: ProductWavesBeforeMerge;
  /**
   * The apply statuses (#4987): the waves workflow posts `<product>/apply`
   * (`<product>/apply/<member>` for a member) on the commit the waves
   * applied, from a job after each wave that runs none of the change's
   * code (`@intentius/chant/op/apply-status`): pending after each wave,
   * success after the last, failed when a run failed. Needs `waves` (or
   * `componentWaves`); the product passes `waves.pipeline` on when it
   * renders them.
   */
  applyStatus?: boolean;
}

/** {@link ProductPipelineOptions.wavesBeforeMerge} (#4984). */
export interface ProductWavesBeforeMerge {
  /** The requires the forge is asked before the apply (`apply.requires`). Default every one: approved, mergeable, undiverged, checks. */
  requires?: PrApplyRequire[];
  /** `auto`: merge after the last wave, and release the locks. `manual` (default): reply that it is ready. */
  merge?: "auto" | "manual";
  /** The merge token's secret or CI/CD variable, with `merge: "auto"` (needed on Forgejo and GitLab). */
  mergeTokenSecret?: string;
  /** The forge environment the merge job runs in, which the merge token is scoped to (#5037; GitHub and GitLab). `waves.pipeline` carries it as the generator's `beforeMerge.environment`. */
  environment?: string;
  /** Paths a change may not touch to apply before merge; one ending in `/` is a directory. Default the forge's workflow directory and `.chant/op-waves/`. */
  pipelineFiles?: string[];
  /**
   * GitHub and Forgejo (#5022): the workflow the waves are in, which the
   * comment job dispatches, such as `terragucci.yml`. Default `<op>.yml`.
   * The product passes `waves.pipeline` on, which carries it as the
   * generator's `workflowFile`.
   */
  workflowFile?: string;
  /**
   * GitHub and Forgejo (#5022): the waves workflow's names of the inputs
   * `pr`, `head` and `digest`, which the comment job dispatches with, so
   * they never meet the product's own. `waves.pipeline` carries them as
   * the generator's `dispatchInputs`. Default chant's.
   */
  dispatchInputs?: Partial<Record<"pr" | "head" | "digest", string>>;
}

/** {@link ProductPipelineOptions.noteCommandsJob} (#5038). */
export interface ProductNoteCommandsJobOptions {
  /** The job's name, such as `comments`. Default `note-commands`. */
  jobName?: string;
  /** Its stage. Default the job's name. */
  stage?: string;
  /** The variable and value a pipeline schedule starts it with, such as `{ variable: "TERRAGUCCI_SCHEDULE", value: "comments" }`. Default `CHANT_NOTE_COMMANDS` and `1`. */
  schedule?: { variable: string; value: string };
}

/** {@link ProductPipelineOptions.commentJob}'s settings (#5027). */
export interface ProductCommentJobOptions {
  /** The comment job's name in the workflow, such as `apply-comment`. Default {@link PR_COMMENT_JOB}. */
  jobName?: string;
}

/** The comment job (#4946): its command, the values it reads, and the comment prefixes that start it. */
export interface ProductCommentJob {
  /** {@link PR_COMMENT_JOB}, or the product's `commentJob.jobName` (#5027). */
  jobName: string;
  /** `<bin> components pr-comment --forge <forge>`. */
  command: string;
  /** `GITHUB_TOKEN` and {@link COMMENT_JOBS_ENV}. */
  env: Record<string, string>;
  /** What a comment starts with for the job to start: `/<product>`, then each alias. */
  prefixes: string[];
  /** The jobs it leaves comments to. */
  jobs: CommentJobs;
  runner?: CiRunner;
}

/** The jobs of one product pipeline. */
export interface ProductPipelineJobs {
  /** The words, every slot filled and checked. */
  words: CiProductWords;
  /** The plan job: `pr-plan` with the words. */
  plan: PrLoopJob;
  /**
   * The plan-note job: `pr-post`. With a control repo named on the loop's
   * `control` or the waves spec's (#4619), `control` is the step the note
   * job runs before `pr-post`: a read-only fetch of the control repo's
   * `chant/lifecycle` that sets `CHANT_CONTROL_DIR`, so the note marks the
   * cross-stack edges.
   */
  post: { command: string; env: Record<string, string>; control?: ControlNoteCheckout; runner?: CiRunner; evidence?: ProductPlanJob["evidence"] };
  /** The record job, when no waves apply on merge. */
  record?: PrLoopJob;
  /** The apply before merge, answering the apply comment, with `applyBeforeMerge`. */
  applyBeforeMerge?: PrLoopJob;
  /** The comment each command answers, `/<product> <word>`, for the commands the pipeline has a job for. */
  comments: Partial<Record<CiProductCommand, string>>;
  /**
   * The apply on merge: the spec with the words' names, its file, and a job
   * per wave (per share or group). With `wavesBeforeMerge` (#4984),
   * `beforeMerge` is the generators' `OpWavesPipelineOptions.beforeMerge`:
   * the product passes it on when it renders the waves.
   */
  waves?: {
    spec: OpWavesSpec;
    specFile: string;
    jobs: OpWaveJob[];
    beforeMerge?: OpWavesBeforeMerge;
    /**
     * What the generators take from the pipeline (#4987): `beforeMerge`,
     * `applyStatus` and, with `staleNotes`, the stale marking job that runs
     * beside wave 1 on a push (one `--member` per product plan target). The
     * product spreads it into the `OpWavesPipelineOptions` it renders with.
     * #5022: with them, `wavesBeforeMerge`'s `workflowFile` and
     * `dispatchInputs`, which the comment job dispatches by.
     */
    pipeline: Pick<OpWavesPipelineOptions, "beforeMerge" | "applyStatus" | "staleNotes" | "workflowFile" | "dispatchInputs" | "jobNames">;
  };
  /**
   * The comment lock and unlock jobs (#4588), under `locks: "plan"`:
   * `/<product> lock` keeps the locks the plan took, `/<product> unlock`
   * releases them. The forge lexicons render the same jobs.
   */
  locks?: Array<PrCommentLockJob & { runner?: CiRunner }>;
  /**
   * The comment preview (#4620), with `previewComment`: `/<product> <plan
   * word>` plans the pull request's head again with a read token, and the
   * job after it posts the note. The forge lexicons render the same jobs.
   */
  preview?: PrCommentPreviewJob & { noteRunner?: CiRunner };
  /**
   * The stale marking (#4628), with `staleNotes`: the command and values of
   * the job that runs on a push to the target branch and marks each open
   * pull request's note posted against another commit stale. The forge
   * lexicons render the same job, `stale-notes`.
   */
  stale?: { command: string; env: Record<string, string>; runner?: CiRunner };
  /**
   * GitLab's comment commands (#4785), with `noteCommands`: the command of
   * the `note-commands` job, which a schedule starts with
   * `CHANT_NOTE_COMMANDS=1` on the target branch. It polls the merge
   * requests' notes and starts the jobs the commands ask for. The GitLab
   * lexicon renders the same job from `chant build --pr-loop
   * --note-commands`. Refused on GitHub and Forgejo.
   */
  noteCommands?: { command: string; runner?: CiRunner; env?: Record<string, string>; jobName?: string; stage?: string; schedule?: { variable: string; value: string } };
  /**
   * The agent (#4616), with `agent`: the comment it answers, `/<product>
   * agent <ask>`, and the scheduled Op spec whose generated workflow runs
   * it: the agent job with a read token and the model's key, and the push
   * job with the write token.
   */
  agent?: { comment: string; name: string; spec: ScheduledOpSpec };
  /** The comment commit jobs (#4722), with `commits`: each one's comment, `/<product> <word>`, and the Op spec whose generated workflow runs it. */
  commits?: Array<{ comment: string; name: string; spec: ScheduledOpSpec }>;
  /**
   * The action job (#4654), with `actionJob`: the comment and the dispatch
   * inputs it answers, and the product's action verb it runs. The GitHub and
   * Forgejo lexicons render the same job.
   */
  action?: PrActionJob & { runner?: CiRunner };
  /** The product plan's jobs (#4799), with `productPlan`: a plan job and a plan-note job per target. */
  productPlan?: ProductPlanJob[];
  /**
   * The check job (#4935), with `checkJob`: `chant ci check` on the pull
   * request's commit through the words' bin, and with `evidence` the
   * `check-evidence` job's lines that sign each passed hook from its report
   * (./pr-checks.ts). The forge lexicons render the same jobs.
   */
  check?: PrCheckJob & { runner?: CiRunner; evidenceRunner?: CiRunner };
  /** The ref gate's status job (#4935), with `refGateStatus` (./pr-checks.ts). */
  refGate?: PrRefGateJob & { runner?: CiRunner };
  /** The comment job (#4946), with `commentJob`. */
  comment?: ProductCommentJob;
  /**
   * The reach lock job (#4979), with `locks: "plan"` and the product plan's
   * `reach`: `chant lock --reach`, in place of the lock jobs that read a
   * `PrReport`. The forge lexicons render it.
   */
  reachLock?: ProductPlanReachLock;
}

/** An agent's settings as a product passes them (#4616): {@link OpAgentSpec} without the trigger, which the pipeline names. */
export interface ProductAgentOptions extends Omit<OpAgentSpec, "on" | "comment" | "branch"> {
  /** The agent's name: its workflow, its jobs and its runs on the ledger. Default `<product>-agent`. */
  name?: string;
  /** Where its jobs run. */
  runner?: CiRunner;
}

/** A comment commit job as a product passes it (#4722): {@link OpCommitSpec} without the trigger, with the word it answers. */
export interface ProductCommitOptions extends Omit<OpCommitSpec, "on" | "comment" | "findings" | "gitlabCheck"> {
  /** The word after `/<product>`, which the words map onto `commit`: `fmt` for `/terragucci fmt`. */
  word: string;
  /** The job's name: its workflow, its jobs and its runs on the ledger. Default `<product>-<word>`. */
  name?: string;
  runner?: CiRunner;
}

/** A comment commit job's Op spec (#4722). The settings are checked here, so a product finds a bad one when it generates. */
export function productCommitSpec(wordsIn: CiProductWordsInput | CiProductWords, options: ProductCommitOptions): ScheduledOpSpec {
  const words = assertProductWords(wordsIn);
  const { word, name: given, runner, ...settings } = options;
  if (words.commands[word] !== "commit") throw new Error(`the commit job's word ${JSON.stringify(word)} is not a command the words map onto commit`);
  const name = given ?? `${words.product}-${word}`;
  const commit: OpCommitSpec = { on: "comment", comment: `/${words.product} ${word}`, ...settings };
  resolveCommitSpec(name, commit, words.product);
  return { name, trigger: { kind: "pull_request" }, commit, ...(runner !== undefined ? { runner } : {}) };
}

/**
 * The `commit` of a check's Op spec (#4722): after the check's run exits
 * with one of `findings` on a pull request, the command runs on the head
 * and its change is pushed to the pull request's branch. The check's spec
 * needs a `pull_request` trigger.
 */
export function productCheckCommit(wordsIn: CiProductWordsInput | CiProductWords, op: string, options: Omit<OpCommitSpec, "on" | "comment">): OpCommitSpec {
  const words = assertProductWords(wordsIn);
  const commit: OpCommitSpec = { on: "check", ...options };
  resolveCommitSpec(op, commit, words.product);
  return commit;
}

/** The agent's Op spec for `/<product> agent <ask>` (#4616). The settings are checked here, so a product finds a bad one when it generates. */
export function productAgentSpec(wordsIn: CiProductWordsInput | CiProductWords, comment: string, options: ProductAgentOptions = {}): ScheduledOpSpec {
  const words = assertProductWords(wordsIn);
  const { name: given, runner, ...settings } = options;
  const name = given ?? `${words.product}-agent`;
  const agent: OpAgentSpec = { on: "comment", comment, ...settings };
  resolveAgentSpec(name, agent, words.product);
  return { name, trigger: { kind: "pull_request" }, agent, ...(runner !== undefined ? { runner } : {}) };
}

/**
 * The `agent` of a scheduled drift Op (#4616): after the Op's run exits with
 * chant's `drift` code, the agent changes the code to say what is live and
 * opens or updates a pull request from `<product>/agent/<op>`.
 */
export function productDriftAgent(wordsIn: CiProductWordsInput | CiProductWords, op: string, options: Omit<OpAgentSpec, "on" | "comment"> = {}): OpAgentSpec {
  const words = assertProductWords(wordsIn);
  const agent: OpAgentSpec = { on: "drift", ...options };
  resolveAgentSpec(op, agent, words.product);
  return agent;
}

/**
 * The waves spec with the product's names (#4550): the op the gates are
 * recorded under, the wave gate pattern, and under the `pull-request`
 * preset each wave's approval taken from the pull request's gate. A wave
 * that names its own approval keeps it. Nothing else changes, so the plan
 * and apply steps stay the capability steps the spec names.
 */
export function productWavesSpec(spec: OpWavesSpec, wordsIn: CiProductWordsInput | CiProductWords): OpWavesSpec {
  const words = assertProductWords(wordsIn);
  const byPullRequest = words.approval === "pull-request";
  return {
    ...spec,
    name: words.op ?? spec.name,
    ...(words.gateName !== CHANT_WORDS.gateName ? { gateName: words.gateName } : {}),
    waves: spec.waves.map((w): OpWave => (byPullRequest && w.approval === undefined ? { ...w, approval: "pull-request" } : w)),
    ...(byPullRequest ? { approvals: { ...(spec.approvals ?? {}), pullRequest: { gate: words.prGate } } } : {}),
  };
}

/**
 * The product pipeline's jobs for `forge` (#4550): the plan side from the
 * pull request loop with the words, and the apply on merge on op waves. The
 * words are refused when a command names a job the pipeline does not have.
 */
export function productPipelineJobs(forge: ForgeKind, env: string, options: ProductPipelineOptions): ProductPipelineJobs {
  const jobs: CiProductCommand[] = ["plan"];
  if (options.applyBeforeMerge || options.waves || options.componentWaves) jobs.push("apply");
  if (options.locks === "plan") jobs.push("lock", "unlock");
  if (options.agent) jobs.push("agent");
  if (options.commits?.length) jobs.push("commit");
  // #4654: the action command, answered by the product's own workflow (`actions`) or by the pipeline's action job.
  if (options.actions || options.actionJob) jobs.push("action");
  // #4601: the note's merge sentence follows the jobs built here: waves on merge, an apply before merge, else a record for a release.
  // Words that ask for before-merge keep it when the pipeline has that job beside its waves.
  const built: CiProductApplyMode = options.waves || options.componentWaves ? "on-merge" : options.applyBeforeMerge ? "before-merge" : "release";
  const applyMode: CiProductApplyMode = options.words.applyMode === "before-merge" && options.applyBeforeMerge ? "before-merge" : built;
  // #4946: the comment job answers every command but a commit word (the commit job's) with a reply, so the words may name any.
  const answered: CiProductCommand[] = options.commentJob ? [...new Set<CiProductCommand>([...jobs, ...CI_PRODUCT_COMMANDS.filter((c) => c !== "commit")])] : jobs;
  const words = assertProductWords({ ...options.words, applyMode }, { jobs: answered });
  const { waves: given, wavesSpecFile, member, agent: _agent, commits: _commits, actions: _actions, componentWaves, productPlan, evidence, commentJob: _commentJob, wavesBeforeMerge, applyStatus: _applyStatus, wavesJobNames, noteCommandsJob, ...loop } = options;
  if (options.applyStatus && !given && !componentWaves) throw new Error("applyStatus posts the waves' apply statuses, and there are none: give waves (or componentWaves)");
  const { respond } = options;
  // #4629: the pull request loop puts the responses on the apply and note jobs, as `chant build --pr-loop --respond` does.
  const prLoop: PrLoopPipelineOptions = { ...loop, words, gate: options.gate ?? words.prGate };
  const [plan, apply, record] = prLoopJobs(forge, env, prLoop, member);
  // #4625: the jobs with no stage of their own run on the default runner.
  const runnerOfDefault = prLoopRunner(options, "default");
  const defaultRunner: { runner?: CiRunner } = runnerOfDefault !== undefined ? { runner: runnerOfDefault } : {};
  const comments: Partial<Record<CiProductCommand, string>> = {};
  for (const c of jobs) {
    const line = commentLine(words, c);
    if (line) comments[c] = line;
  }
  // #4619: the loop's control target, else the waves spec's.
  const controlTarget = options.control?.target ?? (given?.control ? opWavesControlTarget(given.control) : undefined);
  const post0 = prLoopPostJob(forge, env, member, words, { ...(options.staleNotes ? { staleNotes: true } : {}), ...(respond ? { respond } : {}), ...(options.decide ? { decide: options.decide } : {}) });
  // #4914: on GitLab the signing job of the plan notes pipeline keeps each merge request's evidence, which the note reads.
  const post = evidence && forge === "gitlab" ? { ...post0, command: `${post0.command} --evidence-dir ${gitlabOpenEvidenceDir(plan!.jobName)}` } : post0;
  const out: ProductPipelineJobs = {
    words,
    plan: plan!,
    // #4870: the note job signs the plan job's plan and policy checks before it posts; #4964: a member's under its name.
    post: { ...post, ...(controlTarget ? { control: controlNoteCheckout(forge, controlTarget, words) } : {}), ...defaultRunner, ...(evidence ? { evidence: planEvidenceOf(forge, evidence, words, plan!.jobName, member ? { member: { name: member, reportPath: PR_LOOP_REPORT_DIR } } : {}) } : {}) },
    comments,
    ...(options.applyBeforeMerge ? { applyBeforeMerge: apply! } : {}),
    // #4799: the product's plan verb, a plan job and a note job per target.
    ...(productPlan ? { productPlan: productPlanJobs(forge, env, { ...prLoop, plan: productPlan }, words, evidence) } : {}),
  };
  // #4935: the check job runs the change's code on the plan runner; the signing and the status run on the default one.
  // #4964: with the product's own services, variables, lines and report directory.
  const checkOptions = checkJobOptions(options.checkJob);
  if (checkOptions) {
    const planRunner = prLoopRunner(options, "plan");
    out.check = { ...prCheckJob(forge, { ...checkOptions, ...(words.bin ? { bin: words.bin } : {}), ...(evidence ? { evidence } : {}), ...(productPlan?.forks === "skip" ? { noForks: true } : {}) }), ...(planRunner !== undefined ? { runner: planRunner } : {}), ...(runnerOfDefault !== undefined ? { evidenceRunner: runnerOfDefault } : {}) };
  }
  if (options.refGateStatus) out.refGate = { ...prRefGateJob(forge, { ...(words.bin ? { bin: words.bin } : {}), ...(options.branch ? { branch: options.branch } : {}) }), ...defaultRunner };
  const locks = prCommentLockJobs(forge, { locks: options.locks, words });
  if (locks.length > 0) out.locks = locks.map((job) => ({ ...job, ...defaultRunner }));
  // #4979: the product plan's reach says what the lock job locks.
  const reachLock = productPlan ? productPlanReachLock(forge, { ...prLoop, plan: productPlan }, words) : undefined;
  if (reachLock) out.reachLock = reachLock;
  const action = prActionJob(forge, prLoop);
  if (action) out.action = { ...action, ...(prLoopRunner(options, "apply") !== undefined ? { runner: prLoopRunner(options, "apply")! } : {}) };
  // #4987: a product plan's notes are marked from the waves workflow's push run, one --member per target, naming the re-plan comment.
  // #5003: with the product's status context, the stale job sets that status back to pending, one a target.
  const planContexts = productPlan?.statusContext !== undefined ? out.productPlan!.map((p) => productPlanContext(p, words)) : undefined;
  const planStale = productPlan
    ? prStaleJob(forge, env, { ...prLoop, ...(productPlan.replan ? { previewComment: true } : {}) }, productPlan.targets?.map((t) => t.name) ?? member, planContexts)
    : undefined;
  if (planStale && !options.waves && !options.componentWaves) throw new Error("staleNotes with the product plan marks the notes from the waves workflow's push run, beside wave 1, and there are no waves: give waves (or componentWaves), or drop staleNotes");
  const stale = productPlan ? undefined : prStaleJob(forge, env, prLoop, member);
  if (stale) out.stale = { ...stale, ...defaultRunner };
  // #4785: GitLab's comment commands, polled from the notes; waves on merge are retried by an apply on a merged merge request.
  // #4899: the product plan's comment re-plan runs in the preview's pipeline, so the poll starts it as it starts a preview.
  const notes = prNoteCommandsJob(forge, { ...prLoop, ...(options.waves || options.componentWaves ? { applyOnMerge: true } : {}), ...(productPlan?.replan ? { previewComment: true } : {}) });
  if (notes) out.noteCommands = { ...notes, ...defaultRunner, ...noteCommandsNames(forge, noteCommandsJob) };
  else if (noteCommandsJob !== undefined) throw new Error(forge === "gitlab" ? "noteCommandsJob names the note poll, and there is none: set noteCommands" : `noteCommandsJob names GitLab's note poll; on ${forge} the comment job (commentJob) answers comments`);
  const preview = prCommentPreviewJob(forge, env, prLoop, member);
  if (preview) out.preview = { ...preview, ...(defaultRunner.runner !== undefined ? { noteRunner: defaultRunner.runner } : {}) };
  // #4616: the agent answers its comment from a workflow of its own, generated from this spec.
  const agentComment = options.agent ? comments.agent : undefined;
  if (options.agent && agentComment) {
    const spec = productAgentSpec(words, agentComment, options.agent === true ? {} : options.agent);
    out.agent = { comment: agentComment, name: spec.name, spec };
  }
  // #4722: each comment commit job answers its own word from a workflow of its own.
  if (options.commits?.length) {
    out.commits = options.commits.map((c) => {
      const spec = productCommitSpec(words, c);
      return { comment: spec.commit!.comment!, name: spec.name, spec };
    });
  }
  // #4588: without a spec of the product's own, the component graph's waves on op waves.
  const op = words.op ?? componentWaves?.waveGate ?? words.prGate;
  const spec = given ?? (componentWaves
    ? componentWavesSpec(componentWaves.components, words, componentWaveSteps({ ...(words.bin ? { bin: words.bin } : {}), env, base: componentWaves.base ?? "HEAD^1", ...(member ? { member } : {}), op, gate: prLoop.gate }), { ...(componentWaves.waveGate ? { gate: componentWaves.waveGate } : {}) })
    : undefined);
  // #4984: the waves before merge: the comment job (the note poll on GitLab) decides an open pull request's apply and starts them.
  const wavesOp = spec ? (words.op ?? spec.name) : undefined;
  let bmJobs: WavesBeforeMergeJobs | undefined;
  if (wavesBeforeMerge) {
    if (!spec || !wavesOp) throw new Error("wavesBeforeMerge runs the waves on an open pull request's head, and there are none: give waves (or componentWaves)");
    if (options.applyBeforeMerge) throw new Error("wavesBeforeMerge and applyBeforeMerge both answer an open pull request's apply; give one");
    if (forge === "gitlab" ? !options.noteCommands : !options.commentJob) throw new Error(`wavesBeforeMerge is decided by ${forge === "gitlab" ? "the note poll: set noteCommands" : "the comment job: set commentJob"}`);
    const targets = productPlan?.targets?.map((t) => t.name);
    if (forge === "gitlab" && (wavesBeforeMerge.workflowFile !== undefined || wavesBeforeMerge.dispatchInputs !== undefined)) throw new Error("wavesBeforeMerge.workflowFile and dispatchInputs name a GitHub or Forgejo workflow; GitLab's note poll starts a pipeline with variables");
    // #5022: the product's workflow and input names, checked as the generator checks them.
    const workflowFile = opWavesWorkflowFile({ name: wavesOp }, wavesBeforeMerge.workflowFile);
    const dispatchInputs = wavesBeforeMerge.dispatchInputs ? opWavesDispatchInputs(wavesBeforeMerge.dispatchInputs) : undefined;
    bmJobs = {
      ...(forge !== "gitlab" ? { workflow: workflowFile } : {}),
      ...(dispatchInputs && opWavesInputsRenamed(dispatchInputs) ? { inputs: { pr: dispatchInputs.pr, head: dispatchInputs.head, digest: dispatchInputs.digest } } : {}),
      ...(wavesBeforeMerge.requires ? { requires: [...wavesBeforeMerge.requires] } : {}),
      // #5003: the product's own status contexts, when it named them.
      plan: planContexts ?? (targets?.length ? targets.map((t) => productStatusContext(words, "plan", t)) : [productStatusContext(words, "plan", member)]),
      pipelineFiles: wavesBeforeMerge.pipelineFiles ?? defaultPipelineFiles(forge),
      ...(productPlan?.reach ? { locks: { ...(productPlan.reach.gate ? { gate: productPlan.reach.gate } : {}) } } : {}),
    };
  }
  // #4984: GitLab's note poll writes a wave stop for a merged merge request, and decides the waves before merge.
  if (out.noteCommands && spec && wavesOp) {
    out.noteCommands = {
      ...out.noteCommands,
      env: {
        [COMMENT_JOBS_ENV]: JSON.stringify({ waves: { op: wavesOp, count: spec.waves.length }, ...(bmJobs ? { wavesBeforeMerge: bmJobs } : {}) }),
        ...(bmJobs && productPlan?.reach ? { [LOCK_REACH_ENV]: productPlan.reach.command } : {}),
      },
    };
  }
  const wavesRespond = respond ? Object.fromEntries(Object.entries(respond).filter(([e]) => e !== "description")) : {};
  // #4625: the waves run on the apply runner and with the plan's parallelism, unless the spec names its own.
  const applyRunner = prLoopRunner(options, "apply");
  const named = spec
    ? {
        ...productWavesSpec(
          {
            ...spec,
            ...(spec.runner === undefined && applyRunner !== undefined ? { runner: applyRunner } : {}),
            ...(spec.parallelism === undefined && options.parallelism !== undefined && spec.step !== undefined ? { parallelism: options.parallelism } : {}),
          },
          words,
        ),
        ...(Object.keys(wavesRespond).length > 0 ? { respond: { ...(spec.respond ?? {}), ...wavesRespond } } : {}),
      }
    : undefined;
  const specFile = named ? (wavesSpecFile ?? productWavesSpecFile(named.name)) : undefined;
  if (wavesJobNames !== undefined && !named) throw new Error("wavesJobNames names the waves' jobs, and there are none: give waves (or componentWaves)");
  // #5027: the waves' jobs under the product's names, the same the generator gives them from the same jobNames.
  const waveJobs = named && specFile ? opWaveJobs(named, specFile, { bin: words.bin, ...(wavesBeforeMerge ? { beforeMerge: true } : {}) }) : undefined;
  const namedWaveJobs = waveJobs && wavesJobNames ? opWavesNamer(named!, forge, wavesJobNames).jobs(waveJobs) : waveJobs;
  // #4946: the comment job answers what no other job of the pipeline takes, so it is told which jobs there are.
  if (options.commentJob) {
    // #4963's re-plan reply answers the same stray comments, so one of the two answers them.
    if (typeof productPlan?.replan === "object" && productPlan.replan.reply) throw new Error("commentJob answers every /<product> comment no other job takes, and so does the product plan's replan.reply; drop replan.reply, since the comment job answers the re-plan's refusals too");
    // The product plan's re-plan skips a target that is none of its own and, with forks: "skip", a fork's pull request without a word; the comment job says why.
    const planTargets = productPlan?.replan ? productPlan.targets?.map((t) => t.name) : undefined;
    const commentJobs: CommentJobs = {
      ...(productPlan?.replan || options.previewComment ? { preview: true } : {}),
      ...(planTargets?.length ? { targets: planTargets } : {}),
      ...(productPlan?.replan && productPlan.forks === "skip" ? { skipForks: true } : {}),
      ...(options.applyBeforeMerge ? { applyBeforeMerge: true } : {}),
      ...(given || componentWaves ? { applyOnMerge: true } : {}),
      // #4979: the waves' op (the name productWavesSpec gives them) and count, so a wave-<n> stops a re-run after wave n.
      ...(spec ? { waves: { op: words.op ?? spec.name, count: spec.waves.length } } : {}),
      ...(bmJobs ? { wavesBeforeMerge: bmJobs } : {}),
      // #4979: the product plan's re-plan takes no flags, so the comment job answers a plan comment that carries them.
      ...(productPlan?.replan ? { noPlanFlags: true } : {}),
      ...(locks.length > 0 ? { locks: true } : {}),
      ...(out.agent ? { agent: true } : {}),
      ...(out.commits ? { commits: true } : {}),
      ...(options.actions || options.actionJob ? { actions: true } : {}),
      // #5027: a re-run looks for the waves' jobs by the product's names; without them, by chant's pattern.
      ...(namedWaveJobs && wavesJobNames ? { applyJobs: productApplyJobs(named!, waveJobs!, namedWaveJobs, forge, wavesJobNames, wavesBeforeMerge !== undefined) } : {}),
    };
    const comment = productCommentJob(forge, words, commentJobs, typeof options.commentJob === "object" ? options.commentJob.jobName : undefined);
    // #4984: the decision before merge locks what the reach line prints, at stage apply.
    if (bmJobs && productPlan?.reach) comment.env = { ...comment.env, [LOCK_REACH_ENV]: productPlan.reach.command };
    out.comment = { ...comment, ...defaultRunner };
  }
  if (!named || !specFile || !namedWaveJobs) return { ...out, record: record! };
  // #4984: what the generator's before-merge mode takes: the merge after the last wave and the lock file it releases.
  const beforeMerge: OpWavesBeforeMerge | undefined = wavesBeforeMerge
    ? { ...(wavesBeforeMerge.merge ? { merge: wavesBeforeMerge.merge } : {}), ...(wavesBeforeMerge.mergeTokenSecret ? { mergeTokenSecret: wavesBeforeMerge.mergeTokenSecret } : {}), ...(wavesBeforeMerge.environment !== undefined ? { environment: wavesBeforeMerge.environment } : {}), ...(productPlan?.reach?.gate ? { gate: productPlan.reach.gate } : {}) }
    : undefined;
  // #4987: the apply statuses after each wave, and with a product plan the stale marking beside wave 1, one --member per target.
  const pipeline: Pick<OpWavesPipelineOptions, "beforeMerge" | "applyStatus" | "staleNotes" | "workflowFile" | "dispatchInputs" | "jobNames"> = {
    ...(beforeMerge ? { beforeMerge } : {}),
    // #5027: the same job names the comment job's re-run looks for.
    ...(wavesJobNames ? { jobNames: wavesJobNames } : {}),
    // #5022: the workflow and input names the comment job dispatches, for the generator.
    ...(wavesBeforeMerge?.workflowFile ? { workflowFile: wavesBeforeMerge.workflowFile } : {}),
    ...(wavesBeforeMerge?.dispatchInputs ? { dispatchInputs: { ...wavesBeforeMerge.dispatchInputs } } : {}),
    ...(options.applyStatus ? { applyStatus: { context: productStatusContext(words, "apply", member) } } : {}),
    ...(planStale ? { staleNotes: planStale } : {}),
  };
  return { ...out, waves: { spec: named, specFile, jobs: namedWaveJobs, ...(beforeMerge ? { beforeMerge } : {}), pipeline } };
}

/**
 * The waves' jobs a re-run looks for, by the product's names (#5027): each
 * wave's job, its deciding, share and job group jobs, and before merge the
 * split jobs, named as the Op waves generator names them from the same
 * `jobNames`.
 */
function productApplyJobs(spec: OpWavesSpec, chantJobs: readonly OpWaveJob[], named: readonly OpWaveJob[], forge: ForgeKind, jobNames: OpWavesJobNames, split: boolean): string[] {
  const out = named.map((j) => j.jobName);
  if (split) out.push(...opWavesNamer(spec, forge, jobNames).jobs(opWaveSplitJobs(spec, chantJobs)).map((j) => j.jobName));
  return [...new Set(out)];
}

/** The capability steps a component waves spec runs (#4545, #4541): argv templates over `{runs}` and `{plans}`. */
export interface ComponentWaveSteps {
  /** Plan every run of a wave through the capability registry, writing `{plans}`. */
  planWave: string[];
  /** Apply a wave's approved set through the capability registry. */
  applyWave: string[];
}

/** Where a component waves spec keeps the outputs each wave's components left, for the next wave's plans (#4588). */
export function componentWaveOutputsFile(op: string): string {
  return `${PRODUCT_WAVES_SPEC_DIR}/${op}/outputs.json`;
}

/** What {@link componentWaveSteps} names on each step's line (#4588). */
export interface ComponentWaveStepOptions {
  /** The command in place of `chant`, a product's `words.bin`. */
  bin?: string;
  env: string;
  /** The commit the change is measured from: what `pr-apply` was given. */
  base: string;
  /** The commit applied. Absent: the job's checkout. */
  head?: string;
  /** The workspace member. */
  member?: string;
  /** The file the waves hand outputs on in. Default {@link componentWaveOutputsFile} of `op`. */
  outputs?: string;
  /** The op the outputs file is named by. */
  op: string;
  /** The pull request's gate, whose rows file the apply leases on the resource grain. */
  gate?: string;
}

/**
 * The component plan-wave and apply-wave steps (#4588): `chant components
 * plan-wave` plans a wave's components through the project's capabilities
 * and writes the op-waves plans file with the wave's change set, and
 * `chant components apply-wave` plans the approved runs again, refuses any
 * whose plan moved (exit 4), and applies the rest. Both read the outputs
 * the waves before them left from the outputs file, and apply-wave adds its
 * own.
 */
export function componentWaveSteps(options: ComponentWaveStepOptions): ComponentWaveSteps {
  const bin = opWaveBinArgv(options.bin);
  const common = [
    "--env", options.env, "--base", options.base,
    ...(options.head ? ["--head", options.head] : []),
    ...(options.member ? ["--member", options.member] : []),
    ...(options.gate ? ["--gate", options.gate] : []),
    "--wave-outputs", options.outputs ?? componentWaveOutputsFile(options.op),
  ];
  return {
    planWave: [...bin, "components", "plan-wave", "--runs", "{runs}", "--plans", "{plans}", ...common],
    applyWave: [...bin, "components", "apply-wave", "--runs", "{runs}", "--plans", "{plans}", ...common],
  };
}

/** What {@link componentWavesSpec} takes beside the graph, the words and the steps. */
export interface ComponentWavesSpecOptions {
  /** The wave gate's base name: wave k waits at `<gate>-wave-<k>` (or the words' `gateName`). Default the words' `prGate`. */
  gate?: string;
  branches?: string[];
  /**
   * The op the gates are recorded under. `pr-apply --wave-gate` passes the
   * pull request's (`pr-<n>`), and then every wave takes the pull request's
   * approval whatever the words' preset. Default the words' `op`.
   */
  op?: string;
  /** The pull request's gate, whose approval a wave applies under when it covers the wave. Default the words' `prGate`. */
  prGate?: string;
  /** The layers, when the caller already has them (a derivation's `waves`). Default: layered from `dependsOn`. */
  waves?: readonly (readonly string[])[];
}

/**
 * A waves spec from the component graph (#4550, ruling A; #4588): a wave per
 * layer of the graph, each run a component, planned and applied through the
 * component plan-wave and apply-wave steps under the words' op and gate
 * names. `pr-apply --wave-gate` runs its waves on it.
 */
export function componentWavesSpec(
  components: readonly Pick<DriverComponent, "name" | "dependsOn">[],
  wordsIn: CiProductWordsInput | CiProductWords,
  steps: ComponentWaveSteps,
  options: ComponentWavesSpecOptions = {},
): OpWavesSpec {
  const words = assertProductWords(wordsIn);
  const layers = options.waves ?? layerWaves(components.map((c) => ({ name: c.name, dependsOn: c.dependsOn ?? [] })));
  const name = options.op ?? words.op ?? options.gate ?? words.prGate;
  const spec: OpWavesSpec = {
    name,
    op: name,
    gate: options.gate ?? words.prGate,
    planWave: steps.planWave,
    applyWave: steps.applyWave,
    ...(options.branches ? { branches: options.branches } : {}),
    waves: layers.map((layer, i) => ({ name: `wave-${i + 1}`, runs: layer.map((target) => ({ target })) })),
  };
  const named = productWavesSpec(spec, words);
  if (options.op === undefined) return named;
  // The pull request's own op: every wave applies under its approval when that covers the wave's plan, else at its own gate.
  return {
    ...named,
    name: options.op,
    op: options.op,
    waves: named.waves.map((w) => ({ ...w, approval: "pull-request" as const })),
    approvals: { ...(named.approvals ?? {}), pullRequest: { gate: options.prGate ?? words.prGate } },
  };
}

/** GitLab's reserved top-level keys, which no job may be named. */
const GITLAB_RESERVED = new Set(["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec", "pages"]);

/** The note poll's names (#5038), checked: only those the product gave, so a pipeline without them renders as before. */
function noteCommandsNames(forge: ForgeKind, given: ProductNoteCommandsJobOptions | undefined): Pick<NonNullable<ProductPipelineJobs["noteCommands"]>, "jobName" | "stage" | "schedule"> {
  if (given === undefined) return {};
  if (forge !== "gitlab") throw new Error(`noteCommandsJob names GitLab's note poll; on ${forge} the comment job (commentJob) answers comments`);
  const name = (what: string, v: unknown): string => {
    if (typeof v !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(v) || GITLAB_RESERVED.has(v)) throw new Error(`noteCommandsJob.${what} ${JSON.stringify(v)} is not a GitLab ${what === "stage" ? "stage" : "job"} name of letters, digits, _, . and -, and no GitLab keyword`);
    return v;
  };
  const s = given.schedule;
  if (s !== undefined && (typeof s.variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.variable) || typeof s.value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(s.value))) {
    throw new Error(`noteCommandsJob.schedule ${JSON.stringify(s)} is a variable name and a value of letters, digits, _, . and -, such as { variable: "TERRAGUCCI_SCHEDULE", value: "comments" }`);
  }
  return {
    ...(given.jobName !== undefined ? { jobName: name("jobName", given.jobName) } : {}),
    ...(given.stage !== undefined ? { stage: name("stage", given.stage) } : {}),
    ...(s !== undefined ? { schedule: { variable: s.variable, value: s.value } } : {}),
  };
}

/**
 * The comment job's descriptor (#4946): `chant components pr-comment
 * --forge <forge>` through the words' bin, the jobs it leaves comments to as
 * {@link COMMENT_JOBS_ENV}, and the comment prefixes the forge's `if:`
 * starts it on. Throws on GitLab, whose note-commands job answers every
 * note. `jobName` is the product's name for the job (#5027), default
 * {@link PR_COMMENT_JOB}.
 */
export function productCommentJob(forge: ForgeKind, words: CiProductWords, jobs: CommentJobs, jobName: string = PR_COMMENT_JOB): ProductCommentJob {
  if (forge === "gitlab") throw new Error("the comment job answers a GitHub or Forgejo comment; on GitLab the note-commands job (noteCommands) answers every note, so drop commentJob");
  for (const a of words.aliases) if (/['\\]/.test(a.from)) throw new Error(`the alias ${JSON.stringify(a.from)} holds a quote, which the comment job's condition cannot carry`);
  if (typeof jobName !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(jobName)) throw new Error(`commentJob.jobName ${JSON.stringify(jobName)} is not a job name of letters, digits, _ and -, starting with a letter or _`);
  return {
    jobName,
    command: withProductBin(`chant components pr-comment --forge ${forge}`, words.bin),
    env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN, [COMMENT_JOBS_ENV]: JSON.stringify(jobs) },
    prefixes: [`/${words.product}`, ...words.aliases.map((a) => a.from)],
    jobs,
  };
}

/** A shell line with the product's bin in place of `chant`, for a product's own jobs beside these. */
export function productCommand(words: CiProductWords, line: string): string {
  return withProductBin(line, words.bin);
}
