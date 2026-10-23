/**
 * Generate mode — component → GitHub Actions workflow YAML (#891, epic #885).
 *
 * The github counterpart to the gitlab generator (`../../gitlab/src/components/generate-pipeline.ts`,
 * #563/#688): the same `chant build --components --generate <lexicon>` seam,
 * synthesizing a **thin** `.github/workflows/*.yml` from the discovered
 * component graph instead of interpreting it directly.
 *
 * The generated workflow is a trigger, not the deploy logic:
 *  - Ordering + parallel-safe waves are resolved once, generically, by
 *    `resolveComponentGraph` (core's driver) — the exact function the local
 *    interpret driver and the gitlab generator both use. This module does not
 *    re-derive or duplicate that graph logic.
 *  - GitHub Actions has no `stage` concept, so wave ordering is expressed
 *    entirely through `needs:` edges between jobs: one job per component,
 *    with `needs:` pointing at the jobs for its direct `dependsOn` entries.
 *    Independent components therefore run in parallel, and dependents wait
 *    on their dependencies via GitHub's own `needs:` scheduling.
 *    `ComponentPipelineResult.stages` is still populated with the wave-ordered
 *    names (one per wave) purely for parity with gitlab's machine-readable
 *    `--format json` view — GitHub's YAML itself has no `stages:` section.
 *  - Each job's trigger step is exactly one invocation that hands off to the
 *    component's own composition (`chant run --components <name> ...` by
 *    default) — never inlined build/publish/apply steps. The deploy logic
 *    lives in the component's `deploy` phases and the capabilities they
 *    reference, not in this YAML.
 *  - A component that something else depends on can't hand its resolved
 *    stack outputs to a dependent in-memory, since each job is a separate
 *    GitHub Actions runner. It dumps its outputs to a file and uploads that
 *    file as a workflow artifact (`actions/upload-artifact`); each direct
 *    dependent downloads it (`actions/download-artifact`) and seeds from it,
 *    so a `stackOutput()` / `@<dep>.publish.*` reference still resolves even
 *    though the producer ran in a different job. This mirrors the dump/seed
 *    model `cli-support.ts` (`runComponents`'s `componentOutputs`) already
 *    uses, and matches gitlab's artifact-passing 1:1 in intent — only the
 *    transport differs (explicit upload/download steps vs. GitLab's implicit
 *    `needs:` artifact passing).
 *  - With `options.promoteTo` (#2575), one more job needs every component
 *    job and runs `chant components promote`. A promote publishes from the
 *    build archive on disk, so each component job uploads the files its
 *    build steps wrote and the promote job downloads them to the same paths.
 *    Each component job with a publish step also writes the digest its run
 *    recorded (`--digest-file`) to a job output, and the promote job passes
 *    it back as `--digest <component>=<digest>` (#2602), so it promotes the
 *    release this run built rather than whatever is latest in the source
 *    environment.
 *  - For a workspace member (`options.member`, #2542) the workflow keeps its
 *    triggers, and its `run:` steps start in the member's directory. See
 *    `scopeToMember`.
 *
 * Cross-cutting changes (e.g. "sign every image before deploy") are made by
 * editing `GenerateGithubOptions.extraScript`/`beforeScript` (or the
 * component's own composition) ONCE here — never per generated job. See
 * `generate-pipeline.test.ts`'s "cross-cutting change" cases for a
 * demonstration: one generator-option edit reflects in every job without
 * touching the component declarations.
 */

import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import { hasPublishStep, promoteArchivePaths } from "@intentius/chant/components/promote";
import { GATED_WAVE_RECORD, gatedWaveJobs } from "@intentius/chant/components/gated-wave-pipeline";
import { CI_IMAGE, ciJobName, dirnameOf, fillCommand, GITHUB_JOB_TOKEN, GITHUB_RUNNER } from "@intentius/chant/ci-jobs";
import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { OIDC_REQUEST_VARS, TRADE_SPEC_ENV, tradeLine, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import {
  APPLY_COMMENT,
  GREEN_TAG_PATTERN,
  GREEN_TICK_WORKFLOW,
  PR_APPLY_RECORD,
  PR_LOOP_REPORT_DIR,
  prApplyGroup,
  prRecordGroup,
  prApplyRecordKey,
  prApplyWaveJobName,
  prLoopJobs,
  prLoopPostJob,
  prLoopSetup,
  PR_PLAN_NOTE_JOB,
  prLoopWaveJobs,
  prLoopWithWaves,
  prEnvJobs,
  PR_ENV_REPORT_DIR,
  PR_ENV_SWEEP_CRON,
  PR_ENV_POST_JOB,
} from "@intentius/chant/components/pr-pipeline";
import { memberRepoPath } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineJob as GeneratedJob,
  ComponentPipelineOptions as GenerateGithubOptions,
  ComponentPipelineResult as GenerateGithubResult,
  PipelineMember,
} from "@intentius/chant/lexicon";
import { afterEarlierWave, checkoutStep, concurrency, downloadArtifactStep, emitWorkflowYAML, keepRecordStep, runSteps, UPLOAD_ARTIFACT } from "./ci-jobs";
import { actionRef } from "../action-pins";

export type { GeneratedJob, GenerateGithubOptions, GenerateGithubResult };

/**
 * The structured pipeline document behind {@link generateGithubPipeline}: the
 * `on`/`env`/`jobs` mappings plus the machine-readable `stages`/`jobs` views,
 * before YAML emission. Exposed so a GitHub-Actions dialect (the forgejo
 * lexicon, #969) can reuse the exact job/`needs:`/artifact structure and only
 * apply its dialect transform + emit, rather than re-deriving the graph.
 */
