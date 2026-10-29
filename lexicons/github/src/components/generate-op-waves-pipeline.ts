/**
 * Op waves → GitHub Actions workflow (#3679).
 *
 * One workflow for the whole spec, on a push to its branches (and by hand).
 * Each job is one of core's `opWaveJobs`: a wave, or a wide
 * wave's deciding job and share jobs, chained by `needs:`. Re-running the
 * failed jobs after `chant approve` carries on from that wave.
 *
 * Each job keeps its outcome file as an artifact whatever its exit code
 * (#4322), and a job with `needs:` downloads every artifact of the run into
 * the outcome directory first. A wave or deciding job after the first runs
 * unless the run was cancelled (`if: !cancelled()`), so it runs after a
 * failure in the wave before: it blocks the runs that depend on a failed one
 * and applies the rest, and it stops by itself when an earlier wave waits at
 * its gate (exit 3) or applied nothing for another reason. A share job still
 * needs its deciding job to succeed.
 *
 * Every job checks out the full history, because the runner reads the gate
 * policy from the spec file at the base commit and records pending gates on
 * `chant/lifecycle`, which is why the workflow asks for `contents: write`. A
 * deciding job uploads its decision, even when it waits, and each share job
 * downloads it. The forgejo generator reuses {@link buildGithubOpWavesDoc}
 * and applies its dialect.
 *
 * `options.bin` (#4607) is a product's command in place of `chant` in every
 * job line: the wave jobs, the resume job and the plans job.
 *
 * With `resume` on the spec (#3683), a second workflow, `<name>-resume.yml`,
 * runs `chant run resume --op <name>` on that schedule: it re-runs the failed
 * jobs of a run whose waiting wave has been approved since, with the job's
 * token and `actions: write`.
 *
 * When a wave's approval is `pr-review` (#3684), the workflow also asks for
 * `pull-requests: read`, so a wave can read the merged pull request's
 * reviews, and a second workflow, `<name>-plans.yml`, runs `chant run wave
 * --record-plans` on each pull request to record the digests its head plans.
 * A `pull-request` wave (#4630) gets the plans workflow too, for the approval
 * status before merge; it asks for no `pull-requests: read` on the waves.
 *
 * With `notify` on the spec (#3761), the workflow maps each variable it names
 * from the repository secret of the same name, so a wave job can post to
 * Slack, Teams or a signed webhook. `options.variables` wins over the mapping.
 *
 * `runner` (on the spec, a wave or a job group, #3914) is the job's `runs-on`.
 * A wave's `jobs` renders its deciding job with the wave's own settings and a
 * job per group (per share of a group) with the group's: its runner,
 * environment, variables over the wave's, setup after the wave's, and id
 * tokens. A job with id tokens gets `permissions:` of its own, the
 * workflow's plus `id-token: write`, and each audience as `<NAME>_AUDIENCE`.
 *
 * A job whose wave or group gives `cloud` (#4332, `cloudIdentityWave` in
 * `@intentius/chant/ci-identity`) gets `id-token: write` and starts with a
 * step that trades the job's OIDC token for those identities, before the
 * checkout. Every later run step starts with an unset of the variables a
 * token is requested with, so the code the job runs holds no OIDC token
 * and cannot request one for another group's identity.
 *
 * With `control` on the spec (#4617), a `control-dispatch` job needs the
 * last wave's jobs and runs after them unless the run was cancelled, so it
 * runs after a failure too. It downloads every job's outcome file, adds
 * them up with `chant run wave --waves-outcome` (through the product's
 * bin) into `CHANT_CONTROL_OUTCOME`, and sends the control repo one
 * dispatch carrying that outcome and the pushed commit. Only the dispatch
 * step holds the control token: the `tokenSecret` secret, mapped into
 * `CHANT_CONTROL_TOKEN` and handed to curl on its stdin
 * (`controlDispatchScript`, #4568).
 *
 * Every wave, deciding and share job starts with the apply-job guard
 * (#4624, `@intentius/chant/ci-job-guard`), before the trade and the
 * checkout: it stops the job unless `GITHUB_REF` is one of the spec's
 * branches, the job runs in its forge environment (read from an OIDC
 * token's claims, so only in a job that may request one), and, for a
 * runner whose labels include `self-hosted`, on a self-hosted runner. The
 * forgejo generator passes `forge: "forgejo"`, which checks the ref and
 * runner only.
 */

