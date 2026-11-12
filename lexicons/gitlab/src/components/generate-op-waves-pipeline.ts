/**
 * Op waves → GitLab CI (#3679).
 *
 * One file, one stage per wave, on a push to the spec's branches. Each job is
 * one of core's `opWaveJobs`, and `needs:` chains them so a wave that waits at
 * its gate (exit 3) stops every later wave; retrying the failed job after
 * `chant approve` carries on, and the jobs it skipped run after it.
 *
 * A job that exits 1 (a run failed, or was blocked) is an allowed failure
 * (`allow_failure: exit_codes: [1]`, #4322), so the next wave's jobs run
 * after it and block only the runs that depend on a failed one. Every job
 * keeps the outcome directory as an artifact, holding the outcome files it
 * received through `needs:` and its own, so each later job reads every
 * earlier one. Any other non-zero exit still stops the waves after it.
 * `GIT_DEPTH: "0"` gives the runner the base
 * commit it reads the gate policy at. A wide wave's deciding job keeps its
 * decision as an artifact, which GitLab hands each share job through `needs:`.
 * A wave's `environment` is the job's own `environment:`; protect it in the
 * project settings to put a reviewer in front of the job as well.
 *
 * The wave jobs carry no `resource_group` (ruling for ci-products
 * 2026-10-28, "Ledger lock"), the same as the GitHub and Forgejo waves files
 * carry no concurrency group: a per-wave resource group would keep two
 * pipelines' plunge stacks apart where their resource rows do not meet. A
 * stock Pulumi stack or a Terraform root waits for its row on chant's ledger,
 * oldest commit first, up to the job's `timeout`, which `CHANT_LOCK_WAIT`
 * sits five minutes under; the project's own maximum timeout still caps it.
 *
 * With `resume` on the spec (#3683), a `<name>-resume` job runs `chant run
 * resume --op <name>` in scheduled pipelines only: create a pipeline schedule
 * with the spec's cron. It retries a waiting wave's job once its approval
 * arrived, with `CHANT_FORGE_TOKEN` (a project access token with the `api`
 * scope and the Developer role; the job token cannot retry jobs).
 *
 * With `beforeMerge` (#4984) the wave, policy and evidence jobs also run in
 * a pipeline of the default branch that the note poll starts for a merge
 * request's decided head (`gitlabBeforeMergeRule`), with the decision in
 * `CHANT_BEFORE_MERGE_PR`, `_HEAD` and `_DIGEST`. The guard admits that
 * head alone; the script then fetches `refs/merge-requests/<n>/head`,
 * stops when it moved, exports `CHANT_WAVES_BASE` and checks the head out,
 * before the setup. A `before-merge-done` stage after the waves merges and
 * releases the locks, with the merge token's variable.
 *
 * #4987: with `beforeMerge` each wave, in a push's pipeline as well, is four
 * jobs ({@link gitlabSplitEntries}, `@intentius/chant/op/op-waves-split`):
 * the plan and applying jobs drop `CHANT_FORGE_TOKEN` and the job token
 * once the head is fetched, and the gate and record jobs, at the default
 * branch's code, write `chant/lifecycle`. Without it, each wave keeps its
 * one job.
 *
 * #4992: a split pipeline's `rest` wave runs one wave per pipeline. Its
 * record job, once the plan found another wave, starts a pipeline of the
 * branch with `CHANT_WAVES_WAVE` and the decision's variables, or a push's
 * `CHANT_WAVES_COMMIT` (`@intentius/chant/op/op-waves-follow-on`), with
 * `CHANT_FORGE_TOKEN`. That pipeline leaves out the jobs of the waves
 * before the rest wave (`GITLAB_NOT_IN_FOLLOW_ON`).
 *
 * With `applyStatus` (#4987) a job `apply-status-<n>` in each wave's stage
 * needs that wave's jobs, runs whatever they ended (`when: always`), and
 * posts the status from the outcome files at the pipeline's commit, with
 * `CHANT_FORGE_TOKEN` (the job token cannot post one), on the pushed
 * commit or the decided head. With `staleNotes` a `stale-notes` job in the
 * first wave's stage, in a push's pipeline alone, marks the open merge
 * requests' plan notes stale with the same token.
 *
 * A `pr-review` wave (#3684), or a `pull-request` wave (#4630), adds
 * `<name>-record-plans`, run in merge request pipelines only, which records
 * the digests the merge request's head plans.
 *
 * `runner` (on the spec, a wave or a job group, #3914) is the job's `tags:`; a
 * GitHub runner group is a spec error here. A wave's `jobs` renders its
 * deciding job with the wave's own settings and a job per group (per share of
 * a group) with the group's: its tags, environment, variables over the
 * wave's, setup after the wave's, and `id_tokens:` from its `idTokens`.
 *
 * A job whose wave or group gives `cloud` (#4332) takes an `id_tokens:`
 * entry per cloud, and its script starts by trading them for those
 * identities and unsetting the token variables, before any line of the
 * checkout runs.
 *
 * With `control` on the spec (#4617), a `control-dispatch` job in a
 * `control` stage needs the last wave's jobs, whose artifacts hold every
 * job's outcome file. It adds them up with `chant run wave --waves-outcome`
 * (through the product's bin) into `CHANT_CONTROL_OUTCOME` and sends the
 * control repo one dispatch carrying it and `$CI_COMMIT_SHA`. A last wave
 * whose runs failed (exit 1) still lets it run; a wave that waits at its
 * gate stops it with the waves, and it runs once the retried job carries
 * on. A CI/CD variable reaches every job, so every other job starts by
 * unsetting the control repo's token variables and the product's two
 * secret names; the dispatch step reads the token from the product's
 * variable alone and hands it to curl on its stdin (#4568).
 *
 * Each wave job's script starts with the apply-job guard (#4624,
 * `@intentius/chant/ci-job-guard`), before the trade: it stops the job
 * unless `CI_COMMIT_REF_NAME` is one of the spec's branches and protected,
 * `CI_ENVIRONMENT_NAME` is the job's environment, and `CI_RUNNER_TAGS`
 * holds each of the job's tags. A refused guard exits chant's `misplaced`
 * (9), outside the job's allowed failure, so the job fails and the waves
 * after it stop.
 *
 * A product's inputs (#4791) go where it used to edit them in:
 * `options.waveJobs` gives a wave's jobs script lines just before the
 * command (a login), an `after_script` (a report), and a path its
 * `artifacts:` keep beside the outcome files. `options.recordPlans` gives
 * the plans job lines before it plans, variables, and `id_tokens:`.
 * Without them nothing changes.
 *
 * With `evidence` (#4870), each wave's own or deciding job signs its checks
 * (`@intentius/chant/op/op-waves-evidence-jobs`, #4926). GitLab reports no
 * steps, so a wave with `holds.policy` runs `chant run wave --policy-only`
 * in a job of its own, `<wave job>-policy`, an allowed failure the wave job
 * needs. A job `<wave job>-evidence` after the wave job checks out the base
 * and runs `chant ci evidence sign --from-job`, which signs `policy:<wave>`
 * when the policy job's status is `success`, and, for a wave that trades
 * cloud credentials and signs keyless, `plan:<wave>` when the wave job's
 * is. It reads the pipeline's jobs with `CHANT_GITLAB_TOKEN` (`read_api`)
 * when set, else the job token. It is an allowed failure too.
 *
 * With `options.renderSpec` (#4982) the job renders the spec at run time:
 * every wave, deciding, share and policy job carries
 * `CHANT_WAVES_SPEC_COMMAND`, and its command passes `--render-spec`, so
 * chant runs the product's command for the spec at base. The jobs, the
 * trade, the evidence jobs and the gates are the ones `spec` gives.
 */

