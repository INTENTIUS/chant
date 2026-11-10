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
import { gitlabPlanJobName, PR_LOOP_REPORT_DIR, PR_PLAN_NOTE_JOB, prLoopPassedEnv, prLoopPostJob, prLoopRunner, type PrLoopPipelineOptions } from "./pr-pipeline";
import { GITHUB_JOB_TOKEN } from "../ci-jobs";
import { cloudLogin, type CloudLoginSpec } from "../ci-login";
import type { OpWaveRunStep } from "../lexicon";
import { controlNoteCheckout, type ControlNoteCheckout, type ControlTarget } from "../control/dispatch";
import { commentLine, productStatusContext } from "../ci-product-words";
import { PLAN_WATCHES_ENV, scheduledWatchProblem, type ScheduledWatch } from "../op/schedule-overdue";
import { PLAN_RUN_OP, PLAN_RUN_RECORD_FILE } from "../pr-plan-record";

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
  replan?: boolean;
  /**
   * Lines the note job runs (#4931), on GitHub and Forgejo, in the job that
   * holds the token and none of the change's code: `before` after the report
   * is taken back and before `pr-post`, `after` once it posted. A `before`
   * line may write notices, one a line, to the file
   * `$CHANT_PLAN_NOTE_NOTICES` names, and `pr-post` adds them under the
   * note's counts, such as terragucci's notice naming whose review does not
   * count. They reach the job's token as `GITHUB_TOKEN`. GitLab's note job
   * posts every open merge request's note in one run, so it takes none.
   */
  noteSteps?: { before?: string[]; after?: string[] };
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
   * job's `plan` and `policy` checks from its report, and their variables
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
  /** The note job's own lines (#4931). */
  noteSteps?: { before: string[]; after: string[] };
  /** With `record` (#4899): the plan step writes the run record, `env` its op, environment and labels as {@link PLAN_RUN_RECORD_ENV}; the note job's command records it. */
  record?: { env: Record<string, string> };
}

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The pull request loop's options the product plan's jobs do not carry, and what each needs. Each is refused with `plan` (#4799). */
const NOT_WITH_PLAN: ReadonlyArray<[keyof PrLoopPipelineOptions, string]> = [
  ["applyBeforeMerge", "the apply before merge runs pr-apply on pr-plan's report"],
  ["applyOnMerge", "the apply on merge runs on op waves, from the waves spec"],
  ["waveGate", "the apply on merge runs on op waves, from the waves spec"],
  ["locks", "the lock job reads pr-plan's report"],
  ["previewComment", "the comment preview re-runs pr-plan"],
  ["staleNotes", "the stale marking names one note per pipeline"],
  ["identity", "the identity trade runs before pr-plan's checkout; give the product plan's login (or a target's) instead"],
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
    const loginSpec = target?.login ?? plan.login;
    const login = loginSpec ? cloudLogin(forge, loginSpec) : undefined;
    const ownTokens = target?.idTokens ?? plan.idTokens;
    for (const [v, aud] of Object.entries(ownTokens ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`the product plan's id token ${JSON.stringify(v)} is not a variable name`);
      if (!aud.trim() || /\s/.test(aud)) throw new Error(`the product plan's id token ${v} names no audience`);
      if (login && v in login.idTokens && login.idTokens[v] !== aud) throw new Error(`the product plan's id token ${v} is the login's, with another audience`);
    }
    const idTokens = { ...(login?.idTokens ?? {}), ...(ownTokens ?? {}) };
    const artifact = plan.artifact ? (name ? `${plan.artifact}-${name}` : plan.artifact) : name ? `chant-pr-plan-${name}` : "chant-pr-plan";
    const replan0 = replanComments ? { ...replanJobOf(forge, env, words, name, artifact, noteWords), ...replanComments } : undefined;
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
      ...(evidence ? { evidence: planEvidenceOf(forge, evidence, words, jobName, plan.forks === "skip" ? { noForks: true } : {}) } : {}),
      ...(Object.keys(jobEnv).length > 0 ? { jobEnv } : {}),
      ...(login && login.steps.length > 0 ? { login: login.steps } : {}),
      ...(Object.keys(idTokens).length > 0 ? { idTokens } : {}),
      ...(plan.pending && github ? { pending: { context: productStatusContext(words, "plan", name), description: "planning" } } : {}),
      ...(control ? { control } : {}),
      ...(plan.setup?.length ? { setup: plan.setup } : {}),
      ...(plan.report ? { report: fill(plan.report, name) } : {}),
      ...(replan ? { replan } : {}),
      ...(noteBefore.length > 0 || noteAfter.length > 0 ? { noteSteps: { before: noteBefore, after: noteAfter } } : {}),
      ...(record ? { record } : {}),
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
function replanJobOf(forge: ForgeKind, env: string, words: CiProductWords, name: string | undefined, artifact: string, noteWords: Record<string, string>): Omit<ProductPlanReplanJob, "comments" | "gated"> {
  const github = forge !== "gitlab";
  const jobName = github ? (name ? `${REPLAN_JOB}-${name}` : REPLAN_JOB) : name ? `${name}-${REPLAN_JOB}` : REPLAN_JOB;
  const noteJobName = github ? (name ? `${REPLAN_NOTE_JOB}-${name}` : REPLAN_NOTE_JOB) : name ? `${name}-${REPLAN_NOTE_JOB}` : REPLAN_NOTE_JOB;
  // pr-post reads the pull request and the head from the re-plan job, never the comment. GitLab's is GitHub's line with its own --forge.
  const command = github ? prLoopPostJob(forge, env, name, words).command : prLoopPostJob("github", env, name, words).command.replace(" --forge github ", " --forge gitlab ");
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
export const REPLAN_DECIDE_JS = [
  'const fs=require("fs");',
  'const say=(m)=>console.log("chant: "+m);',
  'const out=(k,v)=>fs.appendFileSync(process.env.GITHUB_OUTPUT,k+"="+v+"\\n");',
  "let e;try{e=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,\"utf8\"))}catch{say(\"the event file does not read, so nothing is planned again\");process.exit(0)}",
  'const body=String((e.comment&&e.comment.body)||"").trim();',
  'const cmds=JSON.parse(process.env.CHANT_REPLAN_COMMANDS||"[]");',
  'for(const g of JSON.parse(process.env.CHANT_REPLAN_GATED||"[]")){const v=process.env[g.when]||"";if(v&&v!=="0"&&v!=="false")cmds.push(g.comment)}',
  "let arg;",
  'for(const c of cmds){if(body===c){arg="";break}if(body.startsWith(c+" ")){const r=body.slice(c.length).trim();if(/^[A-Za-z0-9_.\\/@+=,:-]+$/.test(r)){arg=r;break}}}',
  'if(arg===undefined){say("the comment asks for no plan");process.exit(0)}',
  'const target=process.env.CHANT_REPLAN_TARGET||"",targets=JSON.parse(process.env.CHANT_REPLAN_TARGETS||"[]");',
  'if(targets.length&&arg&&!targets.includes(arg)){say(arg+" is none of "+targets.join(", ")+", so nothing is planned again");process.exit(0)}',
  'if(targets.length&&arg&&arg!==target){say("the comment plans "+arg+" again, not "+target);process.exit(0)}',
  'const n=e.issue&&e.issue.number;if(!Number.isInteger(n)||!(e.issue.pull_request||e.is_pull)){say("the comment is not on a pull request");process.exit(0)}',
  'const api=String(process.env.GITHUB_API_URL||"").replace(/\\/+$/,""),repo=process.env.GITHUB_REPOSITORY;',
  'const get=async(p)=>{const r=await fetch(api+"/repos/"+repo+p,{headers:{authorization:"token "+process.env.CHANT_REPLAN_TOKEN,accept:"application/json"}});if(!r.ok)throw new Error(p+" answered "+r.status);return r.json()};',
  "(async()=>{",
  'const pr=await get("/pulls/"+n);',
  'if(pr.state!=="open"){say("pull request "+n+" is not open, so it is not planned again");return}',
  'const same=Boolean(pr.head&&pr.head.repo&&pr.head.repo.full_name===repo);',
  'if(!same&&process.env.CHANT_REPLAN_FORKS==="skip"){say("pull request "+n+" is from a fork, and its code never runs with this repository\\u0027s credentials");return}',
  'if(process.env.CHANT_REPLAN_PERMISSION){const who=e.comment&&e.comment.user&&e.comment.user.login;const p=who?await get("/collaborators/"+encodeURIComponent(who)+"/permission"):{};',
  'if(!["owner","admin","maintain","write"].includes(p.permission)){say((who||"the commenter")+" cannot write to "+repo+", so nothing is planned again");return}}',
  'const sha=/^[0-9a-f]{40}$/;if(!sha.test(String(pr.head&&pr.head.sha))||!sha.test(String(pr.base&&pr.base.sha)))throw new Error("the pull request names no head or base commit");',
  'out("go","1");out("pr",String(n));out("head",pr.head.sha);out("base",pr.base.sha);out("argument",arg);',
  'say("planning pull request "+n+" again at "+pr.head.sha.slice(0,12)+(arg?" for "+arg:""))',
  '})().catch((err)=>{console.error("chant: the re-plan could not decide: "+(err&&err.message?err.message:String(err)));process.exit(1)});',
].join("");

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

/** The evidence step of one plan job (#4870), as {@link ProductPlanJob.evidence}. */
export function planEvidenceOf(forge: ForgeKind, evidence: PipelineEvidence, words: CiProductWords, planJob: string, opts: { noForks?: boolean } = {}): NonNullable<ProductPlanJob["evidence"]> {
  assertPipelineEvidence(evidence);
  const key = evidenceKeyEnv(forge, evidence);
  const bin = words.bin;
  if (forge === "gitlab") {
    // #4914: the job runs in the target branch's plan notes pipeline, before the note job, and signs every open
    // merge request's settled plan job from its artifact; no job of a merge request pipeline holds the key.
    const dir = gitlabOpenEvidenceDir(planJob);
    return {
      jobName: `${planJob}-evidence`,
      lines: openEvidenceLines({ job: planJob, dir: PR_LOOP_REPORT_DIR, out: dir, ...(bin ? { bin } : {}), ...(opts.noForks ? { noForks: true } : {}) }),
      env: key,
      dir,
      ...(evidenceKeyless(evidence) ? { idTokens: evidenceIdTokens(evidence) } : {}),
    };
  }
  return {
    lines: planEvidenceLines({ dir: PR_LOOP_REPORT_DIR, at: '"$HEAD_SHA"', base: '"$BASE_SHA"', result: '"$PLAN_RESULT"', ...(bin ? { bin } : {}) }),
    env: { HEAD_SHA: "${{ github.sha }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}", PLAN_RESULT: `\${{ needs.${planJob}.result }}`, ...key },
    ...(evidenceKeyless(evidence) ? { idToken: true as const } : {}),
  };
}

/** The GitHub and Forgejo condition that a pull request is from this repository, not a fork (#4799). */
export const SAME_REPOSITORY_IF = "github.event.pull_request.head.repo.full_name == github.repository";

/** The GitLab rule condition that a merge request's source project is the project itself (#4799). */
export const GITLAB_SAME_PROJECT_IF = "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID";
