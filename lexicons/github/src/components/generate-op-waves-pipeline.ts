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
 *
 * A product's inputs (#4791) go where it used to edit them in:
 * `options.waveJobs` gives a wave's jobs steps just before the command (a
 * login), and a report step and an upload after every other step, both
 * with `if: always()`. `options.recordPlans` gives the plans job steps
 * before it plans, its `env:`, and OIDC tokens, which ask for `id-token:
 * write` on the job. Without them nothing changes.
 *
 * With `evidence` (#4870), each wave's own or deciding job signs its checks
 * (`@intentius/chant/op/op-waves-evidence-jobs`, #4926). A wave with
 * `holds.policy` runs `chant run wave --policy-only` as a step of its own
 * (`id: chant-policy`) before the command, which runs after it whether it
 * passed or failed. A job `<wave job>-evidence` after the wave job checks out
 * the base, takes back the wave job's claim files, and runs `chant ci
 * evidence sign --from-job`, which signs `policy:<wave>` when the forge
 * reports the policy step passed. A wave that trades cloud credentials and
 * signs keyless signs `plan:<wave>` there too, from the command step's
 * result, since after the trade no step of the wave job may request the
 * signing token; any other wave signs it in the command step. A later wave
 * whose `evidence.requires` names a check an evidence job signs needs it.
 *
 * With `options.renderSpec` (#4982) the job renders the spec at run time:
 * every wave, deciding and share job carries `CHANT_WAVES_SPEC_COMMAND`,
 * and its command and policy step pass `--render-spec`, so chant runs the
 * product's command for the spec at base. The jobs, their steps, the
 * trade, the evidence jobs and the gates are the ones `spec` gives.
 *
 * With `options.beforeMerge` (#4984) the workflow also runs for an open
 * pull request's head that the comment job decided: `workflow_dispatch`
 * takes the inputs `pr`, `head` and `digest`, every wave and evidence job
 * maps them into `CHANT_BEFORE_MERGE_*`, and the guard (with the job's
 * token in its step alone) admits the run only as the decision recorded on
 * `chant/lifecycle`. After the checkout a step fetches the pull request's
 * head ref, stops when it moved, keeps the default branch's commit in
 * `CHANT_WAVES_BASE` for the command's `--base`, and checks the head out,
 * before the wave's setup. The evidence job signs at the head. The control
 * job runs for a push alone, and `before-merge-done` after the last wave
 * merges and releases the locks (`chant run wave --merge`).
 *
 * #4987: with `beforeMerge` each wave, on a push as well, is four jobs
 * ({@link githubSplitJobsDoc}, `@intentius/chant/op/op-waves-split`), so the
 * change's code never runs beside a write token: `<wave>-plan` and the
 * applying job check out with git, the job's read-only token in that step
 * alone, and start every later step without the token variables;
 * `<wave>-gate` and `<wave>-record` run the default branch's code with
 * `contents: write`. Without it, each wave keeps its one job.
 *
 * #4992: a split pipeline's `rest` wave runs one wave per run. The
 * workflow takes two more inputs, `wave` and `commit`; the rest wave's jobs
 * run the wave `wave` names (their own by default) and the record job,
 * once the plan found another wave, dispatches the workflow again for it
 * (`@intentius/chant/op/op-waves-follow-on`). The jobs of the waves before
 * the rest wave do not run in such a follow-on run.
 *
 * With `options.applyStatus` (#4987) a job `apply-status-<n>` after each
 * wave, at the default branch's commit and running none of the change's
 * code, downloads the outcome files and posts the status on the push's
 * commit or the decided head (`chant run wave --apply-status`). With
 * `options.staleNotes` a `stale-notes` job beside wave 1, on a push alone,
 * marks the open pull requests' plan notes stale.
 */

import {
  notifyVariables,
  opWaveChecksDir,
  opWaveGroupOf,
  opWaveJobs,
  opWaveJobArtifactName,
  opWaveJobArtifactPaths,
  opWaveJobInputsByWave,
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
import type { OpWaveJobArtifact, OpWaveJobInputs, OpWaveRunStep, OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
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
import { assertPipelineEvidence, evidenceKeyEnv, evidenceKeyless } from "@intentius/chant/ci-evidence-jobs";
import {
  EVIDENCE_SOURCES_ENV,
  OP_WAVE_EVIDENCE_BASE_VAR,
  OP_WAVE_POLICY_STEP_ID,
  opWaveEvidenceLines,
  opWaveEvidenceNeeds,
  opWaveEvidencePlan,
  opWaveEvidenceSources,
  opWavePolicyCommand,
  opWavePolicyStepName,
  WAVE_EVIDENCE_ENV,
  type OpWaveEvidencePlan,
} from "@intentius/chant/op/op-waves-evidence-jobs";
import { opWavesRenderSpecEnv } from "@intentius/chant/op/op-waves-render-spec";
import {
  assertOpWavesBeforeMerge,
  BEFORE_MERGE_DONE_JOB,
  BEFORE_MERGE_HEAD_ENV,
  BEFORE_MERGE_INPUTS,
  BEFORE_MERGE_TOKEN_ENV,
  beforeMergeCheckoutScript,
  beforeMergeDoneCommand,
  type OpWavesBeforeMerge,
} from "@intentius/chant/op/before-merge";
import { applyStatusCommand, applyStatusJobName, assertApplyStatusContext, type OpWavesApplyStatus } from "@intentius/chant/op/apply-status";
import { PR_STALE_JOB } from "@intentius/chant/components/pr-pipeline";
import { opWaveRunRecordFileName, opWaveSavedPlanDir, opWaveSavedPlanPath, opWaveSplitJobLabel, opWaveSplitJobs, opWaveSplitLastJobs, type OpWaveSplitJob } from "@intentius/chant/op/op-waves-split";
import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, packJs, takeOverScript } from "@intentius/chant/ci-handover";
import {
  FOLLOW_ON_TOKEN_ENV,
  FORGE_TOKEN_VAR,
  followOnCommitScript,
  followOnControlSkip,
  OP_WAVES_COMMIT_ENV,
  OP_WAVES_FOLLOW_ON_ENV,
  OP_WAVES_WAVE_ENV,
  opWaveRestNotePath,
  opWaveRestPath,
  opWavesFollowOnEnv,
  opWavesRestWave,
} from "@intentius/chant/op/op-waves-follow-on";
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
  // #4982: with renderSpec each wave job renders the spec at base through the product's command; `spec` is the jobs' shape.
  const renderEnv = opWavesRenderSpecEnv(options.renderSpec);
  const forge = dialect.forge ?? "github";
  // #4984: the before-merge mode, a dispatch for a pull request's decided head, its three inputs on every job that reads them.
  const bm = options.beforeMerge;
  if (bm) assertOpWavesBeforeMerge(forge, bm);
  const bmEnv: Record<string, string> = bm ? Object.fromEntries(Object.entries(BEFORE_MERGE_INPUTS).map(([input, v]) => [v, `\${{ github.event.inputs.${input} }}`])) : {};
  const jobs = opWaveJobs(spec, options.specFile, { bin: options.bin, ...(options.renderSpec ? { renderSpec: true } : {}), ...(bm ? { beforeMerge: true } : {}) });
  // #4987: before merge each wave is a plan, a gate, an apply and a record job, so the change's code never runs beside a write token.
  const split = bm ? opWaveSplitJobs(spec, jobs) : undefined;
  // #4992: a split pipeline's rest wave runs one wave per run, each run's record job starting the next.
  const restWave = split ? opWavesRestWave(spec) : undefined;
  assertPipelineEvidence(options.evidence);
  const product = resolveProductWords(options.words ?? {}).product;
  const image = options.image ?? OP_WAVES_IMAGE;
  // `approvals.preview` reads the merged pull request from the forge, as a pr-review wave does.
  const byReview = spec.approvals?.preview === true || spec.waves.some((w) => w.approval === "pr-review");
  // #4630: a pr-review or pull-request wave gets the plans workflow and its approval status.
  const statusBeforeMerge = opWavesPostsApprovalStatus(spec);
  for (const wave of spec.waves) {
    assertSetupSteps(`${spec.name}/${wave.name}`, wave.setup ?? []);
    if (wave.environment) assertEnvironment(`${spec.name}/${wave.name}`, wave.environment);
    if (wave.planEnvironment) assertEnvironment(`${spec.name}/${wave.name} plan`, wave.planEnvironment);
    for (const group of wave.jobs ?? []) {
      assertSetupSteps(`${spec.name}/${wave.name}/${group.name}`, group.setup ?? []);
      if (group.environment) assertEnvironment(`${spec.name}/${wave.name}/${group.name}`, group.environment);
    }
  }
  const permissions = { contents: "write", ...(byReview ? { "pull-requests": "read" } : {}) };
  // The ruling for ci-products (2026-10-28): every wave job carries its timeout and the lock wait under it.
  const timeout = opWaveJobTimeout(options.jobTimeoutMinutes);
  // #4791: what the product adds to each wave's jobs.
  const inputs = opWaveJobInputsByWave(spec, options.waveJobs);

  // #4926: how each wave job signs its checks, and the evidence jobs a later wave's evidence.requires waits for.
  const evidenceOf = (job: (typeof jobs)[number]) => {
    const wave = spec.waves[job.wave - 1]!;
    const cloud = opWaveGroupOf(spec, job)?.cloud ?? wave.cloud;
    const signs = options.evidence !== undefined && (job.kind === "wave" || job.kind === "decide");
    return opWaveEvidencePlan(spec, job, { signs, keylessCloud: signs && evidenceKeyless(options.evidence) && cloud !== undefined });
  };
  const evidenceNeeds = opWaveEvidenceNeeds(spec, jobs.map((job) => ({ wave: job.wave, plan: evidenceOf(job) })));

  const jobsDoc: Record<string, unknown> = {};
  // #3761: the notify variables come from the secrets of the same name. #4987: before merge, on the jobs that run the default branch's code alone.
  const notifyEnv = githubSecretEnv(notifyVariables(spec.notify));
  if (split) Object.assign(jobsDoc, githubSplitJobsDoc({ spec, options, forge, product, image, byReview, timeout, inputs, renderEnv, bmEnv, notifyEnv, split, ...(restWave !== undefined ? { restWave } : {}) }));
  for (const job of split ? [] : jobs) {
    const wave = spec.waves[job.wave - 1]!;
    // #3914: a job group's job runs with the group's settings over the wave's.
    const group = opWaveGroupOf(spec, job);
    // #4332: the job's cloud identities, traded before the checkout.
    const cloud = group?.cloud ?? wave.cloud;
    const environment = group?.environment ?? wave.environment;
    const idTokens = group?.idTokens ?? wave.idTokens;
    // #4870: the deciding job's command signs the wave's checks; #4869: keyless, from the job's own OIDC token.
    // #4926: a wave that trades cloud credentials and signs keyless signs in its evidence job instead, since after
    // the trade no step may request the signing token; a wave's policy is signed there from its own step's result.
    const evidence = evidenceOf(job);
    const signs = evidence !== undefined && evidence.commandSigns;
    const keyless = signs && evidenceKeyless(options.evidence);
    const idToken = idTokens !== undefined || cloud !== undefined || keyless;
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
      ...(bm ? { beforeMerge: { op: spec.name } } : {}),
    });
    const steps: Array<Record<string, unknown>> = [guard, ...(cloud ? [tradeStep(cloud)] : []), checkoutStep(true)];
    // #4984: a run for a pull request's decided head checks it out before any of the change's code.
    if (bm) {
      const head = { name: "Check out the pull request's decided head", run: beforeMergeCheckoutScript(forge, product) };
      steps.push(cloud ? withoutTokenRequest(head) : head);
    }
    if (job.kind === "share") {
      steps.push(downloadArtifactStep(`Download wave ${job.wave}'s decision`, opWaveRecordArtifact(spec, job.wave), dirnameOf(job.record!)));
    }
    if (job.needs.length > 0) {
      // #4322: every artifact of the run, so the job reads each earlier job's outcome file.
      steps.push({ name: "Download the earlier jobs' outcomes", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } });
    }
    const later: Array<Record<string, unknown>> = [];
    later.push(...[...(wave.setup ?? []), ...(group?.setup ?? [])].map(setupStepDoc), ...runSteps(options.beforeScript ?? []));
    const add = inputs[job.wave - 1];
    later.push(...(add?.before ?? []).map(runStepDoc));
    // #4926: the wave's policy as a step of its own, whose result the forge reports. The command runs after it
    // whether it passed or failed (a denied run may still apply under an override), and not after any other failure.
    const policyStep = evidence?.policyStep === true;
    if (policyStep) later.push({ name: opWavePolicyStepName(job.wave, wave.name), id: OP_WAVE_POLICY_STEP_ID, run: [...(add?.prelude ?? []), opWavePolicyCommand(job).join(" ")].join("\n") });
    // #4870: the key (or #4869 the keyless signing) on that step alone.
    const commandStep = describeJob(job.kind, job.wave, wave.name, job.share, job.group);
    const commandEnv = { ...(signs ? evidenceKeyEnv(forge, options.evidence!) : {}), ...(evidence?.commandMode ? { [WAVE_EVIDENCE_ENV]: evidence.commandMode } : {}) };
    later.push({
      name: commandStep,
      ...(policyStep ? { if: `\${{ !cancelled() && (success() || steps.${OP_WAVE_POLICY_STEP_ID}.outcome == 'failure') }}` } : {}),
      ...(Object.keys(commandEnv).length > 0 ? { env: commandEnv } : {}),
      // #4984: the product's prelude in the command's own shell, so what it exports reaches the command.
      run: [...(add?.prelude ?? []), job.command.join(" ")].join("\n"),
    });
    later.push(...runSteps(options.extraScript ?? []));
    steps.push(...(cloud ? later.map(withoutTokenRequest) : later));
    if (job.kind === "decide") {
      steps.push(keepRecordStep(`Keep wave ${job.wave}'s decision`, opWaveRecordArtifact(spec, job.wave), job.record!));
    }
    steps.push(keepRecordStep(`Keep the job's outcome`, opWaveOutcomeArtifact(spec, job.jobName), job.outcome));
    // #4926: the checks' claim files, for the evidence job.
    if (evidence?.evidenceJob) steps.push(keepRecordStep(`Keep the job's check claims`, opWaveChecksArtifact(spec, job.jobName), opWaveChecksDir(spec)));
    const report = reportSteps(add, job.jobName);
    steps.push(...(cloud ? report.map(withoutTokenRequest) : report));
    const needs = [...job.needs, ...(job.kind === "share" ? [] : evidenceNeeds(job.wave))];
    jobsDoc[job.jobName] = {
      "runs-on": githubRunsOn(runner),
      ...(needs.length > 0 ? { needs } : {}),
      // #4322: a wave's jobs run after a failure in the wave before; a share job runs only on its deciding job's success.
      ...(job.needs.length > 0 && job.kind !== "share" ? { if: "!cancelled()" } : {}),
      container: image,
      ...(environment ? { environment: environmentDoc(environment) } : {}),
      // #3914: a job's own permissions replace the workflow's, so they repeat them.
      ...(idToken ? { permissions: { ...permissions, "id-token": "write" } } : {}),
      "timeout-minutes": timeout.minutes,
      env: { ...timeout.env, ...renderEnv, ...bmEnv, ...(group || idTokens ? { ...wave.variables, ...group?.variables, ...idTokenAudienceEnv(idTokens) } : wave.variables) },
      steps,
    };
    if (evidence?.evidenceJob) jobsDoc[evidence.evidenceJob.name] = evidenceJob(spec, options, forge, job, evidence, commandStep, image, permissions, bmEnv);
  }

  // #4617: once the last wave ran, one job tells the control repo how the waves ended. #4984: a push's run only.
  // #4987: a split pipeline's waves end with the last wave's record job.
  const last = split ? opWaveSplitLastJobs(spec) : opWavesLastJobs(jobs);
  if (spec.control) {
    const [name, job] = controlJob(spec, options, last, image, permissions, restWave !== undefined ? product : undefined);
    jobsDoc[name] = bm ? { ...job, if: "${{ !cancelled() && github.event.inputs.head == '' }}" } : job;
  }
  // #4984: after a before-merge run's last wave, the merge and the release of the change's locks.
  if (bm) jobsDoc[BEFORE_MERGE_DONE_JOB] = beforeMergeDoneJob(spec, options, bm, forge, last, image, bmEnv, restWave !== undefined);
  // #4987: each wave's apply status, from a job that runs none of the change's code.
  if (options.applyStatus) {
    assertApplyStatusContext(options.applyStatus.context);
    for (let k = 1; k <= spec.waves.length; k++) {
      const status = applyStatusJob(spec, options, options.applyStatus, forge, split ?? jobs, k, image, bmEnv, restWave);
      jobsDoc[applyStatusJobName(k)] = restWave !== undefined && k < restWave ? beforeFollowOn(status) : status;
    }
  }
  // #4987: a push marks the open pull requests' plan notes stale, beside wave 1.
  if (options.staleNotes) jobsDoc[PR_STALE_JOB] = staleNotesJob(spec, options, options.staleNotes, image);

  // #3761: the notify variables come from the secrets of the same name; #4987: a split pipeline's gate and record jobs carry them.
  const env = { ...(split ? {} : notifyEnv), ...(options.variables ?? {}) };
  const doc: GithubOpPipelineDoc = {
    name: spec.name,
    on: { push: { branches: pushBranches(spec.branches) }, workflow_dispatch: bm ? { inputs: { ...BEFORE_MERGE_DISPATCH_INPUTS, ...(restWave !== undefined ? FOLLOW_ON_DISPATCH_INPUTS : {}) } } : {} },
    ...nonEmpty("env", env),
    // The ruling for ci-products (2026-10-28): no workflow-level concurrency group. Runs on the target and repo grains wait for
    // their rows on chant's ledger, oldest commit first; plunge stacks on the resource grain lease their resource rows and run.
    permissions,
    jobsDoc,
  };
  return {
    doc,
    jobs: split ?? jobs,
    ...(spec.resume ? { resumeDoc: buildResumeDoc(spec, options) } : {}),
    ...(statusBeforeMerge ? { plansDoc: buildPlansDoc(spec, options, forge) } : {}),
  };
}