import {
  assertGitlabBranch,
  assertGitlabEnvironment,
  assertRunnerLabels,
  CI_IMAGE,
  environmentDoc,
  GITLAB_FULL_HISTORY,
  GITLAB_MERGE_REQUEST_SOURCE,
  GITLAB_SCHEDULE_SOURCE,
  gitlabIdTokensDoc,
  gitlabPushRule,
  gitlabSetupScript,
  gitlabTags,
  gitlabWavesBranches,
  nonEmpty,
  wavesNamedBranches,
} from "@intentius/chant/ci-jobs";
import {
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
  OP_WAVES_APPROVAL_STATUS_VAR,
  opWavesApprovalStatusCommand,
  opWavesPostsApprovalStatus,
  opWavesOutcomeCommand,
  opWavesRecordPlansCommand,
  opWavesResumeCommand,
  type OpWavesSpec,
} from "@intentius/chant/op/op-waves";
import { CONTROL_DISPATCH_JOB, CONTROL_OUTCOME_VAR, CONTROL_TOKEN_VARS, controlDispatchJob } from "@intentius/chant/control/dispatch";
import type { OpWaveJobInputs, OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import { opWaveSavedPlanDir, opWaveSplitJobLabel, opWaveSplitJobs, type OpWaveSplitJob } from "@intentius/chant/op/op-waves-split";
import { assertFirstWaveNeedsOutside, opWavesFirstWaveNeeds, opWavesNamer, type OpWavesStageRef } from "@intentius/chant/op/op-waves-names";
import type { OpWaveEvidencePlan } from "@intentius/chant/op/op-waves-evidence-jobs";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { gitlabTradeIdTokens, gitlabTradeLines, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { JOB_GUARD_ENV, jobGuardLine, jobGuardSpec, opWaveJobLabel } from "@intentius/chant/ci-job-guard";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { resolveProductWords } from "@intentius/chant/ci-product-words";
import { assertPipelineEvidence, evidenceIdTokens, evidenceKeyEnv, evidenceKeyless, GITLAB_EVIDENCE_ENVIRONMENT } from "@intentius/chant/ci-evidence-jobs";
import {
  EVIDENCE_SOURCES_ENV,
  opWaveEvidenceLines,
  opWaveEvidenceNeeds,
  opWaveEvidencePlan,
  opWaveEvidenceSources,
  opWavePolicyCommand,
  opWavePolicyJobName,
  WAVE_EVIDENCE_ENV,
} from "@intentius/chant/op/op-waves-evidence-jobs";
import { opWavesRenderSpecEnv } from "@intentius/chant/op/op-waves-render-spec";
import { applyStatusCommand, applyStatusJobName, assertApplyStatusContext } from "@intentius/chant/op/apply-status";
import { PR_STALE_JOB } from "@intentius/chant/components/pr-pipeline";
import { assertOpWavesBeforeMerge, BEFORE_MERGE_DONE_JOB, BEFORE_MERGE_HEAD_ENV, BEFORE_MERGE_TOKEN_ENV, beforeMergeCheckoutScript, beforeMergeDoneCommand } from "@intentius/chant/op/before-merge";
import { followOnCommitScript, followOnControlSkip, OP_WAVES_COMMIT_ENV, OP_WAVES_FOLLOW_ON_ENV, OP_WAVES_WAVE_ENV, opWaveRestPath, opWavesFollowOnEnv, opWavesRestWave } from "@intentius/chant/op/op-waves-follow-on";
import { emitGitlabFile } from "./ci-jobs";

/**
 * The rule of a push's follow-on pipeline (#4992): an API, web or trigger
 * pipeline of `branch` (a JSON string) whose `CHANT_WAVES_COMMIT` is a
 * commit sha. The rest wave's jobs, its status job and the control job run
 * in it; the guard checks the rest.
 */
export function gitlabFollowOnRule(branch: string): string {
  return `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${OP_WAVES_COMMIT_ENV} =~ /^[0-9a-f]{40,64}$/ && $CI_COMMIT_BRANCH == ${branch}`;
}

/** The first rule of a job of a wave before the rest wave (#4992): it is left out of a follow-on pipeline, which names a wave. */
export const GITLAB_NOT_IN_FOLLOW_ON = { if: `$${OP_WAVES_WAVE_ENV}`, when: "never" } as const;

/** A job of a wave before the rest wave, left out of a follow-on pipeline (#4992). */
function beforeFollowOn(job: Record<string, unknown>): Record<string, unknown> {
  return { ...job, rules: [GITLAB_NOT_IN_FOLLOW_ON, ...((job.rules as unknown[]) ?? [])] };
}

/** A job of a product's pipeline (#5022): each rule that runs it also needs `runIf`; one that leaves it out (`when: never`) stays as it is. */
function withRunIf(job: Record<string, unknown>, runIf: string): Record<string, unknown> {
  if (!Array.isArray(job.rules)) return job;
  return { ...job, rules: (job.rules as Array<{ if?: string; when?: string }>).map((r) => (r.when === "never" || r.if === undefined ? r : { ...r, if: `(${runIf}) && (${r.if})` })) };
}

/**
 * The rule of a pipeline the note poll starts for a merge request's decided
 * head (#4984): an API, web or trigger pipeline of `branch` (a JSON string)
 * whose `CHANT_BEFORE_MERGE_HEAD` is a commit sha. The guard reads the rest.
 */
export function gitlabBeforeMergeRule(branch: string): string {
  return `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${BEFORE_MERGE_HEAD_ENV} =~ /^[0-9a-f]{40,64}$/ && $CI_COMMIT_BRANCH == ${branch}`;
}

/** The one exit an op-wave job allows as a failure (#4322): a run that failed. The guard's refusal (9) is outside it. */
export const OP_WAVE_ALLOWED_EXIT = CHANT_EXIT.failed;

/** Render an Op waves spec as one GitLab CI file, `<name>.gitlab-ci.yml` unless `opsFileName` names another. */
export function generateGitlabOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  // #4982: with renderSpec each wave job renders the spec at base through the product's command; `spec` is the jobs' shape.
  const renderEnv = opWavesRenderSpecEnv(options.renderSpec);
  // #4984: the before-merge mode, a pipeline of the default branch the note poll starts for a merge request's decided head.
  const bm = options.beforeMerge;
  if (bm) assertOpWavesBeforeMerge("gitlab", bm);
  // #5022: the product's job and stage names, else chant's.
  if (options.workflowFile !== undefined) throw new Error("workflowFile names a GitHub or Forgejo workflow; on GitLab the file is opsFileName");
  if (options.dispatchInputs !== undefined) throw new Error("dispatchInputs names a GitHub or Forgejo workflow's inputs; a GitLab pipeline carries the decision in variables");
  if (options.resumeWorkflowFile !== undefined) throw new Error("resumeWorkflowFile names a GitHub or Forgejo workflow; GitLab's resume job is in the pipeline, and jobNames names it (role resume)");
  if (options.artifactNames !== undefined) throw new Error("artifactNames names GitHub and Forgejo artifacts; a GitLab job hands its files on through needs, and waveJobs' artifact names the product's");
  const runIf = options.runIf;
  if (runIf !== undefined && (typeof runIf !== "string" || runIf.trim() === "" || /[\r\n]/.test(runIf))) throw new Error(`runIf ${JSON.stringify(runIf)} is one rule condition`);
  const namer = opWavesNamer(spec, "gitlab", options.jobNames);
  // #5032: the product's jobs the first wave needs, optional, so a pipeline without one still runs the waves.
  const firstNeedNames = opWavesFirstWaveNeeds(options.firstWaveNeeds, "gitlab");
  const firstNeeds = firstNeedNames.map((job) => ({ job, optional: true as const }));
  const chantJobs = opWaveJobs(spec, options.specFile, { bin: options.bin, ...(options.renderSpec ? { renderSpec: true } : {}), ...(bm ? { beforeMerge: true } : {}) });
  // #4987: before merge each wave is a plan, a gate, an apply and a record job, so the change's code never runs beside CHANT_FORGE_TOKEN.
  const split = bm ? namer.jobs(opWaveSplitJobs(spec, chantJobs)) : undefined;
  const jobs = split ? chantJobs : namer.jobs(chantJobs);
  // #5022: a wave job's evidence and policy jobs, under the product's names.
  const restOf = (wave: number) => (spec.waves[wave - 1]?.rest ? { rest: true as const } : {});
  const evidenceNamed = <P extends OpWaveEvidencePlan | undefined>(job: { jobName: string; wave: number; waveName: string }, plan: P): P =>
    plan?.evidenceJob ? ({ ...plan, evidenceJob: { ...plan.evidenceJob, name: namer.name({ role: "evidence", name: plan.evidenceJob.name, of: job.jobName, wave: job.wave, waveName: job.waveName, ...restOf(job.wave) }) } } as P) : plan;
  const policyNamed = (job: { jobName: string; wave: number; waveName: string }): string => namer.name({ role: "policy", name: opWavePolicyJobName(job), of: job.jobName, wave: job.wave, waveName: job.waveName, ...restOf(job.wave) });
  // #4992: a split pipeline's rest wave runs one wave per pipeline, each record job starting the next.
  const restWave = split ? opWavesRestWave(spec) : undefined;
  assertPipelineEvidence(options.evidence);
  const image = options.image ?? CI_IMAGE;
  const subject = `Op waves "${spec.name}"`;
  // #5032: `$CI_DEFAULT_BRANCH` with defaultBranch, then each named branch.
  const branches = gitlabWavesBranches(spec);
  const rules = branches.map(({ branch, operand }) => {
    if (branch !== "") assertGitlabBranch(subject, branch);
    return { if: gitlabPushRule(operand) };
  });
  // #4984: the wave jobs also run in a pipeline started for a decided head; the guard decides whether it is the recorded one.
  const bmRules = bm ? branches.map(({ operand }) => ({ if: gitlabBeforeMergeRule(operand) })) : [];
  const waveRules = [...rules, ...bmRules];
  // #4992: a push's follow-on pipeline, which the rest wave's jobs, its status job and the control job run in.
  const followRules = restWave !== undefined ? branches.map(({ operand }) => ({ if: gitlabFollowOnRule(operand) })) : [];
  // #5032: what each guard expects of the ref.
  const guardBranches = { branches: wavesNamedBranches(spec), ...(spec.defaultBranch === true ? { defaultBranch: true } : {}) };
  // The setup and environment each wave's jobs carry, checked as an Op's are.
  const setupOf = spec.waves.map((wave) => gitlabSetupScript(`${subject} wave "${wave.name}"`, wave.setup));
  for (const wave of spec.waves) {
    if (wave.environment) assertGitlabEnvironment(`${spec.name}/${wave.name}`, wave.environment);
    if (wave.planEnvironment) assertGitlabEnvironment(`${spec.name}/${wave.name} plan`, wave.planEnvironment);
  }
  // #3914: GitLab picks a runner by tags, and each job group carries its own setup and environment.
  assertRunnerLabels(subject, "runner", spec.runner, "GitLab");
  const groupSetup = new Map<string, string[]>();
  for (const wave of spec.waves) {
    assertRunnerLabels(subject, `wave "${wave.name}" runner`, wave.runner, "GitLab");
    for (const group of wave.jobs ?? []) {
      assertRunnerLabels(subject, `wave "${wave.name}" job group "${group.name}" runner`, group.runner, "GitLab");
      if (group.environment) assertGitlabEnvironment(`${spec.name}/${wave.name}/${group.name}`, group.environment);
      groupSetup.set(`${wave.name}/${group.name}`, gitlabSetupScript(`${subject} wave "${wave.name}" job group "${group.name}"`, group.setup));
    }
  }
  const specTags = gitlabTags(spec.runner);
  const product = resolveProductWords(options.words ?? {}).product;

  // #4630: a pr-review or pull-request wave records each head's plans and posts the approval status.
  const byReview = opWavesPostsApprovalStatus(spec);
  // #5022: each stage under the product's name; two of them may share one.
  const stageName = (ref: OpWavesStageRef): string => {
    const mine = options.stageNames?.(ref);
    if (mine !== undefined && (typeof mine !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(mine))) throw new Error(`stageNames gives the stage ${ref.name} the name ${JSON.stringify(mine)}, which is not a stage name`);
    return mine ?? ref.name;
  };
  const waveStages = spec.waves.map((wave, i) => stageName({ name: `wave-${i + 1}-${wave.name}`, role: "wave", wave: i + 1, waveName: wave.name }));
  const stageOfWave = (k: number): string => waveStages[k - 1]!;
  const plansStage = stageName({ name: "plans", role: "plans" });
  const doneStage = stageName({ name: BEFORE_MERGE_DONE_JOB, role: "before-merge-done" });
  const controlStage = stageName({ name: "control", role: "control" });
  const resumeStage = stageName({ name: "resume", role: "resume" });
  // #5034: the resume job's name, the product's by the role `resume`, else `<spec>-resume`.
  const resumeJob = spec.resume ? namer.name({ role: "resume", name: `${spec.name}-resume` }) : `${spec.name}-resume`;
  const stages = [...(byReview ? [plansStage] : []), ...waveStages];
  // #4617: the control repo's token variables, which every job but the dispatch drops first.
  const control = spec.control ? opWavesControlTarget(spec.control) : undefined;
  const dropControl = control ? [`unset ${[...new Set([...CONTROL_TOKEN_VARS, control.tokenSecret, control.readTokenSecret])].join(" ")}`] : [];
  if (bm) stages.push(doneStage);
  if (control) stages.push(controlStage);
  if (spec.resume) stages.push(resumeStage);
  const entries: Array<readonly [string, unknown]> = [["stages", [...new Set(stages)]]];
  // The ruling for ci-products (2026-10-28): each wave job's timeout, and the lock wait five minutes under it.
  const timeout = opWaveJobTimeout(options.jobTimeoutMinutes);
  // #4791: what the product adds to each wave's jobs, and to the plans job.
  const inputs = opWaveJobInputsByWave(spec, options.waveJobs);
  const plans = options.recordPlans;
  const plansIdTokens = gitlabIdTokensDoc(plans?.idTokens);
  const variables = nonEmpty("variables", options.variables).variables;
  if (variables) entries.push(["variables", variables]);
  if (byReview) {
    entries.push([
      namer.claim(`${spec.name}-record-plans`),
      {
        stage: plansStage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        ...(plansIdTokens ? { id_tokens: plansIdTokens } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(plans?.variables ?? {}) },
        rules: [{ if: GITLAB_MERGE_REQUEST_SOURCE }],
        script: [
          ...dropControl,
          ...(options.beforeScript ?? []),
          ...(plans?.before ?? []).flatMap((st) => st.run),
          opWavesRecordPlansCommand(options.specFile, options.bin).join(" "),
        ],
      },
    ]);
    // #4630: a GitLab approval starts no pipeline, so a schedule of the target branch posts every open merge request's status.
    entries.push([
      namer.claim(`${spec.name}-approval-status`),
      {
        stage: plansStage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        variables: { ...GITLAB_FULL_HISTORY },
        rules: [{ if: `${GITLAB_SCHEDULE_SOURCE} && $${OP_WAVES_APPROVAL_STATUS_VAR} == "1"` }],
        script: [...dropControl, ...(options.beforeScript ?? []), opWavesApprovalStatusCommand(options.specFile, "gitlab", options.bin).join(" ")],
      },
    ]);
  }
  // #4926: how each wave job signs its checks, and the evidence jobs a later wave's evidence.requires waits for.
  const evidenceOf = (job: (typeof jobs)[number]) => {
    const cloud = opWaveGroupOf(spec, job)?.cloud ?? spec.waves[job.wave - 1]!.cloud;
    const signs = options.evidence !== undefined && (job.kind === "wave" || job.kind === "decide");
    // #4964: with a runner key, no wave job holds it; each wave's evidence job, in the chant-evidence environment, signs.
    return evidenceNamed(job, opWaveEvidencePlan(spec, job, { signs, keylessCloud: signs && evidenceKeyless(options.evidence) && cloud !== undefined, keyOutOfWave: signs && !evidenceKeyless(options.evidence) }));
  };
  const evidenceNeeds = split ? () => [] : opWaveEvidenceNeeds(spec, jobs.map((job) => ({ wave: job.wave, plan: evidenceOf(job) })));
  if (split) {
    entries.push(...gitlabSplitEntries({ spec, options, product, image, timeout, inputs, renderEnv, split, setupOf, groupSetup, dropControl, waveRules, followRules, ...(restWave !== undefined ? { restWave } : {}), stageOf: stageOfWave, evidenceNamed, policyNamed, guardBranches, firstNeeds }));
  }
  for (const job of split ? [] : jobs) {
    const wave = spec.waves[job.wave - 1]!;
    const group = opWaveGroupOf(spec, job);
    const setup = [...setupOf[job.wave - 1]!, ...(group ? groupSetup.get(`${wave.name}/${group.name}`)! : [])];
    const tags = gitlabTags(group?.runner ?? wave.runner ?? spec.runner);
    const environment = group?.environment ?? wave.environment;
    // #4332: the job's cloud identities, traded first.
    const cloud = group?.cloud ?? wave.cloud;
    const declared = gitlabIdTokensDoc(group?.idTokens ?? wave.idTokens);
    // #4870: the deciding job signs the wave's checks; #4869: signing keyless, it requests the signing token too.
    // #4926: a keyless wave that trades cloud credentials signs in its evidence job, as on GitHub and Forgejo, and a
    // wave's policy runs in a job of its own, whose status the evidence job signs `policy:<wave>` from.
    const evidence = evidenceOf(job);
    const signs = evidence !== undefined && evidence.commandSigns;
    const signing = signs ? evidenceIdTokens(options.evidence) : {};
    const traded = cloud ? { ...declared, ...gitlabTradeIdTokens(cloud) } : declared;
    const idTokens = Object.keys(signing).length > 0 ? { ...traded, ...signing } : traded;
    // #4624: the apply-job guard, the script's first line, before the trade.
    const runner = group?.runner ?? wave.runner ?? spec.runner;
    const add = inputs[job.wave - 1];
    const guard = jobGuardSpec({
      forge: "gitlab",
      job: opWaveJobLabel(spec.name, job),
      product,
      ...(environment ? { environment: environment.name } : {}),
      ...guardBranches,
      ...(runner !== undefined ? { runner } : {}),
      ...(bm ? { beforeMerge: { op: spec.name } } : {}),
    });
    // #4984: a pipeline for a decided head checks it out after the guard and the trade, before any of the change's code.
    const headLines = bm ? [beforeMergeCheckoutScript("gitlab", product)] : [];
    const stage = stageOfWave(job.wave);
    const checksDir = `${opWaveChecksDir(spec)}/`;
    const policyJob = evidence?.policyStep ? policyNamed(job) : undefined;
    if (policyJob) {
      // #4926: the wave's policy, planned in a job of its own whose status GitLab reports. The wave job runs after it
      // whatever it ended (a denied run may still apply under an override); it deploys nothing, so its environment is `prepare`.
      entries.push([
        policyJob,
        {
          stage,
          image,
          ...(tags ? { tags } : {}),
          timeout: `${timeout.minutes} minutes`,
          ...(environment ? { environment: { ...environmentDoc(environment), action: "prepare" } } : {}),
          ...(traded && Object.keys(traded).length > 0 ? { id_tokens: traded } : {}),
          variables: { ...GITLAB_FULL_HISTORY, ...timeout.env, ...renderEnv, ...(wave.variables ?? {}), ...(cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(cloud) } : {}), [JOB_GUARD_ENV]: JSON.stringify(guard) },
          rules: waveRules,
          ...(job.needs.length > 0 ? { needs: job.needs } : firstNeeds.length > 0 ? { needs: firstNeeds } : {}),
          script: [jobGuardLine(guard), ...(cloud ? gitlabTradeLines() : []), ...headLines, ...dropControl, ...setup, ...(options.beforeScript ?? []), ...(add?.before ?? []).flatMap((st) => st.run), ...(add?.prelude ?? []), opWavePolicyCommand(job).join(" ")],
          allow_failure: true,
          artifacts: { when: "always", paths: [checksDir], expire_in: "30 days" },
        },
      ]);
    }
    // #5032: the first wave's own or deciding job needs the product's jobs too, such as its check.
    const needs = [...(job.needs.length === 0 ? firstNeeds : []), ...job.needs, ...(policyJob ? [policyJob] : []), ...(job.kind === "share" ? [] : evidenceNeeds(job.wave))];
    entries.push([
      job.jobName,
      {
        stage,
        image,
        ...(tags ? { tags } : {}),
        timeout: `${timeout.minutes} minutes`,
        ...(environment ? { environment: environmentDoc(environment) } : {}),
        ...(idTokens ? { id_tokens: idTokens } : {}),
        // #4870: the deciding job signs the wave's checks with the runner key from the named variable, or (#4869) keyless.
        variables: {
          ...GITLAB_FULL_HISTORY,
          ...timeout.env,
          ...renderEnv,
          ...(wave.variables ?? {}),
          ...(group?.variables ?? {}),
          ...(cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(cloud) } : {}),
          [JOB_GUARD_ENV]: JSON.stringify(guard),
          ...(signs ? evidenceKeyEnv("gitlab", options.evidence!) : {}),
          ...(evidence?.commandMode ? { [WAVE_EVIDENCE_ENV]: evidence.commandMode } : {}),
        },
        rules: waveRules,
        ...(needs.length > 0 ? { needs } : {}),
        script: [
          jobGuardLine(guard),
          ...(cloud ? gitlabTradeLines() : []),
          ...headLines,
          ...dropControl,
          ...setup,
          ...(options.beforeScript ?? []),
          ...(add?.before ?? []).flatMap((st) => st.run),
          ...(add?.prelude ?? []),
          job.command.join(" "),
          ...(options.extraScript ?? []),
        ],
        // #4791: the product's report, whatever the script's exit.
        ...(add?.report ? { after_script: add.report.run } : {}),
        // #4322: a run that failed, or was blocked, lets the next wave run; any other failure stops it,
        // a refused guard (9, #4624) included.
        allow_failure: { exit_codes: [OP_WAVE_ALLOWED_EXIT] },
        artifacts: {
          ...(add?.artifact ? { name: opWaveJobArtifactName(add.artifact.name, job.jobName) } : {}),
          when: "always",
          paths: [...(job.kind === "decide" ? [job.record!] : []), `${opWaveOutcomeDir(spec)}/`, ...(evidence?.evidenceJob ? [checksDir] : []), ...(add?.artifact ? opWaveJobArtifactPaths(add.artifact) : [])],
          expire_in: "30 days",
        },
      },
    ]);
    if (evidence?.evidenceJob) {
      // #4926: after the wave job, a job that runs none of the change's code signs from the jobs' statuses.
      // #4984: a before-merge pipeline applied the decided head, so its checks are signed at it.
      const lines = opWaveEvidenceLines(spec, evidence, job, { sha: bm ? `"\${${BEFORE_MERGE_HEAD_ENV}:-$CI_COMMIT_SHA}"` : '"$CI_COMMIT_SHA"', ...(options.bin ? { bin: options.bin } : {}), ...(bm ? { beforeMerge: true } : {}) });
      const signingTokens = evidenceIdTokens(options.evidence);
      entries.push([
        evidence.evidenceJob.name,
        {
          stage,
          image,
          ...(specTags ? { tags: specTags } : {}),
          // #4964: the runner key's variable is scoped to this environment and protected, so no wave job is handed it.
          ...(evidenceKeyless(options.evidence) ? {} : { environment: { name: GITLAB_EVIDENCE_ENVIRONMENT, action: "access" } }),
          ...(Object.keys(signingTokens).length > 0 ? { id_tokens: signingTokens } : {}),
          variables: { ...GITLAB_FULL_HISTORY, [EVIDENCE_SOURCES_ENV]: JSON.stringify(opWaveEvidenceSources("gitlab", evidence, job, wave.name, "", policyJob)), ...evidenceKeyEnv("gitlab", options.evidence!) },
          rules: waveRules,
          needs: [job.jobName, ...(policyJob ? [policyJob] : [])],
          script: [...dropControl, ...lines.checkout, ...setupOf[job.wave - 1]!, ...(options.beforeScript ?? []), ...lines.sign],
          // A refused or failed evidence job leaves the later waves to run; their evidence.requires speaks for itself.
          allow_failure: true,
        },
      ]);
    }
  }
  // #4987: a split pipeline's waves end with the last wave's record job.
  const last = split ? split.filter((j) => j.phase === "record" && j.wave === spec.waves.length).map((j) => j.jobName) : opWavesLastJobs(jobs);
  if (bm) {
    // #4984: after a before-merge pipeline's last wave, at the default branch's commit: the merge and the release of the locks.
    // Its needs hand on every outcome file; a wave that failed as allowed still lets it run, and it reads the outcomes itself.
    entries.push([
      namer.name({ role: "before-merge-done", name: BEFORE_MERGE_DONE_JOB }),
      {
        stage: doneStage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(bm.merge === "auto" && bm.mergeTokenSecret ? { [BEFORE_MERGE_TOKEN_ENV]: `$${bm.mergeTokenSecret}` } : {}) },
        rules: bmRules,
        needs: last,
        script: [...dropControl, ...setupOf[0]!, ...(options.beforeScript ?? []), beforeMergeDoneCommand(spec, "gitlab", bm, options.bin)],
      },
    ]);
  }
  // #4987: each wave's apply status, from a job after it at the default branch's commit that runs none of the change's code.
  // It runs whatever the wave ended, and a refused post leaves the waves as they are.
  if (options.applyStatus) {
    const status = options.applyStatus;
    assertApplyStatusContext(status.context);
    const at = bm ? `"\${${BEFORE_MERGE_HEAD_ENV}:-$CI_COMMIT_SHA}"` : '"$CI_COMMIT_SHA"';
    for (let k = 1; k <= spec.waves.length; k++) {
      // #4992: the rest wave's status job posts for the wave its pipeline ran, on the commit a push's follow-on went on with.
      const rest = restWave === k;
      const job = {
        stage: stageOfWave(k),
        image,
        ...(specTags ? { tags: specTags } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(rest ? { [OP_WAVES_WAVE_ENV]: String(k) } : {}) },
        rules: [...waveRules, ...(rest ? followRules : [])].map((r) => ({ ...r, when: "always" })),
        needs: (split ?? jobs).filter((j) => j.wave === k).map((j) => j.jobName),
        script: [
          ...dropControl,
          ...setupOf[0]!,
          ...(options.beforeScript ?? []),
          rest
            ? applyStatusCommand(spec, `"\${${OP_WAVES_WAVE_ENV}:-${k}}"`, status.context, "gitlab", `"\${${BEFORE_MERGE_HEAD_ENV}:-\${${OP_WAVES_COMMIT_ENV}:-$CI_COMMIT_SHA}}"`, options.bin)
            : applyStatusCommand(spec, k, status.context, "gitlab", at, options.bin),
        ],
        allow_failure: true,
      };
      const name = namer.name({ role: "apply-status", name: applyStatusJobName(k), wave: k, waveName: spec.waves[k - 1]!.name, ...restOf(k) });
      entries.push([name, restWave !== undefined && k < restWave ? beforeFollowOn(job) : job]);
    }
  }
  // #4987: a push marks the open merge requests' plan notes stale, beside wave 1; a before-merge pipeline moves no branch.
  if (options.staleNotes) {
    entries.push([
      namer.name({ role: "stale-notes", name: PR_STALE_JOB }),
      {
        stage: stageOfWave(1),
        image,
        ...(specTags ? { tags: specTags } : {}),
        ...(Object.keys(options.staleNotes.env).length > 0 ? { variables: { ...options.staleNotes.env } } : {}),
        rules,
        script: [...dropControl, ...setupOf[0]!, ...(options.beforeScript ?? []), options.staleNotes.command],
        allow_failure: true,
      },
    ]);
  }
  if (control) {
    // #4992: a push's follow-on pipeline tells the control repo about the commit the waves went on with.
    const dispatch = controlDispatchJob("gitlab", control, restWave !== undefined ? `\${${OP_WAVES_COMMIT_ENV}:-$CI_COMMIT_SHA}` : "$CI_COMMIT_SHA", {
      ...(options.words ? { words: options.words } : {}),
      ...(spec.control!.sentCheck ? { sentCheck: spec.control!.sentCheck } : {}),
      ...(spec.control!.markSent ? { markSent: spec.control!.markSent } : {}),
      outcome: true,
    });
    entries.push([
      namer.name({ role: "control", name: dispatch.name }),
      {
        stage: controlStage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        rules: [...rules, ...followRules],
        // The last wave's jobs hand on every job's outcome file through their artifacts.
        needs: last,
        // The setup and the outcome run in a subshell without the control token, and only the outcome reaches stdout.
        script: [
          [
            'outcome="$(',
            ...dropControl,
            "{ :",
            ...setupOf[0]!,
            ...(options.beforeScript ?? []),
            "} 1>&2",
            opWavesOutcomeCommand(options.specFile, options.bin).join(" "),
            ')" || exit 1',
          ].join("\n"),
          `export ${CONTROL_OUTCOME_VAR}="$outcome"`,
          // #4992: a pipeline that started a follow-on added up no outcome, and sends none.
          ...(restWave !== undefined ? [followOnControlSkip(product)] : []),
          ...Object.entries(dispatch.env).map(([k, v]) => `export ${k}="${v}"`),
          `bash <<'CONTROL_DISPATCH' || exit $?\n${dispatch.script}\nCONTROL_DISPATCH`,
        ],
      },
    ]);
  }
  if (spec.resume) {
    entries.push([
      // #5034: under the product's name, by the role `resume`.
      resumeJob,
      {
        stage: resumeStage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        rules: [{ if: GITLAB_SCHEDULE_SOURCE }],
        script: [...dropControl, ...(options.beforeScript ?? []), opWavesResumeCommand(spec, options.bin).join(" ")],
      },
    ]);
  }
  const header = [
    `# chant Op waves "${spec.name}": one stage per wave, each needing the one before.`,
    "# A wave that waits at its gate exits 3 and stops the waves after it; approve the",
    "# digest it prints, then retry the job. A job whose runs failed exits 1, an allowed",
    "# failure, and the waves after it run what does not depend on those runs. A job",
    "# whose guard finds it running where the spec did not set it to run exits 9 and",
    "# stops the waves after it.",
    ...(spec.resume
      ? [`# The ${resumeJob} job retries it for you in a pipeline schedule; give the schedule the cron "${spec.resume.schedule}".`]
      : []),
    ...(byReview
      ? [`# The ${spec.name}-approval-status job posts each open merge request's approval status from a pipeline schedule that sets ${OP_WAVES_APPROVAL_STATUS_VAR}=1.`]
      : []),
    ...(control ? [`# After the last wave, the ${namer.name({ role: "control", name: CONTROL_DISPATCH_JOB })} job tells ${control.repo} how the waves ended.`] : []),
  ];
  assertFirstWaveNeedsOutside(firstNeedNames, entries.map(([key]) => key));
  const name = options.opsFileName ?? `${spec.name}.gitlab-ci.yml`;
  // #5022: in a product's pipeline every rule of every job also needs the product's condition; a rule that leaves a job out stays as it is.
  const placed = runIf === undefined ? entries : entries.map(([key, job]) => [key, key === "stages" || key === "variables" ? job : withRunIf(job as Record<string, unknown>, runIf)] as const);
  return { files: [{ name, yaml: emitGitlabFile(placed, header) }], jobs: split ?? jobs };
}