import {
  notifyVariables,
  opWaveGroupOf,
  opWaveJobs,
  opWaveJobTimeout,
  opWaveOutcomeDir,
  opWavesControlTarget,
  opWavesLastJobs,
  opWavesApprovalStatusCommand,
  opWavesPostsApprovalStatus,
  opWavesOutcomeCommand,
  opWavesRecordPlansCommand,
  opWavesResumeCommand,
  type OpWavesSpec,
} from "@intentius/chant/op/op-waves";
import { CONTROL_OUTCOME_VAR, controlDispatchJob } from "@intentius/chant/control/dispatch";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import {
  assertEnvironment,
  assertSetupSteps,
  CI_IMAGE,
  dirnameOf,
  environmentDoc,
  GITHUB_JOB_TOKEN,
  githubRunsOn,
  githubSecretEnv,
  idTokenAudienceEnv,
  nonEmpty,
  pushBranches,
  setupStepDoc,
} from "@intentius/chant/ci-jobs";
import { OIDC_REQUEST_VARS, TRADE_SPEC_ENV, tradeLine, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import { JOB_GUARD_ENV, jobGuardLine, jobGuardSpec, opWaveJobLabel } from "@intentius/chant/ci-job-guard";
import { resolveProductWords } from "@intentius/chant/ci-product-words";
import { checkoutStep, concurrency, DOWNLOAD_ARTIFACT, downloadArtifactStep, keepRecordStep, runSteps } from "./ci-jobs";
import { emitOpPipelineYAML, type GithubOpPipelineDoc } from "./generate-op-pipeline";

/** The default image: it carries git, which the runner needs to read the base commit. */
export const OP_WAVES_IMAGE = CI_IMAGE;

/** The artifact a wide wave's deciding job hands its share jobs. */
export function opWaveRecordArtifact(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `${spec.name}-wave-${wave}-decision`;
}

/** The artifact a job keeps its outcome file in (#4322). */
export function opWaveOutcomeArtifact(spec: Pick<OpWavesSpec, "name">, jobName: string): string {
  return `${spec.name}-${jobName}-outcome`;
}

/** The workflow document, before emission, and the jobs it holds. */
export function buildGithubOpWavesDoc(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  dialect: { forge?: "github" | "forgejo" } = {},
): { doc: GithubOpPipelineDoc; jobs: OpWavesPipelineResult["jobs"]; resumeDoc?: GithubOpPipelineDoc; plansDoc?: GithubOpPipelineDoc } {
  const jobs = opWaveJobs(spec, options.specFile, { bin: options.bin });
  const forge = dialect.forge ?? "github";
  const product = resolveProductWords(options.words ?? {}).product;
  const image = options.image ?? OP_WAVES_IMAGE;
  const byReview = spec.waves.some((w) => w.approval === "pr-review");
  // #4630: a pr-review or pull-request wave gets the plans workflow and its approval status.
  const statusBeforeMerge = opWavesPostsApprovalStatus(spec);
  for (const wave of spec.waves) {
    assertSetupSteps(`${spec.name}/${wave.name}`, wave.setup ?? []);
    if (wave.environment) assertEnvironment(`${spec.name}/${wave.name}`, wave.environment);
    for (const group of wave.jobs ?? []) {
      assertSetupSteps(`${spec.name}/${wave.name}/${group.name}`, group.setup ?? []);
      if (group.environment) assertEnvironment(`${spec.name}/${wave.name}/${group.name}`, group.environment);
    }
  }
  const permissions = { contents: "write", ...(byReview ? { "pull-requests": "read" } : {}) };
  // The ruling for ci-products (2026-10-28): every wave job carries its timeout and the lock wait under it.
  const timeout = opWaveJobTimeout(options.jobTimeoutMinutes);

  const jobsDoc: Record<string, unknown> = {};
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    // #3914: a job group's job runs with the group's settings over the wave's.
    const group = opWaveGroupOf(spec, job);
    // #4332: the job's cloud identities, traded before the checkout.
    const cloud = group?.cloud ?? wave.cloud;
    const environment = group?.environment ?? wave.environment;
    const idTokens = group?.idTokens ?? wave.idTokens;
    const idToken = idTokens !== undefined || cloud !== undefined;
    const runner = group?.runner ?? wave.runner ?? spec.runner;
    // #4624: the guard first, before the trade and the checkout.
    const guard = guardStep({
      forge,
      job: opWaveJobLabel(spec.name, job),
      product,
      ...(environment && forge === "github" ? { environment: environment.name } : {}),
      branches: pushBranches(spec.branches),
      ...(runner !== undefined ? { runner } : {}),
      idToken,
    });
    const steps: Array<Record<string, unknown>> = [guard, ...(cloud ? [tradeStep(cloud)] : []), checkoutStep(true)];
    if (job.kind === "share") {
      steps.push(downloadArtifactStep(`Download wave ${job.wave}'s decision`, opWaveRecordArtifact(spec, job.wave), dirnameOf(job.record!)));
    }
    if (job.needs.length > 0) {
      // #4322: every artifact of the run, so the job reads each earlier job's outcome file.
      steps.push({ name: "Download the earlier jobs' outcomes", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } });
    }
    const later: Array<Record<string, unknown>> = [];
    later.push(...[...(wave.setup ?? []), ...(group?.setup ?? [])].map(setupStepDoc), ...runSteps(options.beforeScript ?? []));
    later.push({ name: describeJob(job.kind, job.wave, wave.name, job.share, job.group), run: job.command.join(" ") });
    later.push(...runSteps(options.extraScript ?? []));
    steps.push(...(cloud ? later.map(withoutTokenRequest) : later));
    if (job.kind === "decide") {
      steps.push(keepRecordStep(`Keep wave ${job.wave}'s decision`, opWaveRecordArtifact(spec, job.wave), job.record!));
    }
    steps.push(keepRecordStep(`Keep the job's outcome`, opWaveOutcomeArtifact(spec, job.jobName), job.outcome));
    jobsDoc[job.jobName] = {
      "runs-on": githubRunsOn(runner),
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      // #4322: a wave's jobs run after a failure in the wave before; a share job runs only on its deciding job's success.
      ...(job.needs.length > 0 && job.kind !== "share" ? { if: "!cancelled()" } : {}),
      container: image,
      ...(environment ? { environment: environmentDoc(environment) } : {}),
      // #3914: a job's own permissions replace the workflow's, so they repeat them.
      ...(idToken ? { permissions: { ...permissions, "id-token": "write" } } : {}),
      "timeout-minutes": timeout.minutes,
      env: { ...timeout.env, ...(group || idTokens ? { ...wave.variables, ...group?.variables, ...idTokenAudienceEnv(idTokens) } : wave.variables) },
      steps,
    };
  }

  // #4617: once the last wave ran, one job tells the control repo how the waves ended.
  if (spec.control) {
    const [name, job] = controlJob(spec, options, jobs, image, permissions);
    jobsDoc[name] = job;
  }

  // #3761: the notify variables come from the secrets of the same name.
  const env = { ...githubSecretEnv(notifyVariables(spec.notify)), ...(options.variables ?? {}) };
  const doc: GithubOpPipelineDoc = {
    name: spec.name,
    on: { push: { branches: pushBranches(spec.branches) }, workflow_dispatch: {} },
    ...nonEmpty("env", env),
    // The ruling for ci-products (2026-10-28): no workflow-level concurrency group. Runs on the target and repo grains wait for
    // their rows on chant's ledger, oldest commit first; plunge stacks on the resource grain lease their resource rows and run.
    permissions,
    jobsDoc,
  };
  return {
    doc,
    jobs,
    ...(spec.resume ? { resumeDoc: buildResumeDoc(spec, options) } : {}),
    ...(statusBeforeMerge ? { plansDoc: buildPlansDoc(spec, options, forge) } : {}),
  };
}