/** The artifact a split wave's plan job keeps its saved plan and plan files in (#4987). */
export function opWavePlanArtifact(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `${spec.name}-wave-${wave}-plan`;
}

/** The step names of a split wave's jobs (#4987), which a reader of the run (and an evidence job) finds them by. */
export function splitStepName(job: Pick<OpWaveSplitJob, "phase" | "wave" | "waveName" | "share" | "group">): string {
  const wave = `wave ${job.wave} (${job.waveName})`;
  if (job.phase === "plan") return `Plan ${wave} and save the plan`;
  if (job.phase === "gate") return `Decide ${wave}'s gate on the saved plan`;
  if (job.phase === "record") return `Write ${wave}'s run records`;
  if (job.group !== undefined || job.share !== undefined) return `${describeJob("share", job.wave, job.waveName, job.share, job.group)} from the saved plan`;
  return `Apply ${wave}'s saved plan`;
}

/** What the split jobs read from the pipeline they are in (#4987). */
interface SplitJobsInput {
  spec: OpWavesSpec;
  options: OpWavesPipelineOptions;
  forge: "github" | "forgejo";
  product: string;
  image: string;
  byReview: boolean;
  timeout: { minutes: number; env: Record<string, string> };
  inputs: Array<OpWaveJobInputs | undefined>;
  renderEnv: Record<string, string>;
  bmEnv: Record<string, string>;
  notifyEnv: Record<string, string>;
  split: OpWaveSplitJob[];
  /** The rest wave's number (#4992), when the last wave has `rest`. */
  restWave?: number;
}