/** The exits of a split wave's applying job that let its record job run (#4987): a failed run, a moved plan, a held or stood-down apply. The record job ends with them. */
export const OP_WAVE_SPLIT_APPLY_ALLOWED_EXITS = [CHANT_EXIT.failed, CHANT_EXIT.moved, CHANT_EXIT.held, CHANT_EXIT.superseded];

/**
 * The runner's clone keeps the job token in origin's URL; a job that runs
 * the change's code drops it once the head is fetched (#4899, #4987).
 */
const GITLAB_SCRUB_ORIGIN = `git remote set-url origin "$(git remote get-url origin | sed -E 's#//[^@/]*@#//#')"`;

/** What the split jobs read from the pipeline they are in (#4987). */
interface GitlabSplitInput {
  spec: OpWavesSpec;
  options: OpWavesPipelineOptions;
  product: string;
  image: string;
  timeout: { minutes: number; env: Record<string, string> };
  inputs: Array<OpWaveJobInputs | undefined>;
  renderEnv: Record<string, string>;
  split: OpWaveSplitJob[];
  setupOf: string[][];
  groupSetup: Map<string, string[]>;
  dropControl: string[];
  waveRules: Array<{ if: string }>;
  /** A push's follow-on pipeline's rules (#4992), which the rest wave's jobs add. */
  followRules: Array<{ if: string }>;
  /** The rest wave's number (#4992), when the last wave has `rest`. */
  restWave?: number;
  stageOf: (k: number) => string;
  /** A wave job's evidence plan, its evidence job under the product's name (#5022). */
  evidenceNamed: <P extends OpWaveEvidencePlan | undefined>(job: { jobName: string; wave: number; waveName: string }, plan: P) => P;
  /** A wave job's policy job, under the product's name (#5022). */
  policyNamed: (job: { jobName: string; wave: number; waveName: string }) => string;
  /** What each guard expects of the ref (#5032): the named branches, and the default branch with defaultBranch. */
  guardBranches: { branches: string[]; defaultBranch?: boolean };
  /** The product's jobs the first wave's jobs need (#5032), each optional. */
  firstNeeds: Array<{ job: string; optional: true }>;
}