/**
 * The control dispatch job (#4617): after the last wave, whatever it did,
 * the waves' outcome read from every job's outcome file, then one dispatch
 * carrying it. The pushed commit is the one every wave ran at.
 */
function controlJob(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  jobs: OpWavesPipelineResult["jobs"],
  image: string,
  permissions: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const control = spec.control!;
  const dispatch = controlDispatchJob("github", opWavesControlTarget(control), "${{ github.sha }}", {
    ...(options.words ? { words: options.words } : {}),
    ...(control.sentCheck ? { sentCheck: control.sentCheck } : {}),
    ...(control.markSent ? { markSent: control.markSent } : {}),
    outcome: true,
  });
  const marks = control.sentCheck !== undefined || control.markSent !== undefined;
  const steps: Array<Record<string, unknown>> = [
    checkoutStep(true),
    { name: "Download the waves' outcomes", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } },
    ...(spec.waves[0]?.setup ?? []).map(setupStepDoc),
    ...runSteps(options.beforeScript ?? []),
    {
      name: "Add up the waves' outcomes",
      run: `outcome="$(${opWavesOutcomeCommand(options.specFile, options.bin).join(" ")})" || exit 1\necho "${CONTROL_OUTCOME_VAR}=$outcome" >> "$GITHUB_ENV"`,
    },
    { name: `Tell the control repo ${control.repo} how ${control.member}'s waves ended`, env: { ...dispatch.env, ...(marks ? { GITHUB_TOKEN: GITHUB_JOB_TOKEN } : {}) }, run: dispatch.script },
  ];
  return [
    dispatch.name,
    {
      "runs-on": githubRunsOn(spec.runner),
      needs: opWavesLastJobs(jobs),
      // The waves ran, whatever they did: a failed run is an outcome the control repo is told about.
      if: "!cancelled()",
      container: image,
      // markSent sets a commit status; the rest reads the repository and the run's artifacts.
      permissions: marks ? { ...permissions, statuses: "write" } : permissions,
      steps,
    },
  ];
}