export interface GithubPipelineDoc {
  /**
   * The workflow's `name:` — `chant-components-<env>` (#2046), so two
   * pipelines generated for two environments are tellable apart in the
   * committed file, the Actions UI, and the API without lexing a job's
   * `run:` line.
   */
  name: string;
  /** The environment the pipeline deploys — `options.env` with the default applied (#2046). */
  environment: string;
  /** The `on:` trigger mapping (a bare `workflow_dispatch`). */
  on: Record<string, unknown>;
  /** The workflow's `defaults:`, set only for a workspace member: its jobs' `run:` steps start in the member's directory (#2542). */
  defaults?: Record<string, unknown>;
  /**
   * The `env:` mapping: the caller's `variables`, plus `CHANT_ENV` naming the
   * deployed environment (#2046) — the machine-readable identity on the
   * document itself. `CHANT_ENV` always reflects the environment baked into
   * the run lines, so a caller-supplied variable of the same name cannot make
   * the document lie about what its jobs deploy.
   */
  env?: Record<string, unknown>;
  /** The `jobs:` mapping — one entry per component. */
  jobsDoc: Record<string, unknown>;
  /** Wave-ordered stage names (parity with gitlab's `--format json`). */
  stages: string[];
  /** Every generated job, for the machine-readable view. */
  jobs: GeneratedJob[];
}

/** The plan job's last step, whose outputs carry its report to the plan-note job (#4295). */
const PLAN_STEP_ID = "plan";

/** The output a gated apply wave hands the green commit it applies through, and the step that sets it (#4221). */
const WAVE_GREEN_OUTPUT = "green-sha";
const WAVE_STEP_ID = "apply";

/** The workflow artifact the gated-wave jobs hand their attempt record through, one per wave. */
function waveRecordArtifact(wave: number): string {
  return `fan-out-record-wave-${wave}`;
}

/**
 * The gated-wave workflow (#3049): one job per wave, each running one wave of
 * `chant components fan-out --wave-gate`, chained by `needs:`. Each job
 * downloads the record the job before it uploaded and uploads its own, even
 * when it stops at a gate (exit 3), so re-running it after `chant approve`
 * reads the record. The checkout fetches full history for `--base`.
 */
function gatedWaveGithubDoc(
  components: DriverComponent[],
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGithubOptions,
): GithubPipelineDoc {
  const waveJobs = gatedWaveJobs(components, env, options.gatedWaves!);
  const jobsDoc: Record<string, unknown> = {};
  const jobs: GeneratedJob[] = [];
  for (const job of waveJobs) {
    jobs.push({ jobName: job.jobName, component: `wave ${job.wave}`, stage: job.jobName, needs: job.needs });
    const steps: Array<Record<string, unknown>> = [checkoutStep(true)];
    if (job.wave > 1) {
      steps.push(downloadArtifactStep(`Download the record wave ${job.wave - 1} left`, waveRecordArtifact(job.wave - 1), dirnameOf(GATED_WAVE_RECORD)));
    }
    steps.push(...runSteps(prLoopSetup(image)), ...runSteps(beforeScript), { run: job.command.join(" ") }, ...runSteps(extraScript));
    steps.push(keepRecordStep(`Upload the record for wave ${job.wave}`, waveRecordArtifact(job.wave), GATED_WAVE_RECORD));
    jobsDoc[job.jobName] = {
      // #4291: a wave runs after one that failed, and blocks only what depends on the failure.
      ...(job.needs.length > 0 ? { if: afterEarlierWave(job.needs[0]!) } : {}),
      "runs-on": GITHUB_RUNNER,
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      container: image,
      steps,
    };
  }
  const doc: GithubPipelineDoc = {
    name: `chant-components-${env}`,
    environment: env,
    on: { workflow_dispatch: {} },
    env: { ...options.variables, CHANT_ENV: env },
    jobsDoc,
    stages: waveJobs.map((j) => j.jobName),
    jobs,
  };
  return options.member ? scopeToMember(doc, options.member) : doc;
}

/**
 * The pull-request workflow (#3183): `plan` on each pull request into the
 * target branch, and on each push to it `record` (#4168), or `apply` with
 * `applyOnMerge`. The record job plans on the merged commit and writes the
 * merge record, applying nothing, so it pushes to `chant/lifecycle` and runs
 * one at a time per environment as the apply does. The plan job can comment and set
 * statuses but cannot push, since it runs the pull request's code; the apply
 * job can push, to record a pending fact on `chant/lifecycle`, and runs one
 * at a time per environment. Both keep their report as an artifact, and both
 * check out the full history, since each measures the change with git.
 * The apply job restores its attempt record from the cache before it runs
 * and saves it afterwards, failed or not, so a re-run of a failed apply
 * finishes it under the same approval (#3543).
 *
 * For a workspace member (#3465) the run steps start in the member's
 * directory and the report artifact is kept from there. The triggers take no
 * path filter, since a change outside the member can reach it; the plan
 * selects from the whole change and passes `--member`, which keeps the
 * member's gate, note and statuses apart from the other members'.
 *
 * With a gate per wave (`waveGate`, #4003) the one apply job becomes
 * `apply-wave-1` to `apply-wave-<n>`, one per wave of the component graph,
 * each needing the one before. Each saves the record under its own cache key
 * (the run, the attempt and the wave), and each restores the newest record
 * for the pushed commit, so wave k reads what wave k-1 left, and a re-run of
 * a wave that stopped at its gate reads what it left itself. Each keeps its
 * report as `chant-pr-apply-wave-<k>`.
 *
 * The plan job holds no forge token while the pull request's code runs
 * (#4295, `@intentius/chant/ci-handover`). It checks the change out with a
 * script that gives the job's token to its fetches alone, starts every later
 * step again without the token variables, and ends with the plan step, which
 * hands its report on as the job's outputs. The `plan-note` job then checks
 * out the target branch's commit, takes the report back, keeps it as the
 * `chant-pr-plan` artifact, and posts the note and `chant/plan` with
 * `chant components pr-post`. Only the note job may write to the pull
 * request and its statuses.
 *
 * With `identity` (#4296, `@intentius/chant/ci-identity`) the plan, record
 * and apply jobs get `id-token: write`, and each starts with a step that
 * trades the job's OIDC token for its cloud identity before anything is
 * checked out: the plan and record jobs for the plan identity, the apply
 * jobs for the apply identity. The trade leaves the credentials in
 * `GITHUB_ENV`. Every later step of the plan job starts without the
 * variables a token is requested with, so the pull request's code holds no
 * OIDC token and cannot request one, and the plan job names no apply
 * identity.
 *
 * With `applyBeforeMerge` (#4301, ws-106) the apply job runs on a
 * `/chant apply` comment on a pull request (`issue_comment`), from the
 * default branch's workflow file, so a pull request cannot change the job
 * that applies it. It checks out the pull request's head after the setup
 * and `beforeScript` ran at the default branch's commit, and runs `pr-apply
 * --before-merge`, which asks the forge the requires checks before any of
 * the head's code loads. On GitHub the commenter must be an owner, member
 * or collaborator. A push still records.
 */