/**
 * The jobs of a before-merge pipeline, each wave split in four (#4987,
 * `@intentius/chant/op/op-waves-split`). A CI/CD variable reaches every job,
 * so the plan and apply jobs, and the plan's policy job, drop
 * `CHANT_FORGE_TOKEN`, the job token and the other token variables
 * (`GITLAB_DROP_FORGE_TOKENS`) and the job token in origin's URL right after
 * the head is fetched, before any of the change's code; their
 * `after_script` drops them again, since it is a shell of its own. The gate
 * and record jobs check out nothing of the merge request but its commit,
 * fetched, and write `chant/lifecycle`. GitLab hands on artifacts through
 * `needs:` alone, so each job keeps the outcome directory, and the gate job
 * the saved plan and the decision for the applying jobs. An applying job's
 * moved, held or stood-down apply is an allowed failure, so the record job
 * writes its run record and then ends with it, and the waves after it stop.
 *
 * #4992: the rest wave's jobs run the wave `CHANT_WAVES_WAVE` names (a
 * follow-on pipeline's variable, else the job's own, which it overrides),
 * keep their files at that wave's paths, also run in a push's follow-on
 * pipeline, and check out its `CHANT_WAVES_COMMIT` once it is on the
 * branch. Their needs on the waves before are optional, since those jobs
 * are left out of a follow-on pipeline. The record job starts the follow-on
 * with `CHANT_FORGE_TOKEN`.
 */