/**
 * Where a rest wave's path (#4992) names its wave: {@link fillRestWave}
 * puts `CHANT_WAVES_WAVE` there, as `${{ env.… }}` in a `with:` and as the
 * shell variable in a `run:`, where every such path sits in single quotes.
 * Plain letters and underscores, so the hand-off's note files take it.
 */
const REST_WAVE_MARK = "__chant_rest_wave__";

/** A rest wave job's steps with {@link REST_WAVE_MARK} filled in (#4992). */
function fillRestWave(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return steps.map((step) => {
    const out: Record<string, unknown> = { ...step };
    if (typeof step.run === "string") out.run = step.run.replaceAll(REST_WAVE_MARK, `'"$${OP_WAVES_WAVE_ENV}"'`);
    if (step.with && typeof step.with === "object") {
      out.with = Object.fromEntries(Object.entries(step.with as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v.replaceAll(REST_WAVE_MARK, `\${{ env.${OP_WAVES_WAVE_ENV} }}`) : v]));
    }
    return out;
  });
}

/**
 * The variables of a rest wave's jobs (#4992): the wave they run, a
 * follow-on run's or their own, and the commit a push's follow-on goes on with.
 */
function followOnEnv(restWave: number): Record<string, string> {
  return { [OP_WAVES_WAVE_ENV]: `\${{ github.event.inputs.wave || '${restWave}' }}`, [OP_WAVES_COMMIT_ENV]: "${{ github.event.inputs.commit }}" };
}