function prLoopGithubDoc(
  components: DriverComponent[],
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGithubOptions,
): GithubPipelineDoc {
  const loop = options.prLoop!;
  const branch = loop.branch ?? "main";
  const member = options.member;
  const rooted = !member || member.dir === "." || member.dir === "";
  const [plan, apply, record] = prLoopJobs(loop.forge ?? "github", env, loop, member?.name);
  const reportPath = member ? memberRepoPath(member, PR_LOOP_REPORT_DIR) : PR_LOOP_REPORT_DIR;
  // The apply's attempt record (#3543) lives in the cache under the pushed
  // commit. Cache keys cannot be overwritten, so each attempt saves under
  // its run and attempt, and a re-run restores the newest for the commit.
  const recordPath = member ? memberRepoPath(member, PR_APPLY_RECORD) : PR_APPLY_RECORD;
  const recordPrefix = `${prApplyRecordKey(env, "${{ github.sha }}", member?.name)}-`;
  const recordKey = (wave?: number) => `${recordPrefix}\${{ github.run_id }}-\${{ github.run_attempt }}${wave ? `-wave-${wave}` : ""}`;
  const restoreRecord = (wave?: number) => ({
    name: wave ? "Restore the newest record of this commit's apply" : "Restore the record of an earlier attempt at this commit",
    uses: "actions/cache/restore@v4",
    with: { path: recordPath, key: recordKey(wave), "restore-keys": recordPrefix },
  });
  const saveRecord = (wave?: number) => ({
    name: wave ? "Keep the record for the next wave and a re-run" : "Keep the record for a re-run",
    if: "always()",
    uses: "actions/cache/save@v4",
    with: { path: recordPath, key: recordKey(wave) },
  });
  // #4296: the step that trades the job's OIDC token for its cloud identity, before the checkout.
  const identity = loop.identity;
  const tradeStep = (spec: CloudTradeSpec, which: "plan" | "apply"): Record<string, unknown> => ({
    name: `Trade the job's OIDC token for the ${which} identity`,
    ...(rooted ? {} : { "working-directory": "." }),
    env: { [TRADE_SPEC_ENV]: JSON.stringify(spec) },
    run: tradeLine("$GITHUB_ENV", "github-env"),
  });
  const withIdToken = (permissions: Record<string, string>): Record<string, string> => (identity ? { ...permissions, "id-token": "write" } : permissions);
  const reportName = (job: typeof plan) => `chant-pr-${job.wave ? prApplyWaveJobName(job.wave) : job.jobName}`;
  const steps = (job: typeof plan, name: string): Array<Record<string, unknown>> => [
    ...(identity ? [tradeStep(job.jobName === "record" ? identity.plan : identity.apply, job.jobName === "record" ? "plan" : "apply")] : []),
    checkoutStep(true),
    ...runSteps(prLoopSetup(image)),
    ...runSteps(beforeScript),
    ...(job.build ? [{ name: "Build the templates", run: job.build[0] }, { name: "Lint the project", run: job.build[1] }] : []),
    ...(job.jobName === "apply" ? [restoreRecord(job.wave)] : []),
    // The job's setup lines (#4004) run in the command's shell, so a value they settle reaches it.
    // The command runs through chant ci run (#4156), which writes the job's run record, signed when the CHANT_RUNNER_KEY secret is set.
    // #4221: a wave job hands the commit it applies to the next wave as the job output `green-sha`.
    job.wave
      ? {
          name,
          id: WAVE_STEP_ID,
          env: { ...job.run.env, ...(job.wave > 1 ? { GREEN_SHA: `\${{ needs.${prApplyWaveJobName(job.wave - 1)}.outputs.${WAVE_GREEN_OUTPUT} }}` } : {}) },
          run: [...(job.checkout ?? []), `echo "${WAVE_GREEN_OUTPUT}=$GREEN_SHA" >> "$GITHUB_OUTPUT"`, ...(job.setup ?? []), job.run.command].join("\n"),
        }
      : { name, env: job.run.env, run: [...(job.checkout ?? []), ...(job.setup ?? []), job.run.command].join("\n") },
    ...runSteps(extraScript),
    ...(job.jobName === "apply" ? [saveRecord(job.wave)] : []),
    {
      name: `Keep the ${job.wave ? `wave ${job.wave} ` : ""}${job.jobName} report`,
      if: "always()",
      uses: UPLOAD_ARTIFACT,
      with: { name: reportName(job), path: reportPath, "if-no-files-found": "ignore", "include-hidden-files": true },
    },
  ];
  // #4168 step 9: under apply on merge the apply runs on a green signal, and a push to the branch records.
  const forgejo = loop.forge === "forgejo";
  const onGreen = forgejo ? "startsWith(github.ref, 'refs/tags/ci/green/')" : "github.event_name == 'workflow_run' || github.event_name == 'workflow_dispatch'";
  const onPush = loop.applyOnMerge && forgejo ? "github.event_name == 'push' && startsWith(github.ref, 'refs/heads/')" : "github.event_name == 'push'";
  // #4301: a `/chant apply` comment on a pull request starts the apply before merge. GitHub also asks for a commenter who can write.
  const onComment = [
    "github.event_name == 'issue_comment'",
    // Forgejo's payload says so with is_pull (terragucci comment-apply.ts:129 at e6cb431).
    forgejo ? "(github.event.issue.pull_request || github.event.is_pull)" : "github.event.issue.pull_request",
    `startsWith(github.event.comment.body, '${APPLY_COMMENT}')`,
    ...(forgejo ? [] : ["contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association)"]),
  ].join(" && ");
  const applyJob = (job: typeof plan, needs: string[], name: string) => ({
    // #4291: a wave after the first runs after one that failed, and blocks only what depends on the failure.
    if: job.jobName === "record" ? onPush : needs.length > 0 && job.wave ? afterEarlierWave(needs[0]!, onGreen) : onGreen,
    "runs-on": GITHUB_RUNNER,
    ...(needs.length > 0 ? { needs } : {}),
    container: image,
    concurrency: concurrency(prApplyGroup(env, member?.name)),
    permissions: withIdToken({ contents: "write", "pull-requests": "write", statuses: "write" }),
    ...(job.wave ? { outputs: { [WAVE_GREEN_OUTPUT]: `\${{ steps.${WAVE_STEP_ID}.outputs.${WAVE_GREEN_OUTPUT} }}` } } : {}),
    steps: steps(job, name),
  });
  const waveJobs = loop.waveGate ? prLoopWaveJobs(components, apply) : [];
  const recordJob: [string, Record<string, unknown>] = ["record", { ...applyJob(record, [], "Record the plan on the merged commit; nothing applies"), concurrency: concurrency(prRecordGroup(env, member?.name)) }];
  const greenJobs: Array<[string, Record<string, unknown>]> = loop.waveGate
    ? waveJobs.map((job) => [
        prApplyWaveJobName(job.wave!),
        applyJob(job, job.wave! > 1 ? [prApplyWaveJobName(job.wave! - 1)] : [], job.wave === 1 ? "Apply wave 1 of the newest green commit, under the approval its plan has" : `Apply wave ${job.wave} of the green commit wave 1 took, under the approval its plan has`),
      ])
    : loop.applyOnMerge
      ? [["apply", applyJob(apply, [], "Apply the newest green commit under the merged changes' approvals")]]
      : loop.applyBeforeMerge
        ? [["apply", { ...applyJob(apply, [], "Apply the pull request's head under its gate, once it is approved, mergeable, undiverged and green"), if: onComment }]]
        : [];
  const applyJobs: Array<[string, Record<string, unknown>]> = [recordJob, ...greenJobs];
  // #4295: the plan job runs the pull request's code and holds no forge token while it does.
  const forgeName = loop.forge ?? "github";
  // #4296: once the plan job has traded its OIDC token, its later steps start without the variables a token is requested with.
  const drop = dropForgeTokens("sh", identity ? OIDC_REQUEST_VARS : []);
  const headStep = (line: string, name?: string): Record<string, unknown> => ({ ...(name ? { name } : {}), run: `${drop}\n${line}` });
  const planSteps: Array<Record<string, unknown>> = [
    // #4296: the trade runs first, before the change is checked out, with the plan identity alone.
    ...(identity ? [tradeStep(identity.plan, "plan")] : []),
    // A script, not actions/checkout, whose post step runs at the job's end with the token as its input.
    {
      name: "Check out the change",
      ...(rooted ? {} : { "working-directory": "." }),
      env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN },
      run: checkoutScript(true, true),
    },
    ...[...prLoopSetup(image), ...beforeScript].map((line) => headStep(line)),
    ...(plan.build ? [headStep(plan.build[0]!, "Build the templates"), headStep(plan.build[1]!, "Lint the project")] : []),
    // The job's last step: a step after it would start beside whatever the change's code left running.
    {
      name: "Plan the members this pull request reaches",
      id: PLAN_STEP_ID,
      env: plan.run.env,
      run: [drop, ...handoverTrap(PR_LOOP_REPORT_DIR, forgeName), ...(plan.checkout ?? []), ...(plan.setup ?? []), plan.run.command, ...extraScript].join("\n"),
    },
  ];
  const post = prLoopPostJob(forgeName, env, member?.name);
  const noteSteps: Array<Record<string, unknown>> = [
    // The target branch's commit: the chant this job runs is the target branch's, and none of the change's code is here.
    { name: "Check out the target branch's commit", uses: actionRef("actions/checkout"), with: { ref: "${{ github.event.pull_request.base.sha }}" } },
    ...runSteps(beforeScript),
    { name: "Take the plan report from the plan job", run: takeOverScript("plan", PR_LOOP_REPORT_DIR, forgeName) },
    { name: "Keep the plan report", if: "always()", uses: UPLOAD_ARTIFACT, with: { name: reportName(plan), path: reportPath, "if-no-files-found": "ignore", "include-hidden-files": true } },
    { name: "Post the plan note and chant/plan", if: "always()", env: post.env, run: post.command },
  ];
  // #4298: with a pull request environment the pull_request trigger fires on close too, and the plan skips that event.
  const prEnv = loop.prEnvironment ? prEnvGithubJobs(loop.forge ?? "github", image, beforeScript, extraScript, loop, member) : undefined;
  const jobsDoc: Record<string, unknown> = {
    plan: {
      if: prEnv ? "github.event_name == 'pull_request' && github.event.action != 'closed'" : "github.event_name == 'pull_request'",
      "runs-on": GITHUB_RUNNER,
      container: image,
      permissions: withIdToken({ contents: "read" }),
      outputs: handoverOutputs(PLAN_STEP_ID, forgeName),
      steps: planSteps,
    },
    [PR_PLAN_NOTE_JOB]: {
      needs: ["plan"],
      if: "always() && github.event_name == 'pull_request' && (needs.plan.result == 'success' || needs.plan.result == 'failure')",
      "runs-on": GITHUB_RUNNER,
      container: image,
      // #4289: `actions: read` lets pr-post ask when each scheduled watch or reconcile Op last ran.
      permissions: { actions: "read", contents: "read", "pull-requests": "write", statuses: "write" },
      steps: noteSteps,
    },
    ...Object.fromEntries(applyJobs),
    ...(prEnv ? prEnv.jobs : {}),
  };
  const applyNames = applyJobs.map(([name]) => name);
  const on: Record<string, unknown> = !loop.applyOnMerge
    ? { pull_request: { branches: [branch] }, push: { branches: [branch] } }
    : forgejo
      ? { pull_request: { branches: [branch] }, push: { branches: [branch], tags: [GREEN_TAG_PATTERN] } }
      : { pull_request: { branches: [branch] }, push: { branches: [branch] }, workflow_run: { workflows: [GREEN_TICK_WORKFLOW], types: ["completed"] }, workflow_dispatch: {} };
  if (prEnv) {
    on.pull_request = { branches: [branch], types: ["opened", "synchronize", "reopened", "closed"] };
    on.schedule = [{ cron: PR_ENV_SWEEP_CRON }];
  }
  // #4301: a /chant apply comment starts the apply before merge.
  if (loop.applyBeforeMerge) on.issue_comment = { types: ["created"] };
  return {
    name: member ? `chant-pr.${member.name}.${env}` : `chant-pr-${env}`,
    environment: env,
    on,
    ...(rooted ? {} : { defaults: { run: { "working-directory": member!.dir } } }),
    env: { ...options.variables, CHANT_ENV: env },
    jobsDoc,
    stages: ["plan", PR_PLAN_NOTE_JOB, ...applyNames, ...(prEnv ? ["env-up", PR_ENV_POST_JOB, "env-down", "env-sweep"] : [])],
    jobs: [
      { jobName: "plan", component: "pull request plan", stage: "plan", needs: [] },
      { jobName: PR_PLAN_NOTE_JOB, component: "pull request plan note", stage: PR_PLAN_NOTE_JOB, needs: ["plan"] },
      ...applyNames.map((name, i) => ({
        jobName: name,
        component: name === "record" ? "merge record" : loop.applyBeforeMerge ? "apply before merge" : loop.waveGate ? `green apply, wave ${i}` : "green apply",
        stage: name,
        // The record runs on a push and the apply on a green commit, so only the waves need each other.
        needs: i > 1 ? [applyNames[i - 1]] : [],
      })),
      ...(prEnv ? prEnv.listed : []),
    ],
  };
}