function gitlabSplitEntries(input: GitlabSplitInput): Array<readonly [string, unknown]> {
  const { spec, options, product, image, timeout, inputs, renderEnv, split, setupOf, groupSetup, dropControl, waveRules, followRules, restWave, stageOf, evidenceNamed, policyNamed, guardBranches, firstNeeds } = input;
  const evidenceOf = (job: OpWaveSplitJob) => (job.phase === "plan" && options.evidence !== undefined ? evidenceNamed(job, opWaveEvidencePlan(spec, job, { signs: true, keylessCloud: false, keyOutOfWave: true })) : undefined);
  const evidenceNeeds = opWaveEvidenceNeeds(spec, split.map((job) => ({ wave: job.wave, plan: evidenceOf(job) })));
  const specTags = gitlabTags(spec.runner);
  const outcomes = `${opWaveOutcomeDir(spec)}/`;
  const checksDir = `${opWaveChecksDir(spec)}/`;
  const out: Array<readonly [string, unknown]> = [];
  for (const job of split) {
    const k = job.wave;
    const wave = spec.waves[k - 1]!;
    const stage = stageOf(k);
    // #4992: the rest wave's jobs run the wave a follow-on pipeline names, and keep its files at that wave's paths.
    const rest = job.rest === true;
    const at = (path: string): string => (rest ? opWaveRestPath(path, k, `$${OP_WAVES_WAVE_ENV}`) : path);
    const restVariables = rest ? { [OP_WAVES_WAVE_ENV]: String(k) } : {};
    const restRules = rest ? [...waveRules, ...followRules] : waveRules;
    const followCommit = rest ? [followOnCommitScript(product)] : [];
    // A follow-on pipeline leaves out the jobs of the waves before the rest wave, so the rest wave's needs on them are optional.
    const needsOf = (needs: readonly string[]): Array<string | { job: string; optional: true }> =>
      rest ? needs.map((n) => (split.some((j) => j.jobName === n && j.wave === k) ? n : { job: n, optional: true as const })) : [...needs];
    const place = (name: string, doc: Record<string, unknown>): void => {
      out.push([name, restWave !== undefined && k < restWave ? beforeFollowOn(doc) : doc]);
    };
    const savedPlan = `${at(opWaveSavedPlanDir(spec, k))}/`;
    if (!job.runsChange) {
      // The gate and record jobs: the default branch's code, with CHANT_FORGE_TOKEN.
      const gate = job.phase === "gate";
      // #4994: the product's report of the decision its after-gate hooks wrote, and the files it keeps.
      const own = gate ? inputs[k - 1]?.gate : undefined;
      const guard = jobGuardSpec({ forge: "gitlab", job: opWaveSplitJobLabel(spec.name, job), product, ...guardBranches, ...(spec.runner !== undefined ? { runner: spec.runner } : {}), beforeMerge: { op: spec.name }, ...(rest ? { rest: k } : {}) });
      // #4992: the rest wave's record job starts the follow-on pipeline, with CHANT_FORGE_TOKEN.
      const starts = rest && !gate ? { [OP_WAVES_FOLLOW_ON_ENV]: opWavesFollowOnEnv({ forge: "gitlab" }) } : {};
      place(job.jobName, {
        stage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        // #4992: the gate job of a step spec waits for its rows on the ledger, up to the job's timeout.
        ...(gate ? { timeout: `${timeout.minutes} minutes` } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(gate ? timeout.env : {}), ...renderEnv, ...(wave.variables ?? {}), ...restVariables, ...starts, [JOB_GUARD_ENV]: JSON.stringify(guard) },
        rules: restRules,
        // The record job needs the gate job too, whose decision names the rows it leased (#4992).
        needs: needsOf(job.needs),
        // The gate reads the head's commit, notes and wave stop; the record job writes what ran, whatever the merge request did since.
        script: [jobGuardLine(guard), ...followCommit, ...(gate ? [beforeMergeCheckoutScript("gitlab", product, { checkout: false })] : []), ...dropControl, ...setupOf[k - 1]!, ...(options.beforeScript ?? []), job.command.join(" ")],
        // A gate that fails as a run fails (its plan job's end) lets the applying job record the wave's outcome; one that waits stops here.
        ...(own?.report ? { after_script: own.report.run } : {}),
        allow_failure: { exit_codes: [OP_WAVE_ALLOWED_EXIT] },
        // The record job's outcome directory holds the rest wave's note (#4992).
        artifacts: {
          ...(own?.artifact ? { name: opWaveJobArtifactName(own.artifact.name, job.jobName) } : {}),
          when: "always",
          paths: gate ? [at(job.record!), savedPlan, outcomes, ...(own?.artifact ? opWaveJobArtifactPaths(own.artifact) : [])] : [outcomes],
          expire_in: "30 days",
        },
      });
      continue;
    }
    // The plan and apply jobs, and the plan's policy job: the change's code, with no forge token.
    const group = opWaveGroupOf(spec, job);
    const setup = [...setupOf[k - 1]!, ...(group ? groupSetup.get(`${wave.name}/${group.name}`)! : [])];
    const tags = gitlabTags(group?.runner ?? wave.runner ?? spec.runner);
    // #4992: the plan job names the wave's planEnvironment when it has one, else its environment, with `action: prepare`
    // below either way: it deploys nothing, so the environment's approval is asked of the applying job alone.
    const environment = job.phase === "plan" ? (wave.planEnvironment ?? wave.environment) : (group?.environment ?? wave.environment);
    const cloud = group?.cloud ?? wave.cloud;
    const declared = gitlabIdTokensDoc(group?.idTokens ?? wave.idTokens);
    const idTokens = cloud ? { ...declared, ...gitlabTradeIdTokens(cloud) } : declared;
    const runner = group?.runner ?? wave.runner ?? spec.runner;
    const add = inputs[k - 1];
    const evidence = evidenceOf(job);
    const guard = jobGuardSpec({ forge: "gitlab", job: opWaveSplitJobLabel(spec.name, job), product, ...(environment ? { environment: environment.name } : {}), ...guardBranches, ...(runner !== undefined ? { runner } : {}), beforeMerge: { op: spec.name }, ...(rest ? { rest: k } : {}) });
    const head = [jobGuardLine(guard),...(cloud ? gitlabTradeLines() : []), beforeMergeCheckoutScript("gitlab", product), ...followCommit, GITLAB_SCRUB_ORIGIN, GITLAB_DROP_FORGE_TOKENS];
    const variables = {
      ...GITLAB_FULL_HISTORY,
      ...timeout.env,
      ...renderEnv,
      ...(wave.variables ?? {}),
      ...(group?.variables ?? {}),
      ...(cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(cloud) } : {}),
      ...restVariables,
      [JOB_GUARD_ENV]: JSON.stringify(guard),
    };
    const policyJob = evidence?.policyStep ? policyNamed(job) : undefined;
    if (policyJob) {
      place(policyJob, {
        stage,
        image,
        ...(tags ? { tags } : {}),
        timeout: `${timeout.minutes} minutes`,
        ...(environment ? { environment: { ...environmentDoc(environment), action: "prepare" } } : {}),
        ...(idTokens && Object.keys(idTokens).length > 0 ? { id_tokens: idTokens } : {}),
        variables,
        rules: restRules,
        ...(job.needs.length > 0 ? { needs: needsOf(job.needs) } : firstNeeds.length > 0 ? { needs: firstNeeds } : {}),
        script: [...head, ...dropControl, ...setup, ...(options.beforeScript ?? []), ...(add?.before ?? []).flatMap((st) => st.run), ...(add?.prelude ?? []), opWavePolicyCommand(job).join(" ")],
        allow_failure: true,
        artifacts: { when: "always", paths: [checksDir], expire_in: "30 days" },
      });
    }
    const plan = job.phase === "plan";
    // #5032: the first wave's plan job needs the product's jobs too, such as its check.
    const needs = [...(plan && job.needs.length === 0 ? firstNeeds : []), ...needsOf([...job.needs, ...(policyJob ? [policyJob] : []), ...(plan ? evidenceNeeds(k) : [])])];
    place(job.jobName, {
      stage,
      image,
      ...(tags ? { tags } : {}),
      timeout: `${timeout.minutes} minutes`,
      // The plan job deploys nothing; the applying job is the deployment.
      ...(environment ? { environment: plan ? { ...environmentDoc(environment), action: "prepare" } : environmentDoc(environment) } : {}),
      ...(idTokens && Object.keys(idTokens).length > 0 ? { id_tokens: idTokens } : {}),
      variables: { ...variables, ...(evidence?.commandMode ? { [WAVE_EVIDENCE_ENV]: evidence.commandMode } : {}) },
      rules: restRules,
      ...(needs.length > 0 ? { needs } : {}),
      script: [...head, ...dropControl, ...setup, ...(options.beforeScript ?? []), ...(add?.before ?? []).flatMap((st) => st.run), ...(add?.prelude ?? []), job.command.join(" "), ...(options.extraScript ?? [])],
      ...(add?.report ? { after_script: [GITLAB_DROP_FORGE_TOKENS, ...add.report.run] } : {}),
      allow_failure: { exit_codes: plan ? [OP_WAVE_ALLOWED_EXIT] : OP_WAVE_SPLIT_APPLY_ALLOWED_EXITS },
      artifacts: {
        ...(add?.artifact ? { name: opWaveJobArtifactName(add.artifact.name, job.jobName) } : {}),
        when: "always",
        paths: [...(plan ? [savedPlan] : []), outcomes, ...(evidence?.evidenceJob ? [checksDir] : []), ...(add?.artifact ? opWaveJobArtifactPaths(add.artifact) : [])],
        expire_in: "30 days",
      },
    });
    if (evidence?.evidenceJob) {
      // #4926: after the plan job, a job that runs none of the change's code signs from the jobs' statuses, at the decided head.
      // #4992: or, in a push's follow-on, at the commit it went on with, which it checks out first.
      const pushed = rest ? `\${${OP_WAVES_COMMIT_ENV}:-$CI_COMMIT_SHA}` : "$CI_COMMIT_SHA";
      const lines = opWaveEvidenceLines(spec, evidence, job, { sha: `"\${${BEFORE_MERGE_HEAD_ENV}:-${pushed}}"`, ...(options.bin ? { bin: options.bin } : {}), beforeMerge: true });
      const signingTokens = evidenceIdTokens(options.evidence);
      place(evidence.evidenceJob.name, {
        stage,
        image,
        ...(specTags ? { tags: specTags } : {}),
        ...(evidenceKeyless(options.evidence) ? {} : { environment: { name: GITLAB_EVIDENCE_ENVIRONMENT, action: "access" } }),
        ...(Object.keys(signingTokens).length > 0 ? { id_tokens: signingTokens } : {}),
        variables: { ...GITLAB_FULL_HISTORY, [EVIDENCE_SOURCES_ENV]: JSON.stringify(opWaveEvidenceSources("gitlab", evidence, job, wave.name, "", policyJob)), ...evidenceKeyEnv("gitlab", options.evidence!), ...restVariables },
        rules: restRules,
        needs: [job.jobName, ...(policyJob ? [policyJob] : [])],
        script: [...dropControl, ...followCommit, ...lines.checkout, ...setupOf[k - 1]!, ...(options.beforeScript ?? []), ...lines.sign],
        allow_failure: true,
      });
    }
  }
  return out;
}