/** A job of a wave before the rest wave (#4992): it does not run in a follow-on run, which names a wave. */
function beforeFollowOn(job: Record<string, unknown>): Record<string, unknown> {
  const cond = typeof job.if === "string" ? job.if.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1") : undefined;
  return { ...job, if: `\${{ ${cond ? `(${cond}) && ` : ""}github.event.inputs.wave == '' }}` };
}

/** The `workflow_dispatch` inputs a follow-on run of the rest wave carries (#4992), which its record job fills. */
export const FOLLOW_ON_DISPATCH_INPUTS: Record<string, { description: string; required: false; type: "string" }> = {
  wave: { description: "Follow-on: the wave past the listed ones that the rest wave's jobs run", required: false, type: "string" },
  commit: { description: "Follow-on of a push: the pushed commit the waves go on with", required: false, type: "string" },
};

/**
 * The jobs of a before-merge pipeline, each wave split in four (#4987,
 * `@intentius/chant/op/op-waves-split`).
 *
 * The plan and apply jobs run the change's code. Their token can only read
 * (`contents: read`), it reaches the checkout's fetches through the
 * environment of that one step and never the git config, and every later
 * run step starts again without the token variables (`dropForgeTokens`).
 * They hold no signing identity: with `evidence`, each wave's evidence job
 * signs the plan job's checks from its step results. The plan job keeps
 * the saved plan as an artifact; the apply job downloads it with the
 * decision and leaves its run record beside its outcome.
 *
 * The gate and record jobs check out the default branch, fetch the decided
 * head without checking it out (its commit and notes are what they read),
 * and run the command with `contents: write`. They alone carry the notify
 * secrets. Forgejo ignores `permissions:`, so its job token can write; the
 * plan and apply jobs keep it to the checkout step there too.
 *
 * #4992: the rest wave's jobs run the wave `CHANT_WAVES_WAVE` names (the
 * `wave` input of a follow-on run, else their own), keep their files at
 * that wave's paths, and in a push's follow-on check out the `commit` input
 * once it is on the branch. Its record job may start the follow-on: on
 * GitHub with the job's token and `actions: write`, on Forgejo with the
 * `CHANT_FORGE_TOKEN` secret, in that step alone; it keeps the rest wave's
 * note. The jobs of the waves before it do not run in a follow-on.
 */