/**
 * The jobs of a pull request's environment (#4298). `env-up` runs on an
 * opened, updated or reopened pull request and runs the change's code, so it
 * follows the plan job's handover (#4295): a checkout script that alone sees
 * the job's token, every later step started without the token variables,
 * and the `pr-env up` step last, handing its report and record on as the
 * job's outputs. `env-post` checks out the target branch's commit, takes
 * them back, keeps the record on chant/lifecycle and posts the note.
 * `env-down` runs when the pull request closes and `env-sweep` on the
 * schedule, both from the base branch's code: a teardown reads the markers
 * off the live resources and builds nothing of the change. `env-up` and
 * `env-down` run one at a time per pull request, and a close waits for an
 * apply still running rather than cancelling it.
 */
function prEnvGithubJobs(
  forge: "github" | "forgejo",
  image: string,
  beforeScript: string[],
  extraScript: string[],
  loop: NonNullable<GenerateGithubOptions["prLoop"]>,
  member: GenerateGithubOptions["member"],
): { jobs: Record<string, unknown>; listed: GeneratedJob[] } {
  const [up, post, down, sweep] = prEnvJobs(forge, loop, member?.name);
  const rooted = !member || member.dir === "." || member.dir === "";
  const reportPath = member ? memberRepoPath(member, PR_ENV_REPORT_DIR) : PR_ENV_REPORT_DIR;
  const prNumber = "${{ github.event.pull_request.number }}";
  const group = `chant-pr-env-${member ? `${member.name}-` : ""}${prNumber}`;
  const writes = { contents: "write", "pull-requests": "write", statuses: "write" };
  const keep = (name: string) => ({ name: `Keep the ${name} report`, if: "always()", uses: UPLOAD_ARTIFACT, with: { name: `chant-pr-${name}`, path: reportPath, "if-no-files-found": "ignore", "include-hidden-files": true } });
  const opened = "github.event_name == 'pull_request' && github.event.action != 'closed'";

  // #4330: env-up, env-down and env-sweep trade the job's OIDC token for the pull request environments' identity, before the checkout.
  const identity = loop.prEnvIdentity;
  const tradeStep: Array<Record<string, unknown>> = identity
    ? [{ name: "Trade the job's OIDC token for the pull request environment's identity", ...(rooted ? {} : { "working-directory": "." }), env: { [TRADE_SPEC_ENV]: JSON.stringify(identity) }, run: tradeLine("$GITHUB_ENV", "github-env") }]
    : [];
  const withIdToken = (permissions: Record<string, string>): Record<string, string> => (identity ? { ...permissions, "id-token": "write" } : permissions);
  // #4295: env-up runs the change's code and holds no forge token while it does; #4330: nor the token request variables.
  const drop = dropForgeTokens("sh", identity ? OIDC_REQUEST_VARS : []);
  const headStep = (line: string, name?: string, env?: Record<string, string>): Record<string, unknown> => ({ ...(name ? { name } : {}), ...(env ? { env } : {}), run: `${drop}\n${line}` });
  const upJob = {
    if: opened,
    "runs-on": GITHUB_RUNNER,
    container: image,
    concurrency: concurrency(group),
    permissions: withIdToken({ contents: "read" }),
    outputs: handoverOutputs(PR_ENV_UP_STEP_ID, forge),
    steps: [
      ...tradeStep,
      {
        name: "Check out the change",
        ...(rooted ? {} : { "working-directory": "." }),
        env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN },
        run: checkoutScript(true, true),
      },
      ...[...prLoopSetup(image), ...beforeScript].map((line) => headStep(line)),
      ...(up.build ? [headStep(up.build[0]!, "Build the templates", { CHANT_ENV: up.env.CHANT_ENV! }), headStep(up.build[1]!, "Lint the project")] : []),
      // The job's last step: a step after it would start beside whatever the change's code left running.
      {
        name: "Apply this pull request's environment once its plan is approved",
        id: PR_ENV_UP_STEP_ID,
        env: up.env,
        run: [drop, ...handoverTrap(PR_ENV_REPORT_DIR, forge), up.command, ...extraScript].join("\n"),
      },
    ],
  };
  const postJob = {
    needs: ["env-up"],
    if: `always() && ${opened} && (needs.env-up.result == 'success' || needs.env-up.result == 'failure')`,
    "runs-on": GITHUB_RUNNER,
    container: image,
    concurrency: concurrency(`chant-pr-env-post-${member ? `${member.name}-` : ""}${prNumber}`),
    permissions: writes,
    steps: [
      // The target branch's commit: the chant this job runs is the target branch's, and none of the change's code is here.
      { name: "Check out the target branch's commit", uses: actionRef("actions/checkout"), with: { ref: "${{ github.event.pull_request.base.sha }}", "fetch-depth": 0 } },
      ...runSteps(beforeScript),
      { name: "Take the environment's report from the env-up job", run: takeOverScript("env-up", PR_ENV_REPORT_DIR, forge) },
      keep("env-up"),
      { name: "Keep the environment's record and post its note", if: "always()", env: post.env, run: post.command },
    ],
  };
  const baseJob = (j: typeof up, condition: string, ref: string, name: string, groupName: string) => ({
    if: condition,
    "runs-on": GITHUB_RUNNER,
    container: image,
    concurrency: concurrency(groupName),
    permissions: withIdToken(writes),
    steps: [
      ...tradeStep,
      { uses: actionRef("actions/checkout"), with: { "fetch-depth": 0, ...(ref ? { ref } : {}) } },
      ...runSteps(prLoopSetup(image)),
      ...runSteps(beforeScript),
      { name, env: j.env, run: j.command },
      ...runSteps(extraScript),
      keep(j.jobName),
    ],
  });
  return {
    jobs: {
      "env-up": upJob,
      [PR_ENV_POST_JOB]: postJob,
      "env-down": baseJob(down, "github.event_name == 'pull_request' && github.event.action == 'closed'", "${{ github.event.pull_request.base.ref }}", "Tear down what this pull request's environment owns", group),
      "env-sweep": baseJob(sweep, "github.event_name == 'schedule'", "", "Tear down the environments whose TTL passed or whose pull request closed", `chant-pr-env-sweep${member ? `-${member.name}` : ""}`),
    },
    listed: [
      { jobName: "env-up", component: "pull request environment", stage: "env-up", needs: [] },
      { jobName: PR_ENV_POST_JOB, component: "pull request environment note", stage: PR_ENV_POST_JOB, needs: ["env-up"] },
      { jobName: "env-down", component: "pull request environment teardown", stage: "env-down", needs: [] },
      { jobName: "env-sweep", component: "pull request environment sweep", stage: "env-sweep", needs: [] },
    ],
  };
}

