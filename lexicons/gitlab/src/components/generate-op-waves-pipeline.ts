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
  opWaveChecksDir,
  opWaveGroupOf,
  opWaveJobs,
  opWaveJobArtifactName,
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
import { CONTROL_OUTCOME_VAR, CONTROL_TOKEN_VARS, controlDispatchJob } from "@intentius/chant/control/dispatch";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
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
import { emitGitlabFile } from "./ci-jobs";

/** The one exit an op-wave job allows as a failure (#4322): a run that failed. The guard's refusal (9) is outside it. */
export const OP_WAVE_ALLOWED_EXIT = CHANT_EXIT.failed;

/** Render an Op waves spec as one GitLab CI file, `<name>.gitlab-ci.yml` unless `opsFileName` names another. */
export function generateGitlabOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const jobs = opWaveJobs(spec, options.specFile, { bin: options.bin });
  assertPipelineEvidence(options.evidence);
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

  // #4630: a pr-review or pull-request wave records each head's plans and posts the approval status.
  const byReview = opWavesPostsApprovalStatus(spec);
  const stages = [...(byReview ? ["plans"] : []), ...spec.waves.map((wave, i) => `wave-${i + 1}-${wave.name}`)];
  // #4617: the control repo's token variables, which every job but the dispatch drops first.
  const control = spec.control ? opWavesControlTarget(spec.control) : undefined;
  const dropControl = control ? [`unset ${[...new Set([...CONTROL_TOKEN_VARS, control.tokenSecret, control.readTokenSecret])].join(" ")}`] : [];
  if (control) stages.push("control");
  if (spec.resume) stages.push("resume");
  const entries: Array<readonly [string, unknown]> = [["stages", stages]];
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
      `${spec.name}-record-plans`,
      {
        stage: "plans",
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
  // #4926: how each wave job signs its checks, and the evidence jobs a later wave's evidence.requires waits for.
  const evidenceOf = (job: (typeof jobs)[number]) => {
    const cloud = opWaveGroupOf(spec, job)?.cloud ?? spec.waves[job.wave - 1]!.cloud;
    const signs = options.evidence !== undefined && (job.kind === "wave" || job.kind === "decide");
    // #4964: with a runner key, no wave job holds it; each wave's evidence job, in the chant-evidence environment, signs.
    return opWaveEvidencePlan(spec, job, { signs, keylessCloud: signs && evidenceKeyless(options.evidence) && cloud !== undefined, keyOutOfWave: signs && !evidenceKeyless(options.evidence) });
  };
  const evidenceNeeds = opWaveEvidenceNeeds(spec, jobs.map((job) => ({ wave: job.wave, plan: evidenceOf(job) })));
  for (const job of jobs) {
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
      branches: pushBranches(spec.branches),
      ...(runner !== undefined ? { runner } : {}),
    });
    const stage = stages[job.wave - 1 + (byReview ? 1 : 0)];
    const checksDir = `${opWaveChecksDir(spec)}/`;
    const policyJob = evidence?.policyStep ? opWavePolicyJobName(job) : undefined;
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
          variables: { ...GITLAB_FULL_HISTORY, ...timeout.env, ...(wave.variables ?? {}), ...(cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(cloud) } : {}), [JOB_GUARD_ENV]: JSON.stringify(guard) },
          rules,
          ...(job.needs.length > 0 ? { needs: job.needs } : {}),
          script: [jobGuardLine(), ...(cloud ? gitlabTradeLines() : []), ...dropControl, ...setup, ...(options.beforeScript ?? []), ...(add?.before ?? []).flatMap((st) => st.run), opWavePolicyCommand(job).join(" ")],
          allow_failure: true,
          artifacts: { when: "always", paths: [checksDir], expire_in: "30 days" },
        },
      ]);
    }
    const needs = [...job.needs, ...(policyJob ? [policyJob] : []), ...(job.kind === "share" ? [] : evidenceNeeds(job.wave))];
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
          ...(wave.variables ?? {}),
          ...(group?.variables ?? {}),
          ...(cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(cloud) } : {}),
          [JOB_GUARD_ENV]: JSON.stringify(guard),
          ...(signs ? evidenceKeyEnv("gitlab", options.evidence!) : {}),
          ...(evidence?.commandMode ? { [WAVE_EVIDENCE_ENV]: evidence.commandMode } : {}),
        },
        rules,
        ...(needs.length > 0 ? { needs } : {}),
        script: [
          jobGuardLine(),
          ...(cloud ? gitlabTradeLines() : []),
          ...dropControl,
          ...setup,
          ...(options.beforeScript ?? []),
          ...(add?.before ?? []).flatMap((st) => st.run),
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
          paths: [...(job.kind === "decide" ? [job.record!] : []), `${opWaveOutcomeDir(spec)}/`, ...(evidence?.evidenceJob ? [checksDir] : []), ...(add?.artifact ? [add.artifact.path] : [])],
          expire_in: "30 days",
        },
      },
    ]);
    if (evidence?.evidenceJob) {
      // #4926: after the wave job, a job that runs none of the change's code signs from the jobs' statuses.
      const lines = opWaveEvidenceLines(spec, evidence, job, { sha: '"$CI_COMMIT_SHA"', ...(options.bin ? { bin: options.bin } : {}) });
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
          variables: { ...GITLAB_FULL_HISTORY, [EVIDENCE_SOURCES_ENV]: JSON.stringify(opWaveEvidenceSources("gitlab", evidence, job, wave.name, "")), ...evidenceKeyEnv("gitlab", options.evidence!) },
          rules,
          needs: [job.jobName, ...(policyJob ? [policyJob] : [])],
          script: [...dropControl, ...lines.checkout, ...setupOf[job.wave - 1]!, ...(options.beforeScript ?? []), ...lines.sign],
          // A refused or failed evidence job leaves the later waves to run; their evidence.requires speaks for itself.
          allow_failure: true,
        },
      ]);
    }
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
    "# failure, and the waves after it run what does not depend on those runs. A job",
    "# whose guard finds it running where the spec did not set it to run exits 9 and",
    "# stops the waves after it.",
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