function githubSplitJobsDoc(input: SplitJobsInput): Record<string, unknown> {
  const { spec, options, forge, product, image, byReview, timeout, inputs, renderEnv, bmEnv, notifyEnv, split, restWave } = input;
  const follow = restWave !== undefined ? followOnEnv(restWave) : {};
  // #4992: Forgejo's plan and applying jobs hand their files on as job outputs, never through the artifact upload.
  const handover = forge === "forgejo";
  const evidenceOf = (job: OpWaveSplitJob) => (job.phase === "plan" && options.evidence !== undefined ? opWaveEvidencePlan(spec, job, { signs: true, keylessCloud: false, keyOutOfWave: true }) : undefined);
  const evidenceNeeds = opWaveEvidenceNeeds(spec, split.map((job) => ({ wave: job.wave, plan: evidenceOf(job) })));
  const branches = pushBranches(spec.branches);
  const out: Record<string, unknown> = {};
  for (const job of split) {
    const k = job.wave;
    const wave = spec.waves[k - 1]!;
    const add = inputs[k - 1];
    // #4992: the rest wave's jobs run the wave a follow-on names; the jobs of the waves before it do not run in one.
    const rest = job.rest === true;
    const restEnv = rest ? follow : {};
    const finish = (doc: Record<string, unknown>, steps: Array<Record<string, unknown>>): Record<string, unknown> => {
      const filled = { ...doc, steps: rest ? fillRestWave(steps) : steps };
      return restWave !== undefined && k < restWave ? beforeFollowOn(filled) : filled;
    };
    const followCommit = rest ? [{ name: "Check out the commit a push's follow-on goes on with", run: followOnCommitScript(product) }] : [];
    if (!job.runsChange) {
      // The gate and record jobs: the default branch's code, with the token.
      const gate = job.phase === "gate";
      // #4992: on Forgejo the plan and applying jobs hand their files on as job outputs; these jobs take them back and keep them as artifacts.
      const from = gate ? split.filter((j) => j.jobName === job.needs[0]) : split.filter((j) => j.phase === "apply" && job.needs.includes(j.jobName));
      const takeOver = handover ? from.map((j) => takeOverStep(spec, j, handedPaths(spec, j, add))) : [];
      // #4992: the rest wave's record job starts the follow-on run, with a token that may, in its own step alone.
      const starts = rest && !gate;
      const startEnv = starts
        ? { [OP_WAVES_FOLLOW_ON_ENV]: opWavesFollowOnEnv({ forge, workflow: `${spec.name}.yml` }), [FOLLOW_ON_TOKEN_ENV]: forge === "github" ? GITHUB_JOB_TOKEN : `\${{ secrets.${FORGE_TOKEN_VAR} }}` }
        : undefined;
      const steps: Array<Record<string, unknown>> = [
        guardStep({ forge, job: opWaveSplitJobLabel(spec.name, job), product, branches, ...(spec.runner !== undefined ? { runner: spec.runner } : {}), idToken: false, beforeMerge: { op: spec.name }, ...(rest ? { rest: k } : {}) }),
        checkoutStep(true),
        ...followCommit,
        // The gate reads the head's commit, its notes and its wave stop, and stops when the pull request moved; the
        // record job writes what the applying jobs ran, whatever the pull request did since.
        ...(gate
          ? [
              { name: "Fetch the pull request's decided head without checking it out", run: beforeMergeCheckoutScript(forge, product, { checkout: false }) },
              ...(handover ? takeOver : [downloadArtifactStep(`Download wave ${k}'s saved plan`, opWavePlanArtifact(spec, k), restAt(job, opWaveSavedPlanDir(spec, k)))]),
            ]
          : [
              { name: "Download the waves' outcomes and run records", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } },
              ...takeOver,
              // #4992: the decision names the rows the gate job leased, which this job lets go of.
              downloadArtifactStep(`Download wave ${k}'s decision`, opWaveRecordArtifact(spec, k), dirnameOf(job.record!)),
            ]),
        ...(wave.setup ?? []).map(setupStepDoc),
        ...runSteps(options.beforeScript ?? []),
        { name: splitStepName(job), ...(startEnv ? { env: startEnv } : {}), run: job.command.join(" ") },
      ];
      if (gate) {
        steps.push(keepRecordStep(`Keep wave ${k}'s decision`, opWaveRecordArtifact(spec, k), restAt(job, job.record!)));
        steps.push(keepRecordStep(`Keep the job's outcome`, opWaveOutcomeArtifact(spec, job.jobName), restAt(job, job.outcome)));
        // #4994: the product's report of the decision its after-gate hooks wrote, kept whatever the job's exit.
        steps.push(...reportSteps(add?.gate, job.jobName));
      }
      // #4992: the rest wave's note, which says whether this run started a follow-on, for the jobs after the waves.
      if (starts) steps.push(keepRecordStep("Keep the rest wave's note", opWaveOutcomeArtifact(spec, job.jobName), opWaveRestNotePath(spec)));
      // What the plan or applying jobs handed on, kept as the artifacts they keep on GitHub.
      if (handover) for (const j of from) steps.push(...keptHandedSteps(spec, j, add));
      out[job.jobName] = finish(
        {
          "runs-on": githubRunsOn(spec.runner),
          needs: job.needs,
          // The gate decides whatever its plan job ended (a plan that failed is recorded there); the record job writes what the applying jobs ran.
          if: gate ? "${{ !cancelled() }}" : "${{ !cancelled() && !contains(needs.*.result, 'skipped') }}",
          container: image,
          // #4992: the rest wave's record job dispatches the follow-on run.
          permissions: { contents: "write", ...(gate && byReview ? { "pull-requests": "read" } : {}), ...(starts ? { actions: "write" } : {}) },
          // #4992: the gate job of a step spec waits for its rows on the ledger, up to the job's timeout.
          ...(gate ? { "timeout-minutes": timeout.minutes } : {}),
          env: { ...(gate ? timeout.env : {}), ...renderEnv, ...bmEnv, ...restEnv, ...notifyEnv, ...(wave.variables ?? {}) },
        },
        steps,
      );
      continue;
    }
    // The plan and apply jobs: the change's code, with no write token.
    const group = opWaveGroupOf(spec, job);
    const cloud = group?.cloud ?? wave.cloud;
    // #4992: the applying job is the deployment, so the wave's environment (and its reviewers) is on it alone; the plan
    // job names the wave's `planEnvironment`, one with no reviewers, when the plan needs an environment's secrets or claim.
    const environment = job.phase === "plan" ? wave.planEnvironment : (group?.environment ?? wave.environment);
    const idTokens = group?.idTokens ?? wave.idTokens;
    const idToken = idTokens !== undefined || cloud !== undefined;
    const runner = group?.runner ?? wave.runner ?? spec.runner;
    const evidence = evidenceOf(job);
    const noToken = (step: Record<string, unknown>): Record<string, unknown> =>
      typeof step.run === "string" ? { ...step, run: `${dropForgeTokens("sh", cloud ? OIDC_REQUEST_VARS : [])}\n${step.run}` } : step;
    const checkout = {
      name: "Check out the default branch and the pull request's decided head, with the token in this step alone",
      env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN },
      // #4992: a push's follow-on checks out the commit it goes on with, once it is on the branch.
      run: [checkoutScript(true), beforeMergeCheckoutScript(forge, product), ...(rest ? [followOnCommitScript(product)] : [])].join("\n"),
    };
    const steps: Array<Record<string, unknown>> = [
      guardStep({ forge, job: opWaveSplitJobLabel(spec.name, job), product, ...(environment && forge === "github" ? { environment: environment.name } : {}), branches, ...(runner !== undefined ? { runner } : {}), idToken, beforeMerge: { op: spec.name }, ...(rest ? { rest: k } : {}) }),
      ...(cloud ? [tradeStep(cloud)] : []),
      cloud ? withoutTokenRequest(checkout) : checkout,
    ];
    if (job.phase === "apply") {
      steps.push(downloadArtifactStep(`Download wave ${k}'s decision`, opWaveRecordArtifact(spec, k), dirnameOf(job.record!)));
      steps.push(downloadArtifactStep(`Download wave ${k}'s saved plan`, opWavePlanArtifact(spec, k), restAt(job, opWaveSavedPlanDir(spec, k))));
    }
    if (job.phase === "apply" || job.needs.length > 0) steps.push({ name: "Download the earlier jobs' outcomes", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } });
    const later: Array<Record<string, unknown>> = [...[...(wave.setup ?? []), ...(group?.setup ?? [])].map(setupStepDoc), ...runSteps(options.beforeScript ?? []), ...(add?.before ?? []).map(runStepDoc)];
    const policyStep = evidence?.policyStep === true;
    if (policyStep) later.push({ name: opWavePolicyStepName(k, wave.name), id: OP_WAVE_POLICY_STEP_ID, run: [...(add?.prelude ?? []), opWavePolicyCommand(job).join(" ")].join("\n") });
    const commandStep = splitStepName(job);
    later.push({
      name: commandStep,
      ...(policyStep ? { if: `\${{ !cancelled() && (success() || steps.${OP_WAVE_POLICY_STEP_ID}.outcome == 'failure') }}` } : {}),
      ...(evidence?.commandMode ? { env: { [WAVE_EVIDENCE_ENV]: evidence.commandMode } } : {}),
      run: [...(add?.prelude ?? []), job.command.join(" ")].join("\n"),
    });
    later.push(...runSteps(options.extraScript ?? []));
    steps.push(...later.map(noToken));
    if (handover) {
      // #4992: Forgejo's artifact upload takes the runner's token, which no setting limits, beside whatever the change's
      // code left running. The job's report runs as on GitHub; its files go on as the job's outputs, from a last step
      // with no token, and the gate or record job keeps them as the artifacts.
      steps.push(...(add?.report ? [noToken({ name: add.report.name, if: "always()", run: add.report.run.join("\n") })] : []));
      steps.push(noToken(handOverStep(spec, job, handedPaths(spec, job, add))));
    } else {
      if (job.phase === "plan") steps.push(keepRecordStep(`Keep wave ${k}'s saved plan`, opWavePlanArtifact(spec, k), restAt(job, opWaveSavedPlanDir(spec, k))));
      steps.push(keepRecordStep(job.phase === "apply" ? "Keep the job's outcome and run record" : "Keep the job's outcome", opWaveOutcomeArtifact(spec, job.jobName), keptOutcome(spec, job)));
      if (evidence?.evidenceJob) steps.push(keepRecordStep(`Keep the job's check claims`, opWaveChecksArtifact(spec, job.jobName), opWaveChecksDir(spec)));
      steps.push(...reportSteps(add, job.jobName).map(noToken));
    }
    const needs = [...job.needs, ...(job.phase === "plan" ? evidenceNeeds(k) : [])];
    out[job.jobName] = finish(
      {
        "runs-on": githubRunsOn(runner),
        ...(needs.length > 0 ? { needs } : {}),
        // An applying job applies what its gate job decided; a plan job after the first wave runs after a failure in the wave before.
        ...(job.phase === "apply" ? { if: `\${{ !cancelled() && needs.${job.needs[0]}.result == 'success' }}` } : job.needs.length > 0 ? { if: "!cancelled()" } : {}),
        container: image,
        ...(environment ? { environment: environmentDoc(environment) } : {}),
        // The job's token reads; the checkout step alone holds it.
        permissions: { contents: "read", ...(idToken ? { "id-token": "write" } : {}) },
        "timeout-minutes": timeout.minutes,
        env: { ...timeout.env, ...renderEnv, ...bmEnv, ...restEnv, ...(group || idTokens ? { ...wave.variables, ...group?.variables, ...idTokenAudienceEnv(idTokens) } : wave.variables) },
        ...(handover ? { outputs: handoverOutputs(SPLIT_HANDOVER_STEP, "forgejo") } : {}),
      },
      steps,
    );
    if (evidence?.evidenceJob) {
      // #4992: on Forgejo the evidence job takes the claims back from the plan job's outputs.
      const claims = handover ? takeOverStep(spec, job, [opWaveChecksDir(spec)], "Take the plan job's check claims from its outputs") : undefined;
      const signer = evidenceJob(spec, options, forge, job, evidence, commandStep, image, { contents: "write", ...(byReview ? { "pull-requests": "read" } : {}) }, { ...bmEnv, ...restEnv }, claims, rest ? product : undefined);
      out[evidence.evidenceJob.name] = restWave !== undefined && k < restWave ? beforeFollowOn(signer) : signer;
    }
  }
  return out;
}