/** The id of the `pr-env up` step, whose outputs carry the report (#4295). */
const PR_ENV_UP_STEP_ID = "env-up";

/** The file a producer dumps its resolved outputs to, and a dependent seeds from — one per component, matching gitlab's naming so both generators produce interchangeable artifacts. */
function outputsFile(name: string): string {
  return `${name}.outputs.json`;
}

/** The workflow artifact name a producer's dumped outputs are uploaded under. */
function artifactName(name: string): string {
  return `${name}-outputs`;
}

/** The file a component job writes the digest its run recorded to, for the promote job (#2602). */
function digestFile(name: string): string {
  return `${name}.digest`;
}

/** The workflow artifact name a component's build archive is uploaded under, for the promote job (#2575). */
function archiveArtifactName(name: string): string {
  return `${name}-archive`;
}

/**
 * The directory `actions/upload-artifact` roots a set of files at: the
 * deepest directory that holds all of them. Downloading into it puts each
 * file back at the path it was uploaded from.
 */
export function artifactRoot(paths: string[]): string {
  const dirs = paths.map((p) => {
    const parts = p.replace(/\/+$/, "").split("/");
    parts.pop();
    return parts.filter((part) => part !== "" && part !== ".");
  });
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  const absolute = paths.every((p) => p.startsWith("/"));
  if (common.length === 0) return absolute ? "/" : ".";
  return (absolute ? "/" : "") + common.join("/");
}

