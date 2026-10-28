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
 * With `resume` on the spec (#3683), a `<name>-resume` job runs `chant run
 * resume --op <name>` in scheduled pipelines only: create a pipeline schedule
 * with the spec's cron. It retries a waiting wave's job once its approval
 * arrived, with `CHANT_FORGE_TOKEN` (a project access token with the `api`
 * scope and the Developer role; the job token cannot retry jobs).
 *
 * A `pr-review` wave (#3684) adds `<name>-record-plans`, run in merge request
 * pipelines only, which records the digests the merge request's head plans.
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
 * holds each of the job's tags. The guard exits 1, which the job allows
 * as it allows a failed run; the next wave's jobs carry the guard too.
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
  nonEmpty,
  pushBranches,
} from "@intentius/chant/ci-jobs";
import {
  opWaveGroupOf,
  opWaveJobs,
  opWaveOutcomeDir,
  opWavesControlTarget,
  opWavesLastJobs,
  OP_WAVES_APPROVAL_STATUS_VAR,
  opWavesApprovalStatusCommand,
  opWavesOutcomeCommand,
  opWavesRecordPlansCommand,
  opWavesResumeCommand,
  type OpWavesSpec,
} from "@intentius/chant/op/op-waves";
import { CONTROL_OUTCOME_VAR, CONTROL_TOKEN_VARS, controlDispatchJob } from "@intentius/chant/control/dispatch";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import { gitlabTradeIdTokens, gitlabTradeLines, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { JOB_GUARD_ENV, jobGuardLine, jobGuardSpec, opWaveJobLabel } from "@intentius/chant/ci-job-guard";
import { resolveProductWords } from "@intentius/chant/ci-product-words";
import { emitGitlabFile } from "./ci-jobs";

/** Render an Op waves spec as one GitLab CI file, `<name>.gitlab-ci.yml` unless `opsFileName` names another. */
export function generateGitlabOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const jobs = opWaveJobs(spec, options.specFile, { bin: options.bin });
  const image = options.image ?? CI_IMAGE;
  const subject = `Op waves "${spec.name}"`;
  const rules = pushBranches(spec.branches).map((branch) => {
    assertGitlabBranch(subject, branch);
    return { if: gitlabPushRule(JSON.stringify(branch)) };
  });
  // The setup and environment each wave's jobs carry, checked as an Op's are.
  const setupOf = spec.waves.map((wave) => gitlabSetupScript(`${subject} wave "${wave.name}"`, wave.setup));
  for (const wave of spec.waves) if (wave.environment) assertGitlabEnvironment(`${spec.name}/${wave.name}`, wave.environment);
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

  const byReview = spec.waves.some((w) => w.approval === "pr-review");
  const stages = [...(byReview ? ["plans"] : []), ...spec.waves.map((wave, i) => `wave-${i + 1}-${wave.name}`)];
  // #4617: the control repo's token variables, which every job but the dispatch drops first.
  const control = spec.control ? opWavesControlTarget(spec.control) : undefined;
  const dropControl = control ? [`unset ${[...new Set([...CONTROL_TOKEN_VARS, control.tokenSecret, control.readTokenSecret])].join(" ")}`] : [];
  if (control) stages.push("control");
  if (spec.resume) stages.push("resume");
  const entries: Array<readonly [string, unknown]> = [["stages", stages]];
  const variables = nonEmpty("variables", options.variables).variables;
  if (variables) entries.push(["variables", variables]);
  if (byReview) {
    entries.push([
      `${spec.name}-record-plans`,
      {
        stage: "plans",
        image,
        ...(specTags ? { tags: specTags } : {}),
        variables: { ...GITLAB_FULL_HISTORY },
        rules: [{ if: GITLAB_MERGE_REQUEST_SOURCE }],
        script: [...dropControl, ...(options.beforeScript ?? []), opWavesRecordPlansCommand(options.specFile, options.bin).join(" ")],
      },
    ]);
    // #4630: a GitLab approval starts no pipeline, so a schedule of the target branch posts every open merge request's status.
    entries.push([
      `${spec.name}-approval-status`,
      {
        stage: "plans",
        image,
        ...(specTags ? { tags: specTags } : {}),
        variables: { ...GITLAB_FULL_HISTORY },
        rules: [{ if: `${GITLAB_SCHEDULE_SOURCE} && $${OP_WAVES_APPROVAL_STATUS_VAR} == "1"` }],
        script: [...dropControl, ...(options.beforeScript ?? []), opWavesApprovalStatusCommand(options.specFile, "gitlab", options.bin).join(" ")],
      },
    ]);
  }
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    const group = opWaveGroupOf(spec, job);
    const setup = [...setupOf[job.wave - 1]!, ...(group ? groupSetup.get(`${wave.name}/${group.name}`)! : [])];
    const tags = gitlabTags(group?.runner ?? wave.runner ?? spec.runner);
    const environment = group?.environment ?? wave.environment;
    // #4332: the job's cloud identities, traded first.
    const cloud = group?.cloud ?? wave.cloud;
    const declared = gitlabIdTokensDoc(group?.idTokens ?? wave.idTokens);
    const idTokens = cloud ? { ...declared, ...gitlabTradeIdTokens(cloud) } : declared;
    // #4624: the apply-job guard, the script's first line, before the trade.
    const runner = group?.runner ?? wave.runner ?? spec.runner;
    const guard = jobGuardSpec({
      forge: "gitlab",
      job: opWaveJobLabel(spec.name, job),
      product,
      ...(environment ? { environment: environment.name } : {}),
      branches: pushBranches(spec.branches),
      ...(runner !== undefined ? { runner } : {}),
    });
    entries.push([
      job.jobName,
      {
        stage: stages[job.wave - 1 + (byReview ? 1 : 0)],
        image,
        ...(tags ? { tags } : {}),
        resource_group: `${spec.name}-${wave.name}`,
        ...(environment ? { environment: environmentDoc(environment) } : {}),
        ...(idTokens ? { id_tokens: idTokens } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(wave.variables ?? {}), ...(group?.variables ?? {}), ...(cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(cloud) } : {}), [JOB_GUARD_ENV]: JSON.stringify(guard) },
        rules,
        ...(job.needs.length > 0 ? { needs: job.needs } : {}),
        script: [jobGuardLine(), ...(cloud ? gitlabTradeLines() : []), ...dropControl, ...setup, ...(options.beforeScript ?? []), job.command.join(" "), ...(options.extraScript ?? [])],
        // #4322: a run that failed, or was blocked, lets the next wave run; any other failure stops it.
        allow_failure: { exit_codes: [1] },
        artifacts: { when: "always", paths: [...(job.kind === "decide" ? [job.record!] : []), `${opWaveOutcomeDir(spec)}/`], expire_in: "30 days" },
      },
    ]);
  }
  if (control) {
    const dispatch = controlDispatchJob("gitlab", control, "$CI_COMMIT_SHA", {
      ...(options.words ? { words: options.words } : {}),
      ...(spec.control!.sentCheck ? { sentCheck: spec.control!.sentCheck } : {}),
      ...(spec.control!.markSent ? { markSent: spec.control!.markSent } : {}),
      outcome: true,
    });
    entries.push([
      dispatch.name,
      {
        stage: "control",
        image,
        ...(specTags ? { tags: specTags } : {}),
        rules,
        // The last wave's jobs hand on every job's outcome file through their artifacts.
        needs: opWavesLastJobs(jobs),
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
          ...Object.entries(dispatch.env).map(([k, v]) => `export ${k}="${v}"`),
          `bash <<'CONTROL_DISPATCH' || exit $?\n${dispatch.script}\nCONTROL_DISPATCH`,
        ],
      },
    ]);
  }
  if (spec.resume) {
    entries.push([
      `${spec.name}-resume`,
      {
        stage: "resume",
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
    "# failure, and the waves after it run what does not depend on those runs.",
    ...(spec.resume
      ? [`# The ${spec.name}-resume job retries it for you in a pipeline schedule; give the schedule the cron "${spec.resume.schedule}".`]
      : []),
    ...(byReview
      ? [`# The ${spec.name}-approval-status job posts each open merge request's approval status from a pipeline schedule that sets ${OP_WAVES_APPROVAL_STATUS_VAR}=1.`]
      : []),
    ...(control ? [`# After the last wave, the control-dispatch job tells ${control.repo} how the waves ended.`] : []),
  ];
  const name = options.opsFileName ?? `${spec.name}.gitlab-ci.yml`;
  return { files: [{ name, yaml: emitGitlabFile(entries, header) }], jobs };
}