/** The scheduled resume workflow (#3683). */
function buildResumeDoc(spec: OpWavesSpec, options: OpWavesPipelineOptions): GithubOpPipelineDoc {
  const steps: Array<Record<string, unknown>> = [checkoutStep(), ...runSteps(options.beforeScript ?? [])];
  steps.push({
    name: `Resume the waves of ${spec.name} whose approval arrived`,
    run: opWavesResumeCommand(spec, options.bin).join(" "),
    env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN },
  });
  return {
    name: `${spec.name}-resume`,
    on: { schedule: [{ cron: spec.resume!.schedule }], workflow_dispatch: {} },
    concurrency: concurrency(`${spec.name}-resume`, true),
    // contents: read fetches chant/lifecycle; actions: write re-runs a waiting run.
    permissions: { contents: "read", actions: "write" },
    jobsDoc: { resume: { "runs-on": githubRunsOn(spec.runner), container: options.image ?? OP_WAVES_IMAGE, steps } },
  };
}

/**
 * The pull request workflow a `pr-review` wave needs (#3684): record the
 * digests each head plans. The `approval-status` job after it (#4630) posts
 * `<product>/approval` on the head, and runs alone on each review submitted
 * or dismissed. It holds a read token that may write statuses and nothing
 * else. A `pull-request` wave gets the same workflow: the record keeps its
 * change set, and the status reads the pull request's own approval of it.
 */