/**
 * Synthesize a `.github/workflows/*.yml` pipeline from a set of components:
 * one job per component, `needs:` expressing the wave-ordered dependency DAG
 * from `resolveComponentGraph`. Throws `DependencyCycleError`/
 * `UnknownDependencyError` (from core's driver) exactly like the interpret
 * driver and the gitlab generator do, since all three consume the same graph
 * resolution. Wired into core's generate mode via the github lexicon plugin's
 * `generateComponentPipeline` (../plugin.ts).
 */
export function buildGithubPipelineDoc(
  components: DriverComponent[],
  options: GenerateGithubOptions = {},
): GithubPipelineDoc {
  const env = options.env ?? "production";
  const image = options.image ?? CI_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "--components", "{name}", "--env", env];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const { waves } = resolveComponentGraph(components);
  const byName = new Map(components.map((c) => [c.name, c]));

  if (options.prLoop) {
    if (options.promoteTo !== undefined) throw new Error("a pull-request pipeline has no promote job; drop --promote-to or --pr-loop");
    // #4003: --wave-gate beside --pr-loop gives the apply a gate per wave.
    const prLoop = prLoopWithWaves(options.prLoop, options.gatedWaves);
    return prLoopGithubDoc(components, env, image, beforeScript, extraScript, { ...options, prLoop });
  }

  if (options.gatedWaves) {
    if (options.promoteTo !== undefined) throw new Error("a gated-wave pipeline has no promote job; drop --promote-to or --wave-gate");
    return gatedWaveGithubDoc(components, env, image, beforeScript, extraScript, options);
  }

  // Components that something else depends on must hand their resolved outputs
  // (stack outputs, published artifact refs) to their dependents, which run as
  // separate jobs on separate runners. Each such producer dumps its outputs to
  // a file and uploads it as a workflow artifact; each dependent downloads that
  // artifact and seeds from it, so a `stackOutput()` / `@<dep>.publish.*`
  // reference resolves even though the producer ran in a different job.
  // Without this, a single-component job has no in-memory outputs for its
  // dependencies — see epic #551 / the adopt-alb-services example.
  const dependedUpon = new Set<string>();
  for (const c of components) for (const dep of c.dependsOn ?? []) dependedUpon.add(dep);

  // A promote job (#2575) runs on its own runner, and a promote publishes from
  // the build archive on disk, so each component job uploads the files its
  // build steps wrote and the promote job downloads them.
  const promoteTo = options.promoteTo;
  const archives = new Map<string, string[]>();
  // The components the promote job pins to this run's digest (#2602): those
  // with a publish step, the only ones whose deploy records a release.
  const pinned = new Set<string>();
  if (promoteTo !== undefined) {
    for (const c of components) {
      const paths = promoteArchivePaths(c);
      if (paths.length > 0) archives.set(c.name, paths);
      if (hasPublishStep(c)) pinned.add(c.name);
    }
    if (pinned.size === 0) {
      throw new Error("no component has a publish step, so no deploy records a release for the promote job to promote");
    }
  }

  const stages = waves.map((_, i) => `wave-${i + 1}`);
  const jobs: GeneratedJob[] = [];
  const jobNameByComponent = new Map<string, string>();
  for (const wave of waves) {
    for (const name of wave) jobNameByComponent.set(name, ciJobName(name));
  }

  const jobsDoc: Record<string, unknown> = {};

  waves.forEach((wave, waveIndex) => {
    const stage = stages[waveIndex];
    for (const name of wave) {
      const component = byName.get(name)!;
      const jobName = jobNameByComponent.get(name)!;
      const needs = (component.dependsOn ?? []).map((dep) => jobNameByComponent.get(dep)!).sort();

      jobs.push({ jobName, component: name, stage, needs });

      // Build the run invocation, then append output-threading flags: seed from
      // each dependency's dumped outputs (downloaded as an artifact below), and
      // dump this component's own outputs if a dependent will need them.
      const runParts = fillCommand(runCommand, name);
      for (const dep of component.dependsOn ?? []) runParts.push("--seed-outputs", outputsFile(dep));
      if (dependedUpon.has(name)) runParts.push("--dump-outputs", outputsFile(name));
      if (pinned.has(name)) runParts.push("--digest-file", digestFile(name));

      // One step per script line — mirrors gitlab's `script:` array of
      // discrete shell lines, rather than a single multi-line `run:` block, so
      // each line is independently inspectable (and machine-parseable).
      const steps: Array<Record<string, unknown>> = [checkoutStep()];
      for (const dep of component.dependsOn ?? []) steps.push(downloadArtifactStep(`Download ${dep} outputs`, artifactName(dep), "."));
      steps.push(...runSteps(beforeScript), { run: runParts.join(" ") }, ...runSteps(extraScript));

      // The file holds `<component>=<digest>`; the job output holds the digest.
      if (pinned.has(name)) {
        steps.push({
          name: `Record ${name} digest`,
          id: "digest",
          run: `echo "digest=$(cut -d= -f2- ${digestFile(name)})" >> "$GITHUB_OUTPUT"`,
        });
      }

      if (dependedUpon.has(name)) {
        steps.push({
          name: `Upload ${name} outputs`,
          uses: UPLOAD_ARTIFACT,
          with: { name: artifactName(name), path: outputsFile(name) },
        });
      }

      const archive = archives.get(name);
      if (archive) {
        steps.push({
          name: `Upload ${name} build archive`,
          uses: UPLOAD_ARTIFACT,
          with: {
            name: archiveArtifactName(name),
            path: archive.join("\n"),
            "if-no-files-found": "error",
            "include-hidden-files": true,
          },
        });
      }

      const jobProps: Record<string, unknown> = {
        "runs-on": GITHUB_RUNNER,
        ...(needs.length > 0 ? { needs } : {}),
        container: image,
        ...(pinned.has(name) ? { outputs: { digest: "${{ steps.digest.outputs.digest }}" } } : {}),
        steps,
      };
      jobsDoc[jobName] = jobProps;
    }
  });

  if (promoteTo !== undefined) {
    const promoteJob = `promote-${ciJobName(promoteTo)}`;
    if (promoteJob in jobsDoc) {
      throw new Error(`the promote job "${promoteJob}" has the same name as a component job; rename the component`);
    }
    const command = [...(options.promoteCommand ?? ["chant", "components", "promote", "--from", env, "--to", promoteTo])];
    for (const name of [...pinned].sort()) {
      command.push("--digest", `"${name}=\${{ needs.${jobNameByComponent.get(name)!}.outputs.digest }}"`);
    }
    const steps: Array<Record<string, unknown>> = [checkoutStep()];
    for (const [name, paths] of archives) {
      steps.push(downloadArtifactStep(`Download ${name} build archive`, archiveArtifactName(name), artifactRoot(paths)));
    }
    steps.push(...runSteps(beforeScript), { run: command.join(" ") }, ...runSteps(extraScript));
    jobsDoc[promoteJob] = {
      "runs-on": GITHUB_RUNNER,
      needs: [...jobNameByComponent.values()].sort(),
      container: image,
      steps,
    };
  }

  const doc: GithubPipelineDoc = {
    name: `chant-components-${env}`,
    environment: env,
    on: { workflow_dispatch: {} },
    env: { ...options.variables, CHANT_ENV: env },
    jobsDoc,
    stages,
    jobs,
  };
  return options.member ? scopeToMember(doc, options.member) : doc;
}

