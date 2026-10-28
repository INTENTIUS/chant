/**
 * Generate mode — component → GitLab CI YAML (#563, epic #551, Phase 3).
 *
 * The other half of "two modes, both anti-sprawl" (see
 * docs/src/content/docs/components/orchestration.mdx#generate-mode and epic
 * #551 §"5. Orchestrator → generate mode"): interpret mode (`../driver.ts`,
 * #556) runs components directly; generate mode synthesizes a **thin**
 * `.gitlab-ci.yml` from the same declarations for teams who want plain CI as
 * the trigger/runner.
 *
 * The generated pipeline is a trigger, not the deploy logic:
 *  - Ordering + parallel-safe waves are resolved once, generically, by
 *    `resolveComponentGraph` (../driver.ts) — the exact function the local
 *    interpret driver uses. Generate mode does not re-derive or duplicate
 *    that graph logic.
 *  - Each wave becomes one GitLab CI `stage`; every component in a wave
 *    becomes one job in that stage, so independent components run in
 *    parallel and dependents wait for their dependencies via natural stage
 *    ordering (mirrored explicitly with `needs:` for direct edges, so GitLab
 *    can still parallelize across non-adjacent stages when safe).
 *  - Each job's `script` is exactly one invocation that hands off to the
 *    component's own composition (`chant run --components <name> ...` by
 *    default) — never inlined build/publish/apply steps. The deploy logic
 *    lives in the component's `deploy` phases and the capabilities they
 *    reference, not in this YAML.
 *
 * Cross-cutting changes (e.g. "sign every image before deploy") are made by
 * editing `GenerateGitlabOptions.extraScript`/`beforeScript` (or the
 * component's own composition) ONCE here — never per generated job. See
 * `generate-gitlab.test.ts`'s "cross-cutting change" case for a
 * demonstration: one generator-option edit reflects in every job without
 * touching the component declarations.
 */