function buildPlansDoc(spec: OpWavesSpec, options: OpWavesPipelineOptions, forge: "github" | "forgejo"): GithubOpPipelineDoc {
  const steps: Array<Record<string, unknown>> = [checkoutStep(true), ...(spec.waves[0]?.setup ?? []).map(setupStepDoc), ...runSteps(options.beforeScript ?? [])];
  steps.push({ name: "Plan every wave at the head and record its digests", run: opWavesRecordPlansCommand(options.specFile, options.bin).join(" ") });
  const statusSteps: Array<Record<string, unknown>> = [checkoutStep(true), ...runSteps(options.beforeScript ?? [])];
  statusSteps.push({
    name: "Post the approval status on the head",
    run: opWavesApprovalStatusCommand(options.specFile, forge, options.bin).join(" "),
    env: {
      GITHUB_TOKEN: GITHUB_JOB_TOKEN,
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    },
  });
  return {
    name: `${spec.name}-plans`,
    on: { pull_request: { branches: pushBranches(spec.branches) }, pull_request_review: { types: ["submitted", "dismissed"] } },
    ...nonEmpty("env", options.variables),
    concurrency: concurrency(spec.name + "-plans-${{ github.event_name }}-${{ github.event.pull_request.number }}", true),
    // contents: write pushes the record to chant/lifecycle.
    permissions: { contents: "write" },
    jobsDoc: {
      "record-plans": { if: "github.event_name == 'pull_request'", "runs-on": githubRunsOn(spec.runner), container: options.image ?? OP_WAVES_IMAGE, steps },
      "approval-status": {
        needs: ["record-plans"],
        // On a review the record-plans job is skipped, and the status reads the plans an earlier push recorded.
        if: "${{ always() && (needs.record-plans.result == 'success' || needs.record-plans.result == 'skipped') }}",
        "runs-on": githubRunsOn(spec.runner),
        container: options.image ?? OP_WAVES_IMAGE,
        permissions: { contents: "read", "pull-requests": "read", statuses: "write" },
        steps: statusSteps,
      },
    },
  };
}

/** The apply-job guard step (#4624): the job's expectation in CHANT_JOB_GUARD, checked by `node -e` from `/`. */
function guardStep(input: Parameters<typeof jobGuardSpec>[0]): Record<string, unknown> {
  return { name: "Check the job runs where the spec set it to run", env: { [JOB_GUARD_ENV]: JSON.stringify(jobGuardSpec(input)) }, run: jobGuardLine() };
}

/** The step that trades the job's OIDC token for `cloud` (#4332), writing the credentials to GITHUB_ENV. */
function tradeStep(cloud: CloudTradeSpec): Record<string, unknown> {
  return { name: "Trade the job's OIDC token for its cloud identities", env: { [TRADE_SPEC_ENV]: JSON.stringify(cloud) }, run: tradeLine("$GITHUB_ENV", "github-env") };
}

/** A run step after the trade (#4332), with the token request variables unset first. A `uses:` step is left as it is. */
function withoutTokenRequest(step: Record<string, unknown>): Record<string, unknown> {
  return typeof step.run === "string" ? { ...step, run: `unset ${OIDC_REQUEST_VARS.join(" ")}\n${step.run}` } : step;
}

function describeJob(kind: "wave" | "decide" | "share", wave: number, name: string, share?: number, group?: string): string {
  if (kind === "decide") return `Plan wave ${wave} (${name}) and decide its gate`;
  if (group !== undefined) return `Apply ${share !== undefined ? `share ${share} of ` : ""}job group ${group} of wave ${wave} (${name})`;
  if (kind === "share") return `Apply share ${share} of wave ${wave} (${name})`;
  return `Plan, gate and apply wave ${wave} (${name})`;
}

/** Render an Op waves spec as one GitHub Actions workflow, `<name>.yml`. */
export function generateGithubOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const { doc, jobs, resumeDoc, plansDoc } = buildGithubOpWavesDoc(spec, options);
  const files = [{ name: `${spec.name}.yml`, yaml: emitOpPipelineYAML(doc) }];
  if (resumeDoc) files.push({ name: `${spec.name}-resume.yml`, yaml: emitOpPipelineYAML(resumeDoc) });
  if (plansDoc) files.push({ name: `${spec.name}-plans.yml`, yaml: emitOpPipelineYAML(plansDoc) });
  return { files, jobs };
}