/**
 * Scope a pipeline to one workspace member (#2542, #2524 D19). Its name
 * carries the member's name, and every `run:` step starts in the member's
 * directory through `defaults.run.working-directory`.
 *
 * The triggers stay exactly the plain pipeline's. A deploy pipeline gains no
 * `push` or `pull_request` trigger for a member, and its only trigger,
 * `workflow_dispatch`, takes no `paths:` filter.
 *
 * `working-directory` applies to `run:` steps only. The artifact actions
 * resolve `path` against the repository root, so each upload and download
 * path moves under the member's directory, where the `run:` steps read and
 * write the files.
 */
function scopeToMember(doc: GithubPipelineDoc, member: PipelineMember): GithubPipelineDoc {
  const rooted = member.dir === "." || member.dir === "";
  const jobsDoc: Record<string, unknown> = {};
  for (const [name, job] of Object.entries(doc.jobsDoc)) {
    const props = job as { steps?: Array<Record<string, unknown>> };
    jobsDoc[name] = rooted || !props.steps ? job : { ...props, steps: props.steps.map((step) => memberArtifactStep(step, member)) };
  }
  return {
    ...doc,
    name: `chant-components.${member.name}.${doc.environment}`,
    ...(rooted ? {} : { defaults: { run: { "working-directory": member.dir } } }),
    jobsDoc,
  };
}