/** The step a Forgejo plan or applying job hands its files on from (#4992), whose outputs the job's are. */
export const SPLIT_HANDOVER_STEP = "chant-handover";

/** Where a split job's handed files are gathered, and taken back into, by the job that handed them (#4992). */
export function splitHandoverDir(spec: Pick<OpWavesSpec, "name">, jobName: string): string {
  return `.chant/op-waves/${spec.name}/handover/${jobName}`;
}

/** A path of a split job's wave, a rest wave's with {@link REST_WAVE_MARK} for its wave (#4992). */
function restAt(job: Pick<OpWaveSplitJob, "rest" | "wave">, path: string): string {
  return job.rest ? opWaveRestPath(path, job.wave, REST_WAVE_MARK) : path;
}

/** What a plan or applying job keeps as its outcome artifact: its outcome file, and an applying job's run record. */
function keptOutcome(spec: OpWavesSpec, job: OpWaveSplitJob): string {
  return job.phase === "apply" ? `${restAt(job, job.outcome)}\n${runRecordPath(spec, job)}` : restAt(job, job.outcome);
}

/** The file an applying job leaves its run record in (#4987). */
function runRecordPath(spec: OpWavesSpec, job: OpWaveSplitJob): string {
  return restAt(job, `${opWaveOutcomeDir(spec)}/${opWaveRunRecordFileName(job.wave, { ...(job.group !== undefined ? { group: job.group } : {}), ...(job.share !== undefined ? { share: job.share } : {}) })}`);
}

/**
 * The files a Forgejo plan or applying job hands on (#4992), relative to
 * the job's directory: the plan job's saved plan and plan files, its outcome
 * and its check claims; an applying job's outcome and run record; and the
 * product's artifact path either keeps.
 */
function handedPaths(spec: OpWavesSpec, job: OpWaveSplitJob, add: OpWaveJobInputs | undefined): string[] {
  const own = job.phase === "plan" ? [restAt(job, opWaveSavedPlanDir(spec, job.wave)), restAt(job, job.outcome), opWaveChecksDir(spec)] : [restAt(job, job.outcome), runRecordPath(spec, job)];
  return [...own, ...(add?.artifact ? opWaveJobArtifactPaths(add.artifact) : [])];
}

/** The files a too large hand-off is cut to (#4992): the saved plan or run record, and the outcome. */
function handedCore(spec: OpWavesSpec, job: OpWaveSplitJob): string[] {
  return job.phase === "plan" ? [restAt(job, opWaveSavedPlanPath(spec, job.wave)), restAt(job, job.outcome)] : [runRecordPath(spec, job), restAt(job, job.outcome)];
}