import {
  assertGitlabBranch,
  assertRunnerLabels,
  CI_IMAGE,
  ciJobName,
  fillCommand,
  GITLAB_FULL_HISTORY,
  GITLAB_MERGE_REQUEST_SOURCE,
  gitlabPushRule,
  gitlabTags,
} from "@intentius/chant/ci-jobs";
import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import { hasPublishStep, promoteArchivePaths } from "@intentius/chant/components/promote";
import { GATED_WAVE_RECORD, gatedWaveJobs } from "@intentius/chant/components/gated-wave-pipeline";
import {
  PR_APPLY_RECORD,
  PR_LOOP_REPORT_DIR,
  prApplyGroup,
  prRecordGroup,
  prApplyRecordKey,
  prApplyWaveJobName,
  prLoopJobs,
  GITLAB_APPLY_PR_VAR,
  GITLAB_PLAN_NOTES_VAR,
  gitlabPlanJobName,
  prLoopPostJob,
  prLoopSetup,
  PR_PLAN_NOTE_JOB,
  prLoopWaveJobs,
  prLoopWithWaves,
  prEnvJobs,
  prCommentLockJobs,
  prCommentPreviewJob,
  PR_ENV_REPORT_DIR,
  PR_ENV_POST_JOB,
  prLoopJobStage,
  prLoopRunner,
} from "@intentius/chant/components/pr-pipeline";
import { REPO_APPLY_GROUP } from "@intentius/chant/components/repo-lock";
import { memberGitlabChanges, memberRepoPath, memberShellDir } from "@intentius/chant/lexicon";
import { FORGE_TOKEN_VARS, GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { CONTROL_TOKEN_VARS, controlDispatchJob, controlNoteCheckout } from "@intentius/chant/control/dispatch";
import { gitlabTradeIdTokens, gitlabTradeLines, TRADE_SPEC_ENV, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import type {
  ComponentPipelineJob as GeneratedJob,
  ComponentPipelineOptions as GenerateGitlabOptions,
  ComponentPipelineResult as GenerateGitlabResult,
  PipelineMember,
} from "@intentius/chant/lexicon";

import { emitGitlabFile } from "./ci-jobs";

export type { GeneratedJob, GenerateGitlabOptions, GenerateGitlabResult };

/**
 * Synthesize a `.gitlab-ci.yml` pipeline from a set of components: one stage
 * per parallel-safe wave (`resolveComponentGraph`), one thin trigger job per
 * component. Throws `DependencyCycleError`/`UnknownDependencyError` (from
 * core's driver) exactly like the interpret driver does, since both consume
 * the same graph resolution. Wired into core's generate mode via the gitlab
 * lexicon plugin's `generateComponentPipeline` (../plugin.ts).
 */
export function generateGitlabPipeline(
  components: DriverComponent[],
  options: GenerateGitlabOptions = {},
): GenerateGitlabResult {
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
    return prLoopGitlabPipeline(components, env, image, beforeScript, extraScript, { ...options, prLoop });
  }

  if (options.gatedWaves) {
    if (options.promoteTo !== undefined) throw new Error("a gated-wave pipeline has no promote job; drop --promote-to or --wave-gate");
    return gatedWaveGitlabPipeline(components, env, image, beforeScript, extraScript, options);
  }

  // Components that something else depends on must hand their resolved outputs
  // (stack outputs, published artifact refs) to their dependents, which run as
  // separate jobs/processes. Each such producer dumps its outputs to a file and
  // declares it a job artifact; each dependent seeds from that file (delivered
  // across the `needs:` edge by GitLab's artifact passing) so a `stackOutput()`
  // / `@<dep>.publish.*` reference resolves even though the producer ran in a
  // different job. Without this, a single-component job has no in-memory outputs
  // for its dependencies — see epic #551 / the adopt-alb-services example.
  const dependedUpon = new Set<string>();
  for (const c of components) for (const dep of c.dependsOn ?? []) dependedUpon.add(dep);
  const outputsFile = (name: string) => `${name}.outputs.json`;

  // A promote job (#2575) runs apart from the deploy jobs, and a promote
  // publishes from the build archive on disk, so each component job keeps the
  // files its build steps wrote as artifacts. GitLab hands them to the promote
  // job across its `needs:` edges. Each component job with a publish step
  // also keeps the digest its run recorded (`--digest-file`), and the promote
  // job passes it back as `--digest <component>=<digest>` (#2602), so it
  // promotes the release this run built rather than whatever is latest in the
  // source environment.
  const promoteTo = options.promoteTo;
  const archives = new Map<string, string[]>();
  const pinned = new Set<string>();
  const digestFile = (name: string) => `${name}.digest`;
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

  const doc: Record<string, unknown> = {};
  // `workflow:name` + a CHANT_ENV variable give the document a recoverable
  // environment identity (#2046): two pipelines generated for two
  // environments were previously identical except for one shell argument in
  // each job's `script:`. CHANT_ENV always reflects the environment baked
  // into the run lines, so a caller-supplied variable of the same name cannot
  // make the document lie about what its jobs deploy.
  doc.workflow = { name: `chant-components-${env}` };
  doc.stages = stages;
  doc.variables = { ...options.variables, CHANT_ENV: env };

  waves.forEach((wave, waveIndex) => {
    const stage = stages[waveIndex];
    for (const name of wave) {
      const component = byName.get(name)!;
      const jobName = jobNameByComponent.get(name)!;
      const needs = (component.dependsOn ?? []).map((dep) => jobNameByComponent.get(dep)!).sort();

      jobs.push({ jobName, component: name, stage, needs });

      // Build the run invocation, then append output-threading flags: seed from
      // each dependency's dumped outputs, and dump this component's own outputs
      // if a dependent will need them.
      const runParts = fillCommand(runCommand, name);
      for (const dep of component.dependsOn ?? []) runParts.push("--seed-outputs", outputsFile(dep));
      if (dependedUpon.has(name)) runParts.push("--dump-outputs", outputsFile(name));
      if (pinned.has(name)) runParts.push("--digest-file", digestFile(name));

      const script = [...beforeScript, runParts.join(" "), ...extraScript];

      const jobProps: Record<string, unknown> = {
        stage,
        image,
        script,
      };
      if (needs.length > 0) jobProps.needs = needs;
      // Publish this component's dumped outputs so dependent jobs receive it.
      const artifactPaths = [
        ...(dependedUpon.has(name) ? [outputsFile(name)] : []),
        ...(archives.get(name) ?? []),
        ...(pinned.has(name) ? [digestFile(name)] : []),
      ];
      if (artifactPaths.length > 0) jobProps.artifacts = { paths: artifactPaths };
      doc[jobName] = jobProps;
    }
  });

  let promoteJob: string | undefined;
  if (promoteTo !== undefined) {
    promoteJob = `promote-${ciJobName(promoteTo)}`;
    if (promoteJob in doc) {
      throw new Error(`the promote job "${promoteJob}" has the same name as a component job; rename the component`);
    }
    const command = [...(options.promoteCommand ?? ["chant", "components", "promote", "--from", env, "--to", promoteTo])];
    // The file holds `<component>=<digest>`; a missing or empty one leaves
    // `<component>=`, which the promote refuses.
    for (const name of [...pinned].sort()) {
      command.push("--digest", `"${name}=$(cut -d= -f2- ${digestFile(name)})"`);
    }
    doc[promoteJob] = {
      stage: "promote",
      image,
      script: [...beforeScript, command.join(" "), ...extraScript],
      needs: [...jobNameByComponent.values()].sort(),
    };
  }

  if (options.member) {
    promoteJob = scopeToMember(doc, jobs, promoteJob, options.member, env);
  }

  // The promote stage is YAML only: `stages` in the result stays one entry
  // per graph wave.
  const yamlStages = promoteJob ? [...stages, "promote"] : stages;
  const yaml = emitGitlabFile([
    ["workflow", doc.workflow],
    ["stages", yamlStages],
    ["variables", doc.variables],
    ...jobs.map((job) => [job.jobName, doc[job.jobName]] as const),
    ...(promoteJob ? [[promoteJob, doc[promoteJob]] as const] : []),
  ]);
  return { yaml, stages, jobs, env };
}

/**
 * The gated-wave pipeline (#3049): one job per wave, each running one wave of
 * `chant components fan-out --wave-gate`, in order through `needs:`. The
 * attempt record is the artifact GitLab hands from job to job, kept even when
 * a job stops at a gate (exit 3) so the re-run after `chant approve` reads it.
 * `GIT_DEPTH: "0"` gives the job the history `--base` diffs against.
 */
function gatedWaveGitlabPipeline(
  components: DriverComponent[],
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGitlabOptions,
): GenerateGitlabResult {
  const waveJobs = gatedWaveJobs(components, env, options.gatedWaves!);
  const stages = waveJobs.map((j) => j.jobName);
  const doc: Record<string, unknown> = {
    workflow: { name: `chant-components-${env}` },
    stages,
    variables: { ...options.variables, CHANT_ENV: env },
  };
  const jobs: GeneratedJob[] = [];
  for (const job of waveJobs) {
    jobs.push({ jobName: job.jobName, component: `wave ${job.wave}`, stage: job.jobName, needs: job.needs });
    doc[job.jobName] = {
      stage: job.jobName,
      image,
      variables: { ...GITLAB_FULL_HISTORY },
      script: [...prLoopSetup(image), ...beforeScript, job.command.join(" "), ...extraScript],
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      // #4291: a wave runs after one that failed, and blocks only what depends on the failure.
      ...(job.needs.length > 0 ? { when: "always" } : {}),
      artifacts: { when: "always", paths: [GATED_WAVE_RECORD] },
    };
  }
  if (options.member) scopeToMember(doc, jobs, undefined, options.member, env);
  const yaml = emitGitlabFile([
    ["workflow", doc.workflow],
    ["stages", stages],
    ["variables", doc.variables],
    ...jobs.map((job) => [job.jobName, doc[job.jobName]] as const),
  ]);
  return { yaml, stages, jobs, env };
}

/**
 * The merge-request pipeline (#3183): `plan` in each merge request pipeline,
 * and on each push to the target branch `record` (#4168), or `apply` with
 * `applyOnMerge`, one at a time per environment (`resource_group`). `GIT_DEPTH: "0"` gives both the history
 * they measure the change with. The jobs talk to GitLab with
 * `CHANT_FORGE_TOKEN`, a project or group access token with the `api` scope
 * set as a masked CI/CD variable, since a job token cannot write notes.
 *
 * For a workspace member (#3465) the file is one the root `.gitlab-ci.yml`
 * includes, so the jobs are `<member>-plan` and `<member>-apply`, each
 * script starts with a `cd` into the member's directory and the report
 * artifact is kept from there. The jobs take no `changes:` rule, since a
 * change outside the member can reach it; the plan selects from the whole
 * change and passes `--member`, which keeps the member's gate, note and
 * statuses apart from the other members'. The apply's resource group is the
 * member's own.
 *
 * The apply job keeps its attempt record in the job cache under the pushed
 * commit, uploaded whether the job passed or failed, so a retry of a failed
 * apply passes it to `pr-apply --resume` (#3543). GitLab keeps protected
 * branches' caches apart from other branches' by default, so a merge request
 * pipeline cannot write the record the target branch's apply reads.
 *
 * With a gate per wave (`waveGate`, #4003) the apply job becomes
 * `apply-wave-1` to `apply-wave-<n>`, one stage each, each needing the one
 * before. They share the commit's cache key, so wave k pulls the record wave
 * k-1 pushed, and a retry of a wave that stopped at its gate pulls the one it
 * pushed itself.
 *
 * The plan job holds no forge token while the merge request's code runs
 * (#4295, `@intentius/chant/ci-handover`): its script starts by unsetting
 * the token variables, and `pr-plan --no-status` writes the note and the
 * status into its report, which it keeps as its artifact. GitLab builds a
 * merge request pipeline from the merge request's own files, so no job in it
 * may hold the token (#4328): `CHANT_FORGE_TOKEN` and `CHANT_RUNNER_KEY` are
 * protected variables, which a merge request pipeline never gets. The
 * `plan-note` job runs in a pipeline of the target branch, built from that
 * branch's files, that a pipeline schedule (or a person) starts with
 * `CHANT_PLAN_NOTES` set to `1`. It runs `chant components pr-post --open`,
 * which asks GitLab for each open merge request's plan job, reads the report
 * from its artifacts and posts the note and the status for each job that
 * settled since the last run.
 *
 * With `identity` (#4296, `@intentius/chant/ci-identity`) the plan, record
 * and apply jobs take an `id_tokens:` entry per cloud, and each script
 * starts by trading it for the job's cloud identity: the plan and record
 * jobs for the plan identity, the apply jobs for the apply identity. The
 * plan job trades before any of the merge request's code runs, then unsets
 * the token variables with the forge tokens and sources the credentials.
 */
/** The dotenv report a gated apply wave hands the green commit it applies through (#4221). */
const WAVE_GREEN_DOTENV = "chant-green.env";

/**
 * The rule of the apply before merge (#4301, ws-106): a pipeline of `branch`
 * that a person started from the UI, the API or a trigger with
 * `CHANT_APPLY_PR` set to the merge request's iid. GitLab builds a merge
 * request's own pipeline from its own files, so the apply runs in one of the
 * target branch's. The variable only names the merge request; `pr-apply
 * --before-merge` reads the rest from GitLab.
 */
function gitlabApplyPrRule(branch: string): string {
  return `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${GITLAB_APPLY_PR_VAR} =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == ${branch}`;
}

/**
 * The rule of the plan-note job (#4328): a pipeline of `branch` that a
 * pipeline schedule, a person or a trigger started with `CHANT_PLAN_NOTES`
 * set to `1`. A merge request pipeline's own trigger job starts a pipeline
 * whose source is `pipeline`, which this rule leaves out.
 */
function gitlabPlanNotesRule(branch: string): string {
  return `$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $${GITLAB_PLAN_NOTES_VAR} == "1" && $CI_COMMIT_BRANCH == ${branch}`;
}

/** Drops the credentials GitLab's runner writes into origin's URL (#4620), before a merge request's code runs in a pipeline of the target branch. */
const GITLAB_SCRUB_ORIGIN = `git remote set-url origin "$(git remote get-url origin | sed -E 's#//[^@/]*@#//#')"`;

/** The rule of a pipeline for a pushed `ci/green/` tag (#4168 step 9), which runs the apply under apply on merge. */
const GITLAB_GREEN_TAG_RULE = '$CI_COMMIT_TAG =~ /^ci\\/green\\//';

function prLoopGitlabPipeline(
  components: DriverComponent[],
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGitlabOptions,
): GenerateGitlabResult {
  const loop = options.prLoop!;
  const member = options.member;
  const rooted = !member || member.dir === "." || member.dir === "";
  const [plan, apply, record] = prLoopJobs("gitlab", env, loop, member?.name);
  const reportPath = member ? memberRepoPath(member, PR_LOOP_REPORT_DIR) : PR_LOOP_REPORT_DIR;
  // #4328: the plan-note job's pr-post --open finds the plan job by this name.
  const planJob = gitlabPlanJobName(member?.name);
  const named = (job: string) => (member ? `${member.name}-${job}` : job);
  const waveJobs = loop.waveGate ? prLoopWaveJobs(components, apply) : [];
  // #4168 step 9: a push to the branch records, and under apply on merge a ci/green/ tag pipeline applies.
  const greens = loop.waveGate
    ? waveJobs.map((job) => ({ job, name: named(prApplyWaveJobName(job.wave!)), stage: prApplyWaveJobName(job.wave!) }))
    : loop.applyOnMerge || loop.applyBeforeMerge
      ? [{ job: apply, name: named("apply"), stage: "apply" }]
      : [];
  const applies = [{ job: record, name: named("record"), stage: "record" }, ...greens];
  const onMergeRequest = GITLAB_MERGE_REQUEST_SOURCE;
  if (loop.branch !== undefined) assertGitlabBranch("The merge-request pipeline", loop.branch);
  const onMerge = gitlabPushRule(loop.branch ? JSON.stringify(loop.branch) : "$CI_DEFAULT_BRANCH");
  // #4301: the apply before merge runs in a pipeline of the target branch a person starts with CHANT_APPLY_PR set.
  // #4328: the plan notes are posted from a pipeline of the target branch, never from the merge request's own.
  const onPlanNotes = gitlabPlanNotesRule(loop.branch ? JSON.stringify(loop.branch) : "$CI_DEFAULT_BRANCH");
  const onGreen = loop.applyBeforeMerge ? gitlabApplyPrRule(loop.branch ? JSON.stringify(loop.branch) : "$CI_DEFAULT_BRANCH") : GITLAB_GREEN_TAG_RULE;
  // A member's jobs start in its directory, after the image's install lines.
  const enter = rooted ? [] : [`cd ${memberShellDir(member!)}`];
  // The command runs through chant ci run (#4156), which writes the job's run record, signed when the CHANT_RUNNER_KEY variable is set.
  // #4221: a wave job hands the commit it applies to the next wave as GREEN_SHA, through a dotenv report.
  const handOff = (job: typeof plan): string[] => (job.wave ? [`echo "GREEN_SHA=$GREEN_SHA" > "$CI_PROJECT_DIR/${WAVE_GREEN_DOTENV}"`] : []);
  const script = (job: typeof plan): string[] => [...prLoopSetup(image, loop.engineSetup), ...enter, ...beforeScript, ...(job.checkout ?? []), ...handOff(job), ...(job.setup ?? []), ...(job.build ?? []), job.run.command, ...extraScript];
  // #4296: each job trades its OIDC token for its cloud identity before anything else in its script.
  const identity = loop.identity;
  const trading = (spec: CloudTradeSpec | undefined): Record<string, unknown> =>
    spec ? { id_tokens: gitlabTradeIdTokens(spec) } : {};
  const tradeVars = (spec: CloudTradeSpec | undefined): Record<string, string> => (spec ? { [TRADE_SPEC_ENV]: JSON.stringify(spec) } : {});
  const applySpec = (job: typeof plan): CloudTradeSpec | undefined => (identity ? (job.jobName === "record" ? identity.plan : identity.apply) : undefined);
  // #4298: a pull request environment's jobs, in a stage of their own after the plan.
  const prEnv = loop.prEnvironment ? prEnvGitlabJobs(image, beforeScript, extraScript, enter, loop, member, named, onMergeRequest) : undefined;
  // #4568: once the last apply on merge succeeded, one job tells the control repo this member applied.
  const lastGreen = loop.control && !loop.applyBeforeMerge && greens.length > 0 ? greens[greens.length - 1]!.name : undefined;
  const control =
    loop.control && lastGreen
      ? controlDispatchJob("gitlab", loop.control.target, loop.waveGate ? "$GREEN_SHA" : "$CI_COMMIT_SHA", {
          ...(loop.words ? { words: loop.words } : {}),
          ...(loop.control.sentCheck ? { sentCheck: loop.control.sentCheck } : {}),
          ...(loop.control.markSent ? { markSent: loop.control.markSent } : {}),
        })
      : undefined;
  const controlJob = control ? named(control.name) : undefined;
  // A CI/CD variable reaches every job, so the plan job drops the control repo's tokens with the forge tokens.
  const dropControl = loop.control
    ? [`unset ${[...new Set([...CONTROL_TOKEN_VARS, loop.control.target.tokenSecret, loop.control.target.readTokenSecret])].join(" ")}`]
    : [];
  // #4588: `/<product> lock` and `/<product> unlock`: GitLab starts no pipeline on a note, so each runs in a
  // pipeline of the target branch started with CHANT_LOCK_PR or CHANT_UNLOCK_PR set, as the apply before merge does.
  const targetBranch = loop.branch ? JSON.stringify(loop.branch) : "$CI_DEFAULT_BRANCH";
  const commentLocks = prCommentLockJobs("gitlab", loop).map((job) => ({
    job,
    name: named(job.jobName),
    rule: `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${job.gitlabVar} =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == ${targetBranch}`,
  }));
  // #4620: `/<product> <plan word>`: a pipeline of the target branch started with CHANT_PREVIEW_PR set previews the merge request's head again.
  const preview = prCommentPreviewJob("gitlab", env, loop, member?.name);
  const previewRule = preview ? `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${preview.gitlabVar} =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == ${targetBranch}` : undefined;
  const previewName = preview ? named(preview.jobName) : undefined;
  const previewNoteName = preview ? named(preview.noteJobName) : undefined;
  const stages = ["plan", PR_PLAN_NOTE_JOB, ...commentLocks.map((c) => c.job.jobName), ...(preview ? [preview.jobName, preview.noteJobName] : []), ...applies.map((a) => a.stage), ...(control ? [control.name] : []), ...(prEnv ? [PR_ENV_STAGE, PR_ENV_POST_STAGE] : [])];
  const noteJob = named(PR_PLAN_NOTE_JOB);
  const post = prLoopPostJob("gitlab", env, member?.name, loop.words ? { ...(loop.words.bin ? { bin: loop.words.bin } : {}) } : undefined);
  // #4619: with a control repo named, the note job reads its chant/lifecycle, read-only, so pr-post marks the cross-stack edges.
  const controlRead = loop.control ? controlNoteCheckout("gitlab", loop.control.target, loop.words ?? {}) : undefined;
  const doc: Record<string, unknown> = {
    // Included files merge their top-level keys, so a member's file carries
    // the rules every member shares and no name: two names would collide.
    workflow: { ...(member ? {} : { name: `chant-pr-${env}` }), rules: [{ if: onMergeRequest }, { if: onMerge }, { if: onPlanNotes }, ...(greens.length > 0 ? [{ if: onGreen }] : []), ...commentLocks.map((c) => ({ if: c.rule })), ...(previewRule ? [{ if: previewRule }] : []), ...(prEnv ? [{ if: GITLAB_SCHEDULE_RULE }] : [])] },
    stages,
    variables: { ...options.variables, CHANT_ENV: env, ...GITLAB_FULL_HISTORY },
    [planJob]: {
      stage: "plan",
      image,
      rules: [{ if: onMergeRequest }],
      ...trading(identity?.plan),
      variables: { ...plan.run.env, ...tradeVars(identity?.plan) },
      // #4295: the merge request's code runs in this job, so the job's shell drops the forge tokens first.
      // #4296: with identity, the trade runs before that, and the same unset drops the token variables too.
      script: [...(identity ? gitlabTradeLines(FORGE_TOKEN_VARS) : [GITLAB_DROP_FORGE_TOKENS]), ...dropControl, ...script(plan)],
      artifacts: { when: "always", paths: [reportPath] },
    },
    // #4295, #4328: a job of the target branch's pipeline posts each open merge request's note and status from its plan job's report.
    [noteJob]: {
      stage: PR_PLAN_NOTE_JOB,
      image,
      rules: [{ if: onPlanNotes }],
      script: [...enter, ...beforeScript, ...(controlRead ? [controlRead.script] : []), post.command],
    },
    ...Object.fromEntries(
      commentLocks.map(({ job, name, rule }) => [
        name,
        // The target branch's commit, so none of the merge request's code runs here.
        { stage: job.jobName, image, rules: [{ if: rule }], variables: job.env, script: [...enter, ...beforeScript, job.line] },
      ]),
    ),
    ...(preview && previewName && previewNoteName && previewRule
      ? {
          [previewName]: {
            stage: preview.jobName,
            image,
            rules: [{ if: previewRule }],
            ...trading(identity?.plan),
            variables: { ...preview.plan.run.env, ...tradeVars(identity?.plan) },
            // A pipeline of the target branch holds the protected tokens, so the job drops them before it checks out the merge request's head.
            script: [
              ...(identity ? gitlabTradeLines(FORGE_TOKEN_VARS) : [GITLAB_DROP_FORGE_TOKENS]),
              ...dropControl,
              "unset CHANT_RUNNER_KEY",
              ...("line" in preview.head ? [preview.head.line] : []),
              // The ledger while the clone can still fetch it: the plan reads the gate ledger from the local branch.
              "git fetch -q --no-tags origin '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle' 2>/dev/null || true",
              // The runner's clone keeps the job token in origin's URL; the merge request's code never sees it.
              GITLAB_SCRUB_ORIGIN,
              preview.base,
              ...prLoopSetup(image, loop.engineSetup),
              ...enter,
              ...beforeScript,
              ...(preview.plan.setup ?? []),
              ...(preview.plan.build ?? []),
              preview.plan.run.command,
              ...extraScript,
            ],
            artifacts: { when: "always", paths: [reportPath] },
          },
          [previewNoteName]: {
            stage: preview.noteJobName,
            image,
            needs: [{ job: previewName, artifacts: true }],
            rules: [{ if: previewRule, when: "always" }],
            variables: preview.post.env,
            // The target branch's commit: the job's own clone, where none of the merge request's code runs.
            script: [...enter, ...beforeScript, ...(controlRead ? [controlRead.script] : []), ...(preview.post.setup ?? []), preview.post.command],
          },
        }
      : {}),
    ...Object.fromEntries(
      applies.map(({ job, name, stage }, i) => [
        name,
        {
          stage,
          image,
          ...(i > 1 ? { needs: [applies[i - 1]!.name] } : {}),
          // #4552: on the repo grain every apply of the repository shares one resource group.
          resource_group: job.jobName === "record" ? prRecordGroup(env, member?.name) : loop.lockGrain === "repo" ? REPO_APPLY_GROUP : prApplyGroup(env, member?.name),
          // #4291: a wave after the first runs after one that failed, and blocks only what depends on the failure.
          rules: [{ if: job.jobName === "record" ? onMerge : onGreen, ...(job.wave && i > 1 ? { when: "always" } : {}) }],
          ...trading(applySpec(job)),
          variables: { ...job.run.env, ...tradeVars(applySpec(job)) },
          script: [...(applySpec(job) ? gitlabTradeLines() : []), ...script(job)],
          // The attempt record (#3543), kept under the pushed commit even when
          // the job fails, so a retry finishes the apply under the same approval.
          // The record job (#4168) applies nothing and keeps none.
          ...(job.jobName === "record"
            ? {}
            : {
                cache: {
                  key: prApplyRecordKey(env, "$CI_COMMIT_SHA", member?.name),
                  paths: [member ? memberRepoPath(member, PR_APPLY_RECORD) : PR_APPLY_RECORD],
                  when: "always",
                },
              }),
          artifacts: { when: "always", paths: [reportPath], ...(job.wave ? { reports: { dotenv: WAVE_GREEN_DOTENV } } : {}) },
        },
      ]),
    ),
    ...(control && controlJob
      ? {
          [controlJob]: {
            stage: control.name,
            image,
            needs: [lastGreen],
            rules: [{ if: onGreen }],
            // The runner sets a needed job's dotenv values when the script starts, so the commit is read there.
            script: [
              ...Object.entries(control.env).map(([k, v]) => `export ${k}="${v}"`),
              `bash <<'CONTROL_DISPATCH' || exit $?\n${control.script}\nCONTROL_DISPATCH`,
            ],
          },
        }
      : {}),
  ...(prEnv ? prEnv.jobs : {}),
  };
  const jobs: GeneratedJob[] = [
    { jobName: planJob, component: "merge request plan", stage: "plan", needs: [] },
    { jobName: noteJob, component: "merge request plan note", stage: PR_PLAN_NOTE_JOB, needs: [] },
    ...commentLocks.map(({ job, name }) => ({ jobName: name, component: `merge request ${job.command} comment`, stage: job.jobName, needs: [] })),
    ...(preview && previewName && previewNoteName
      ? [
          { jobName: previewName, component: "merge request preview comment", stage: preview.jobName, needs: [] },
          { jobName: previewNoteName, component: "merge request preview comment note", stage: preview.noteJobName, needs: [previewName] },
        ]
      : []),
    ...applies.map(({ job, name, stage }, i) => ({
      jobName: name,
      component: job.wave ? `green apply, wave ${job.wave}` : job.jobName === "record" ? "merge record" : loop.applyBeforeMerge ? "apply before merge" : "green apply",
      stage,
      needs: i > 1 ? [applies[i - 1]!.name] : [],
    })),
    ...(controlJob ? [{ jobName: controlJob, component: "control repo dispatch", stage: control!.name, needs: [lastGreen!] }] : []),
    ...(prEnv ? prEnv.listed : []),
  ];
  // #4625: each job on its stage's runner tags, the plan side's, the apply side's, or the default.
  if (loop.runners) {
    for (const stage of ["plan", "apply", "default"] as const) assertRunnerLabels("The merge-request pipeline", `runners.${stage}`, loop.runners[stage], "GitLab");
    for (const job of jobs) {
      const tags = gitlabTags(prLoopRunner(loop, prLoopJobStage(job.jobName, member?.name)));
      const entry = doc[job.jobName] as Record<string, unknown> | undefined;
      if (tags && entry) doc[job.jobName] = { ...entry, tags };
    }
  }
  const yaml = emitGitlabFile(["workflow", "stages", "variables", planJob, noteJob, ...commentLocks.map((c) => c.name), ...(previewName && previewNoteName ? [previewName, previewNoteName] : []), ...applies.map((a) => a.name), ...(controlJob ? [controlJob] : []), ...Object.keys(prEnv?.jobs ?? {})].map((key) => [key, doc[key]] as const));
  return { yaml, stages, jobs, env };
}

/** The stage a pull request environment's jobs run in (#4298). */
const PR_ENV_STAGE = "env";

/** The rule of a scheduled pipeline, which runs `env-sweep` (#4298). */
const GITLAB_SCHEDULE_RULE = '$CI_PIPELINE_SOURCE == "schedule"';

/**
 * A pull request environment's jobs on GitLab (#4298). `env-up` runs in the
 * merge request pipeline and runs the change's code, so its script drops the
 * forge tokens first, as the plan job's does (#4295), and it keeps its report
 * and record as the artifact. `env-post`, at the target branch's commit,
 * keeps the record on chant/lifecycle and posts the note. `env-up` starts a
 * GitLab environment `pr-<iid>` whose stop job is `env-down`, so the
 * environment's Stop button tears it down. GitLab starts no pipeline when a
 * merge request closes, so `env-sweep`, from a pipeline schedule, is what
 * tears down a closed merge request's environment unattended, as it does one
 * whose TTL passed.
 */
function prEnvGitlabJobs(
  image: string,
  beforeScript: string[],
  extraScript: string[],
  enter: string[],
  loop: NonNullable<GenerateGitlabOptions["prLoop"]>,
  member: GenerateGitlabOptions["member"],
  named: (job: string) => string,
  onMergeRequest: string,
): { jobs: Record<string, unknown>; listed: GeneratedJob[] } {
  const [up, post, down, sweep] = prEnvJobs("gitlab", loop, member?.name);
  const reportPath = member ? memberRepoPath(member, PR_ENV_REPORT_DIR) : PR_ENV_REPORT_DIR;
  const environment = "pr-$CI_MERGE_REQUEST_IID";
  const group = `chant-pr-env-${member ? `${member.name}-` : ""}$CI_MERGE_REQUEST_IID`;
  const script = (j: typeof up): string[] => [...prLoopSetup(image, loop.engineSetup), ...enter, ...beforeScript, ...(j.build ?? []), j.command, ...extraScript];
  const artifacts = { when: "always", paths: [reportPath] };
  // #4330: env-up, env-down and env-sweep trade the job's OIDC token for the pull request environments' identity first.
  const identity = loop.prEnvIdentity;
  const trading = identity ? { id_tokens: gitlabTradeIdTokens(identity) } : {};
  const tradeVars: Record<string, string> = identity ? { [TRADE_SPEC_ENV]: JSON.stringify(identity) } : {};
  return {
    jobs: {
      [named("env-up")]: {
        stage: PR_ENV_STAGE,
        image,
        rules: [{ if: onMergeRequest }],
        resource_group: group,
        environment: { name: environment, on_stop: named("env-down") },
        ...trading,
        variables: { ...up.env, ...tradeVars },
        // #4295: the merge request's code runs in this job, so the job's shell drops the forge tokens first.
        // #4330: with an identity, the trade runs before that, and the same unset drops the token variables too.
        script: [...(identity ? gitlabTradeLines(FORGE_TOKEN_VARS) : [GITLAB_DROP_FORGE_TOKENS]), ...script(up)],
        artifacts,
      },
      [named(PR_ENV_POST_JOB)]: {
        stage: PR_ENV_POST_STAGE,
        image,
        needs: [named("env-up")],
        rules: [{ if: onMergeRequest, when: "always" }],
        variables: post.env,
        script: ['git checkout --quiet --detach "$BASE_SHA"', ...enter, ...beforeScript, post.command],
        artifacts,
      },
      [named("env-down")]: {
        stage: PR_ENV_STAGE,
        image,
        rules: [{ if: onMergeRequest, when: "manual" }],
        allow_failure: true,
        resource_group: group,
        environment: { name: environment, action: "stop" },
        ...trading,
        variables: { ...down.env, ...tradeVars },
        script: [...(identity ? gitlabTradeLines() : []), ...script(down)],
        artifacts,
      },
      [named("env-sweep")]: {
        stage: PR_ENV_STAGE,
        image,
        // #4328: not in the plan notes' schedule, which runs far more often than a sweep needs.
        rules: [{ if: `${GITLAB_SCHEDULE_RULE} && $${GITLAB_PLAN_NOTES_VAR} != "1"` }],
        resource_group: `chant-pr-env-sweep${member ? `-${member.name}` : ""}`,
        ...trading,
        variables: { ...sweep.env, ...tradeVars },
        script: [...(identity ? gitlabTradeLines() : []), ...script(sweep)],
        artifacts,
      },
    },
    listed: [
      { jobName: named("env-up"), component: "merge request environment", stage: PR_ENV_STAGE, needs: [] },
      { jobName: named(PR_ENV_POST_JOB), component: "merge request environment note", stage: PR_ENV_POST_STAGE, needs: [named("env-up")] },
      { jobName: named("env-down"), component: "merge request environment teardown", stage: PR_ENV_STAGE, needs: [] },
      { jobName: named("env-sweep"), component: "merge request environment sweep", stage: PR_ENV_STAGE, needs: [] },
    ],
  };
}

/** The stage the post job runs in, after `env-up` (#4295). */
const PR_ENV_POST_STAGE = "env-post";

/**
 * Scope a pipeline to one workspace member (#2542, #2524 D19), in place on
 * `doc` and `jobs`. Returns the promote job's new name.
 *
 * GitLab reads one `.gitlab-ci.yml`, so a member's pipeline is a file that
 * the root file includes, and job names share one namespace across every
 * included file. Each job therefore takes the member's name as a prefix. A
 * `rules: changes:` entry limits each job to changes under the member's
 * directory or to the pipeline file; for a member at `"."` there is no such
 * rule, since `changes` has no exclusions. Each job's script starts with a
 * `cd` into the member's directory, and artifact paths, which GitLab resolves
 * against the repository root, move under it.
 */
function scopeToMember(
  doc: Record<string, unknown>,
  jobs: GeneratedJob[],
  promoteJob: string | undefined,
  member: PipelineMember,
  env: string,
): string | undefined {
  const rooted = member.dir === "." || member.dir === "";
  const changes = memberGitlabChanges(member);
  const renamed = new Map<string, string>();
  for (const job of jobs) renamed.set(job.jobName, `${member.name}-${job.jobName}`);
  if (promoteJob) renamed.set(promoteJob, `${member.name}-${promoteJob}`);

  for (const [from, to] of renamed) {
    const props = doc[from] as Record<string, unknown>;
    delete doc[from];
    const next: Record<string, unknown> = { ...props };
    if (!rooted) next.script = [`cd ${memberShellDir(member)}`, ...(props.script as string[])];
    if (Array.isArray(props.needs)) next.needs = (props.needs as string[]).map((n) => renamed.get(n) ?? n);
    const artifacts = props.artifacts as { paths?: string[] } | undefined;
    if (artifacts?.paths) next.artifacts = { ...artifacts, paths: artifacts.paths.map((p) => memberRepoPath(member, p)) };
    if (changes) next.rules = [{ changes }];
    doc[to] = next;
  }
  for (const job of jobs) {
    job.jobName = renamed.get(job.jobName)!;
    job.needs = job.needs.map((n) => renamed.get(n) ?? n);
  }
  doc.workflow = { name: `chant-components.${member.name}.${env}` };
  return promoteJob ? renamed.get(promoteJob) : undefined;
}