/** An `actions/upload-artifact` or `download-artifact` step with its `path` moved under the member's directory. */
function memberArtifactStep(step: Record<string, unknown>, member: PipelineMember): Record<string, unknown> {
  const uses = typeof step.uses === "string" ? step.uses : "";
  if (!/^actions\/(upload|download)-artifact@/.test(uses)) return step;
  const withProps = step.with as Record<string, unknown> | undefined;
  if (!withProps || typeof withProps.path !== "string") return step;
  const path = withProps.path
    .split("\n")
    .map((line) => memberRepoPath(member, line))
    .join("\n");
  return { ...step, with: { ...withProps, path } };
}

/**
 * Emit a `GithubPipelineDoc`'s `on`/`env`/`jobs` mappings as workflow YAML.
 * Shared with the forgejo dialect (#969), which transforms the doc first.
 */
export function emitPipelineYAML(doc: GithubPipelineDoc): string {
  return emitWorkflowYAML({ name: doc.name, on: doc.on, env: doc.env, defaults: doc.defaults, jobsDoc: doc.jobsDoc });
}

/**
 * Synthesize a `.github/workflows/*.yml` pipeline from a set of components:
 * one job per component, `needs:` expressing the wave-ordered dependency DAG
 * from `resolveComponentGraph`. Thin wrapper over {@link buildGithubPipelineDoc}
 * + {@link emitPipelineYAML}.
 */
export function generateGithubPipeline(
  components: DriverComponent[],
  options: GenerateGithubOptions = {},
): GenerateGithubResult {
  const doc = buildGithubPipelineDoc(components, options);
  return { yaml: emitPipelineYAML(doc), stages: doc.stages, jobs: doc.jobs, env: doc.environment };
}