/** A word in single quotes, for a shell line. */
function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The last step of a Forgejo plan or applying job (#4992): copy the files
 * the job hands on into {@link splitHandoverDir}, at their own paths, and
 * pack that directory into the step's outputs (`packJs`), as the plan-note
 * handover does. It runs whatever the job ended, and the caller starts it
 * without the token variables.
 */
function handOverStep(spec: OpWavesSpec, job: OpWaveSplitJob, paths: readonly string[]): Record<string, unknown> {
  const stage = splitHandoverDir(spec, job.jobName);
  return {
    name: "Hand the job's files to the next job as its outputs",
    id: SPLIT_HANDOVER_STEP,
    if: "always()",
    run: [
      `chant_stage="$PWD/${stage}"`,
      'mkdir -p "$chant_stage"',
      `for p in ${paths.map(shellWord).join(" ")}; do if [ -e "$p" ]; then mkdir -p "$chant_stage/$(dirname "$p")" && cp -R "$p" "$chant_stage/$(dirname "$p")/"; fi; done`,
      `node -e '${packJs("forgejo", { noteFiles: handedCore(spec, job), label: "chant" })}' "$chant_stage" "\${GITHUB_OUTPUT:-/dev/null}"`,
    ].join("\n"),
  };
}

/**
 * The step that takes back what a Forgejo plan or applying job handed on
 * (#4992): its outputs unpacked into {@link splitHandoverDir} (a path that
 * is not plain segments is left out), then only `paths` copied to where the
 * job left them, so nothing the change's code wrote lands anywhere else in
 * this job's checkout.
 */
function takeOverStep(spec: OpWavesSpec, from: OpWaveSplitJob, paths: readonly string[], name = `Take ${opWaveSplitJobLabel(spec.name, from)}'s files from its outputs`): Record<string, unknown> {
  const stage = splitHandoverDir(spec, from.jobName);
  return {
    name,
    run: [
      takeOverScript(from.jobName, stage, "forgejo"),
      `for p in ${paths.map(shellWord).join(" ")}; do if [ -e "${stage}/$p" ]; then mkdir -p "$(dirname "$p")" && cp -R "${stage}/$p" "$(dirname "$p")/"; fi; done`,
    ].join("\n"),
  };
}

/** The artifacts a gate or record job keeps for what a Forgejo plan or applying job handed on (#4992), as that job keeps them on GitHub. */
function keptHandedSteps(spec: OpWavesSpec, job: OpWaveSplitJob, add: OpWaveJobInputs | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (job.phase === "plan") {
    out.push(keepRecordStep(`Keep wave ${job.wave}'s saved plan`, opWavePlanArtifact(spec, job.wave), restAt(job, opWaveSavedPlanDir(spec, job.wave))));
  } else {
    out.push(keepRecordStep(`Keep ${opWaveSplitJobLabel(spec.name, job)}'s outcome and run record`, opWaveOutcomeArtifact(spec, job.jobName), keptOutcome(spec, job)));
  }
  if (add?.artifact) out.push(keepArtifactStep(add.artifact, job.jobName));
  return out;
}

/** The upload of a product's artifact of a wave job (#4791), whatever the job's exit: each of its paths (#4994), `{job}` the job's name. */
function keepArtifactStep(artifact: OpWaveJobArtifact, jobName: string): Record<string, unknown> {
  return keepRecordStep(artifact.step, opWaveJobArtifactName(artifact.name, jobName), opWaveJobArtifactPaths(artifact).join("\n"));
}

/** The artifact a wave job keeps its checks' claim files in (#4926). */
export function opWaveChecksArtifact(spec: Pick<OpWavesSpec, "name">, jobName: string): string {
  return `${spec.name}-${jobName}-checks`;
}

/**
 * A wave job's evidence job (#4926): after the wave job, whatever it did,
 * it checks out the base so none of the change's code runs, takes back the
 * wave job's claim files, and signs each check whose step the forge reports
 * passed, with the job token reading the run's jobs. Signing keyless, it
 * asks for its own OIDC token.
 */
function evidenceJob(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  forge: "github" | "forgejo",
  job: OpWavesPipelineResult["jobs"][number],
  evidence: OpWaveEvidencePlan,
  commandStep: string,
  image: string,
  permissions: Record<string, unknown>,
  bmEnv: Record<string, string> = {},
  claims?: Record<string, unknown>,
  restProduct?: string,
): Record<string, unknown> {
  const wave = spec.waves[job.wave - 1]!;
  // #4984: a before-merge run applied the decided head, so its checks are signed at it.
  const bm = options.beforeMerge !== undefined;
  // #4992: a push's follow-on of the rest wave applied the commit it goes on with; this job checks it out first.
  const pushed = restProduct !== undefined ? `\${${OP_WAVES_COMMIT_ENV}:-$GITHUB_SHA}` : "$GITHUB_SHA";
  const lines = opWaveEvidenceLines(spec, evidence, job, { sha: bm ? `"\${${BEFORE_MERGE_HEAD_ENV}:-${pushed}}"` : '"$GITHUB_SHA"', ...(options.bin ? { bin: options.bin } : {}), ...(bm ? { beforeMerge: true } : {}) });
  const sources = opWaveEvidenceSources(forge, evidence, job, wave.name, commandStep);
  return {
    "runs-on": githubRunsOn(spec.runner),
    needs: [job.jobName],
    // The wave job's steps say what passed, whatever the job's own result.
    if: "!cancelled()",
    container: image,
    ...(Object.keys(bmEnv).length > 0 ? { env: bmEnv } : {}),
    // contents: write pushes the evidence notes; actions: read lists the run's jobs.
    permissions: { ...permissions, actions: "read", ...(evidenceKeyless(options.evidence) ? { "id-token": "write" } : {}) },
    steps: [
      checkoutStep(true),
      { name: "Check out the base, so none of the change's code runs here", run: [...(restProduct !== undefined ? [followOnCommitScript(restProduct)] : []), ...lines.checkout, `echo "${OP_WAVE_EVIDENCE_BASE_VAR}=$${OP_WAVE_EVIDENCE_BASE_VAR}" >> "$GITHUB_ENV"`].join("\n") },
      ...(wave.setup ?? []).map(setupStepDoc),
      ...runSteps(options.beforeScript ?? []),
      // A wave job that stopped before its checks kept no claims, so there is nothing to download. The signing step
      // runs anyway and signs nothing, saying why (Forgejo drops `continue-on-error`, hence the step's own `if:`).
      // #4992: `claims`, a step that takes them from a Forgejo plan job's outputs.
      claims ?? { ...downloadArtifactStep("Download the wave job's check claims", opWaveChecksArtifact(spec, job.jobName), opWaveChecksDir(spec)), "continue-on-error": true },
      {
        name: `Sign wave ${job.wave} (${wave.name})'s checks from the job's step results`,
        if: "!cancelled()",
        env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN, [EVIDENCE_SOURCES_ENV]: JSON.stringify(sources), ...evidenceKeyEnv(forge, options.evidence!) },
        run: lines.sign.join("\n"),
      },
    ],
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
  last: string[],
  image: string,
  permissions: Record<string, unknown>,
  restProduct?: string,
): [string, Record<string, unknown>] {
  const control = spec.control!;
  // #4992: a push's follow-on run tells the control repo about the commit the waves went on with.
  const dispatch = controlDispatchJob("github", opWavesControlTarget(control), restProduct !== undefined ? "${{ github.event.inputs.commit || github.sha }}" : "${{ github.sha }}", {
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
    // #4992: a run that started a follow-on added up no outcome, and sends none.
    { name: `Tell the control repo ${control.repo} how ${control.member}'s waves ended`, env: { ...dispatch.env, ...(marks ? { GITHUB_TOKEN: GITHUB_JOB_TOKEN } : {}) }, run: restProduct !== undefined ? `${followOnControlSkip(restProduct)}\n${dispatch.script}` : dispatch.script },
  ];
  return [
    dispatch.name,
    {
      "runs-on": githubRunsOn(spec.runner),
      needs: last,
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
  // #4791: the product's steps before the job plans, its variables and its OIDC tokens.
  const add = options.recordPlans;
  steps.push(...(add?.before ?? []).map(runStepDoc));
  const idTokens = add?.idTokens && Object.keys(add.idTokens).length > 0 ? add.idTokens : undefined;
  const env = { ...(add?.variables ?? {}), ...idTokenAudienceEnv(idTokens) };
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
      "record-plans": {
        if: "github.event_name == 'pull_request'",
        "runs-on": githubRunsOn(spec.runner),
        container: options.image ?? OP_WAVES_IMAGE,
        ...(idTokens ? { permissions: { contents: "write", "id-token": "write" } } : {}),
        ...nonEmpty("env", env),
        steps,
      },
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

/** A product's run step (#4791): its lines, one after another. */
function runStepDoc(step: OpWaveRunStep): Record<string, unknown> {
  return { name: step.name, run: step.run.join("\n") };
}

/** A wave job's report and the upload of what it wrote (#4791), after every other step and whatever the exit. */
function reportSteps(add: Pick<OpWaveJobInputs, "report" | "artifact"> | undefined, jobName: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (add?.report) out.push({ name: add.report.name, if: "always()", run: add.report.run.join("\n") });
  if (add?.artifact) out.push(keepArtifactStep(add.artifact, jobName));
  return out;
}

/** The apply-job guard step (#4624): the job's expectation in CHANT_JOB_GUARD, checked by `node -e` from `/`. */
function guardStep(input: Parameters<typeof jobGuardSpec>[0]): Record<string, unknown> {
  // #4984: before merge the guard reads the decision from chant/lifecycle with the job's token, in this step alone.
  return { name: "Check the job runs where the spec set it to run", env: { [JOB_GUARD_ENV]: JSON.stringify(jobGuardSpec(input)), ...(input.beforeMerge ? { GITHUB_TOKEN: GITHUB_JOB_TOKEN } : {}) }, run: jobGuardLine() };
}

/** The `workflow_dispatch` inputs of the before-merge mode (#4984), which the comment job fills. */
export const BEFORE_MERGE_DISPATCH_INPUTS: Record<string, { description: string; required: false; type: "string" }> = {
  pr: { description: "Before merge: the pull request whose decided head the waves apply", required: false, type: "string" },
  head: { description: "Before merge: the decided head, a commit sha", required: false, type: "string" },
  digest: { description: "Before merge: the digest of the decision on chant/lifecycle", required: false, type: "string" },
};

/**
 * The job after a before-merge run's last wave (#4984): at the default
 * branch's commit, with every job's outcome file, `chant run wave --merge`
 * checks the decision again, that every wave applied, and then merges the
 * pull request at its decided head and releases its locks (`auto`), or
 * says it is ready (`manual`). It runs none of the change's code, so it is
 * the one job that holds the merge token.
 */
function beforeMergeDoneJob(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  bm: OpWavesBeforeMerge,
  forge: "github" | "forgejo",
  last: string[],
  image: string,
  bmEnv: Record<string, string>,
  rest = false,
): Record<string, unknown> {
  const token = bm.merge === "auto" && bm.mergeTokenSecret ? { [BEFORE_MERGE_TOKEN_ENV]: `\${{ secrets.${bm.mergeTokenSecret} }}` } : {};
  return {
    "runs-on": githubRunsOn(spec.runner),
    needs: last,
    // Every wave job succeeded; a wave that waits or fails leaves the pull request as it is. #4992: in a follow-on run the
    // waves before the rest wave were skipped, which success() counts against it, so it reads the last wave's own result.
    if: rest ? "${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'skipped') && github.event.inputs.head != '' }}" : "${{ success() && github.event.inputs.head != '' }}",
    container: image,
    // contents: write releases the locks on chant/lifecycle; pull-requests: write merges and replies.
    permissions: { contents: "write", "pull-requests": "write", statuses: "read", checks: "read" },
    env: bmEnv,
    steps: [
      checkoutStep(true),
      { name: "Download the waves' outcomes", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } },
      ...(spec.waves[0]?.setup ?? []).map(setupStepDoc),
      ...runSteps(options.beforeScript ?? []),
      {
        name: bm.merge === "auto" ? "Merge the pull request whose head the waves applied" : "Say the pull request's head applied",
        env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN, ...token },
        run: beforeMergeDoneCommand(spec, forge, bm, options.bin),
      },
    ],
  };
}

/**
 * The job after wave `k` that posts its apply status (#4987): at the
 * default branch's commit, with every outcome file of the run, it posts
 * the status on the push's commit, or on a before-merge run's decided
 * head. It runs after the wave whatever the wave did, and none of the
 * change's code, so it is the job that holds `statuses: write`.
 */
function applyStatusJob(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  status: OpWavesApplyStatus,
  forge: "github" | "forgejo",
  jobs: OpWavesPipelineResult["jobs"],
  k: number,
  image: string,
  bmEnv: Record<string, string>,
  restWave?: number,
): Record<string, unknown> {
  // #4992: the rest wave's status job posts for the wave its run ran, on the commit a push's follow-on went on with.
  const rest = restWave === k;
  const at = options.beforeMerge ? `"\${${BEFORE_MERGE_HEAD_ENV}:-${rest ? `\${${OP_WAVES_COMMIT_ENV}:-$GITHUB_SHA}` : "$GITHUB_SHA"}}"` : '"$GITHUB_SHA"';
  const env = { ...bmEnv, ...(rest ? followOnEnv(k) : {}) };
  return {
    "runs-on": githubRunsOn(spec.runner),
    needs: jobs.filter((j) => j.wave === k).map((j) => j.jobName),
    if: "${{ !cancelled() }}",
    container: image,
    permissions: { contents: "read", statuses: "write" },
    ...(Object.keys(env).length > 0 ? { env } : {}),
    steps: [
      checkoutStep(true),
      { name: "Download the waves' outcomes", uses: DOWNLOAD_ARTIFACT, with: { path: opWaveOutcomeDir(spec) } },
      ...(spec.waves[0]?.setup ?? []).map(setupStepDoc),
      ...runSteps(options.beforeScript ?? []),
      { name: `Post ${status.context} after wave ${k}`, env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN }, run: applyStatusCommand(spec, rest ? `"\${${OP_WAVES_WAVE_ENV}:-${k}}"` : k, status.context, forge, at, options.bin) },
    ],
  };
}

/**
 * The stale marking job (#4987, #4628): on a push, beside wave 1, at the
 * pushed commit, it marks each open pull request's plan note posted
 * against another commit stale. A dispatch (a before-merge run, or one
 * by hand) moves no branch, so it never runs there.
 */
function staleNotesJob(spec: OpWavesSpec, options: OpWavesPipelineOptions, stale: { command: string; env: Record<string, string> }, image: string): Record<string, unknown> {
  return {
    "runs-on": githubRunsOn(spec.runner),
    if: "${{ github.event_name == 'push' }}",
    container: image,
    // pull-requests: write edits the notes; statuses: write sets each stale plan status back to pending.
    permissions: { contents: "read", "pull-requests": "write", statuses: "write" },
    steps: [checkoutStep(), ...(spec.waves[0]?.setup ?? []).map(setupStepDoc), ...runSteps(options.beforeScript ?? []), { name: "Mark the plan notes this push made stale", env: stale.env, run: stale.command }],
  };
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
