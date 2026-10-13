/**
 * Generate mode — Op → GitLab CI YAML (#927, #2084, #2256).
 *
 * The Op counterpart to `./generate-pipeline.ts` (#563): that module
 * synthesizes a deploy-time component graph as one `.gitlab-ci.yml`; this one
 * synthesizes one job per Op, selected by its own `rules:`.
 *
 * What GitLab genuinely lacks is in-file cron. A schedule is a project-level
 * object (Settings → CI/CD → Schedules) that runs the project's *existing*
 * `.gitlab-ci.yml` with a chosen cron and CI/CD variables, so a cron-triggered
 * Op becomes a job gated on `$CI_PIPELINE_SOURCE == "schedule"` plus a per-Op
 * selector variable, and the generated file's header says what to set up. What
 * GitLab does not lack, and what this generator wrongly refused until #2256,
 * is the other two triggers (#2084): `$CI_PIPELINE_SOURCE` distinguishes
 * `merge_request_event` from `push` on every pipeline, and `rules:` selects a
 * job on either. So:
 *
 *  - `cron` → `$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP ==
 *    "<name>"`, unchanged;
 *  - `pull_request` → `$CI_PIPELINE_SOURCE == "merge_request_event"`, with the
 *    branch filter mapped to `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, which is
 *    the branch the merge request would merge INTO — the same thing github's
 *    `on.pull_request.branches` filters on;
 *  - `push` → `$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH ==
 *    "<branch>"`, defaulting to the same `main` github's generator assumes.
 *
 * Two or more branches are two or more rule entries, because `rules:` is an
 * OR over its entries and a regex alternation would need every branch name
 * escaped into a pattern.
 *
 * Every job carries a `resource_group`, GitLab's stand-in for github's per-Op
 * `concurrency` group: one run at a time per Op, the next one queued rather
 * than cancelled. On an apply job that is also what stops two runs racing for
 * the same state lock.
 *
 * Unlike github, all of this lands in ONE file. A GitHub trigger is
 * workflow-scoped, so an Op there needs its own workflow; a GitLab trigger is
 * job-scoped, so the whole set is one document with one job apiece.
 *
 * Each job runs exactly one invocation, `chant run <name>` by default — never
 * inlined audit/reconcile logic. The finding-mode is already baked into the
 * Op's own activity args at build time by the composite that created it; this
 * generator only wires what the mode needs to act.
 *
 * `findingMode: "comment"` works here since #2256: `reconcilePr` writes a
 * merge-request note when the run is a `merge_request_event` pipeline, by the
 * same hidden-marker edit-in-place recipe it uses on a GitHub pull request.
 * What survives of the old blanket refusal is the constraint github already
 * has — the mode posts onto the merge request that triggered the run, so a
 * cron or push job carrying it is refused by name at build time rather than
 * emitted to fail at its Report step ({@link assertTriggerSupportsMode}).
 * GitLab has no per-job `permissions:` concept, so the note's write access
 * comes from a `GITLAB_TOKEN` CI/CD variable, which the header names.
 *
 * #2242's two per-Op options cross over one and a half times. A `setup` entry
 * spelled `{ uses }` is a GitHub Actions marketplace action; GitLab CI has
 * `script` and nothing else, so there is no shape to translate it into and it
 * is refused by name. A `{ run }` entry translates exactly, and is emitted
 * ahead of the `beforeScript` lines — in `script:` rather than
 * `before_script:`, which is where `./generate-pipeline.ts` puts the same
 * option's lines in this same lexicon, and which concatenates identically at
 * run time. An additive `permissions` map has exactly one entry with a GitLab
 * meaning: `id-token: write` becomes an `id_tokens:` declaration ({@link
 * gitlabIdTokens}), the OIDC surface the old refusal already named as the shape
 * to reach for. Every other scope is still refused, because there is no
 * per-job token-scope mapping to put it in and a silently dropped scope emits
 * a job that reads as granted and runs with nothing.
 *
 * A spec's `environment` (#2257) does cross, because GitLab has the concept
 * under the same key and with the same two fields: `environment: { name, url
 * }` on the job, an environment object in the project, and — on a protected
 * environment — an approval rule that holds the deployment job until an
 * approver releases it. So the reviewer gate the option exists for is
 * expressible here, unlike the `uses` setup step above, and it is emitted
 * rather than refused. What GitLab does not have is any way for this file to
 * declare the protection: an environment's approval rules are project
 * settings (Settings > CI/CD > Protected environments), exactly as GitHub's
 * required reviewers are repository settings, so the generated header names
 * the environment to protect the way it already names the schedule to create.
 * chant's own gate (#2119) runs inside the job either way.
 *
 * The gated apply (#2243) lands in the two surfaces GitLab has. `chant run`
 * returns 3 when a run stops at an unapproved gate, so a push-to-default apply
 * would paint the branch red on every merge until someone approves; the push
 * job runs with `--gated-exit 0`, mapping that one outcome and nothing else.
 * Where GitHub Actions gets the pending block on its run page through
 * `GITHUB_STEP_SUMMARY`, GitLab has no step summary at all, so the job sets
 * `CHANT_GATE_SUMMARY` to a path it also declares under `artifacts:` and the
 * block is downloadable from the pipeline. The human render is already in the
 * job log, since the invocation carries no `--json`. There is no follow-up
 * notice job: it would need a forge API call and a token this generator does
 * not require of a `report`-mode Op.
 *
 * A spec's own `variables` (#2290) is the one per-Op option that is cheap
 * here rather than merely possible: this generator already puts a job-level
 * `variables:` block on a gated job (`CHANT_GATE_SUMMARY` above), so a spec's
 * own entries merge into the same mapping instead of asking for a shape
 * GitLab has no concept of. `options.variables` (forge-wide) is unaffected —
 * it keeps landing on the file's own top-level `variables:`, read by every
 * job the way a GitLab CI/CD variable always is — and a spec's own entry wins
 * the job over a same-named top-level one, the ordinary variable-precedence
 * GitLab already gives a job over the pipeline. `CHANT_GATE_SUMMARY` itself is
 * internal and always wins at the job over a same-named spec entry, so a
 * caller cannot point the gate block somewhere the `artifacts:` declaration
 * beside it does not also point.
 */

import {
  assertGitlabEnvironment,
  CI_IMAGE,
  ciJobName,
  environmentDoc,
  fillCommand,
  gitlabIdTokens,
  gitlabRules,
  gitlabSetupScript,
  nonEmpty,
  pushBranches,
} from "@intentius/chant/ci-jobs";
import { memberGitlabChanges, memberRepoPath, memberShellDir, resolveOpTrigger } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineOptions as GenerateGitlabOpOptions,
  OpEnvironment,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGitlabOpResult,
  OpTrigger,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";

import { emitGitlabFile } from "./ci-jobs";

export type { GenerateGitlabOpOptions, GenerateGitlabOpResult };

/**
 * Default stage every generated job runs in, and the default base of the
 * generated file's name (#2293). Overridable via `options.opsStage` (and the
 * file name separately via `options.opsFileName`) — see
 * {@link GenerateGitlabOpOptions} (`ComponentPipelineOptions` in
 * `../../../../packages/core/src/lexicon.ts`).
 *
 * `"scheduled-ops"` before #2293: a constant from when this generator was
 * cron-only, left in place through #2084/#2256 even after every
 * merge-request and push job started sharing it, so a GitLab UI showed
 * `live-check`/`live-plan`/`live-apply`/`live-adopt` grouped under a stage
 * called "scheduled" and a consuming project's `include:` named a file that
 * said the opposite of what it held.
 */
const DEFAULT_STAGE = "ops";

/** The CI/CD variable a Pipeline Schedule sets to select which job it runs. */
const SELECTOR_VAR = "CHANT_SCHEDULED_OP";

/**
 * `chant run` returns 3 when a run stops at an unapproved gate; `--gated-exit
 * 0` maps that one outcome to success (#2243). `push` only — a cron watch or
 * a merge-request plan that stops at a gate is a signal, not noise on a merge.
 */
const GATED_EXIT_FLAG = ["--gated-exit", "0"];

/** The variable core's `writeGatedRunSummary` writes the pending-gate block to when the forge sets no step summary (#2256). */
const GATE_SUMMARY_VAR = "CHANT_GATE_SUMMARY";

/** How long a pending-gate artifact is worth keeping: long enough to outlive the approval it is waiting for. */
const GATE_ARTIFACT_EXPIRY = "30 days";

/** Refuse a blank `opsStage` (#2293): every job's `stage:` and the top-level `stages:` entry would otherwise be an empty string. */
function assertOpsStage(stage: string): void {
  if (stage.trim() === "") {
    throw new Error(
      `The gitlab Op generator's \`opsStage\` option is empty. Name the stage every generated job shares, ` +
        `or drop the option to keep the default "${DEFAULT_STAGE}".`,
    );
  }
}

/** Refuse a blank `opsFileName` (#2293): `main.ts` in a consuming project writes `result.files[].name` straight to disk. */
function assertOpsFileName(fileName: string): void {
  if (fileName.trim() === "") {
    throw new Error(
      `The gitlab Op generator's \`opsFileName\` option is empty. Name the generated file, or drop the ` +
        `option to derive it from \`opsStage\`.`,
    );
  }
}

/**
 * Refuse `findingMode: "comment"` on a trigger that has no merge request
 * (#2231, #2256). The mode's activity reads the merge request out of the
 * pipeline's own variables at run time, so a cron- or push-triggered job
 * carrying it would generate fine and then fail on every run. Refusing here
 * names the Op, the mode and the trigger at build time instead — the same
 * refusal github's generator makes, on the same terms.
 */
function assertTriggerSupportsMode(name: string, mode: OpFindingMode, trigger: OpTrigger): void {
  if (mode !== "comment" || trigger.kind === "pull_request") return;
  throw new Error(
    `Scheduled Op "${name}" has findingMode "comment", which posts its finding as a note on the merge ` +
      `request that triggered the run, but its trigger is "${trigger.kind}". A ${trigger.kind} pipeline has ` +
      `no merge request to post on. Give it a { kind: "pull_request" } trigger, or use findingMode "issue" ` +
      `or "merge-request".`,
  );
}

/**
 * The follow-up line an Op with an `environment` adds under its own header
 * line (#2257). The `environment:` key on the job binds it to the
 * environment; it cannot declare the approval rule, which is a project
 * setting, so the header says where that is set the same way it says where a
 * schedule is created.
 */
function environmentLine(environment: OpEnvironment): string {
  return (
    `#     deploys to environment "${environment.name}" — protect it under Settings > CI/CD >` +
    " Protected environments to require an approval before the job runs"
  );
}

/** The artifact path a push job's pending-gate block is written to (#2243, #2256). */
function gateSummaryPath(jobName: string): string {
  return `chant-gate-${jobName}.md`;
}

/** One line per Op in the generated file's header comment, naming what fires it. */
function headerLineFor(
  spec: ScheduledOpSpec,
  trigger: OpTrigger,
  jobName: string,
  mode: OpFindingMode,
): string {
  const tokenNote =
    mode === "report" ? "" : " — needs a GITLAB_TOKEN CI/CD variable (masked, scope: api)";
  switch (trigger.kind) {
    case "cron":
      return `#   ${jobName}: cron "${trigger.schedule}", ${SELECTOR_VAR}="${spec.name}", finding-mode ${mode}${tokenNote}`;
    case "pull_request": {
      const onto = trigger.branches?.length ? trigger.branches.join(", ") : "any branch";
      return `#   ${jobName}: merge_request_event onto ${onto}, finding-mode ${mode}${tokenNote}`;
    }
    case "push": {
      const branches = pushBranches(trigger.branches);
      return (
        `#   ${jobName}: push to ${branches.join(", ")}, finding-mode ${mode}${tokenNote}` +
        ` — a gated apply stays green, its pending gate in the log and in ${gateSummaryPath(jobName)}`
      );
    }
  }
}

/**
 * Synthesize one `.gitlab-ci.yml` job per Op, all in a single file (a GitLab
 * trigger is job-scoped — see the module doc). Wired into core's Op generate
 * mode via the gitlab lexicon plugin's `generateOpPipeline` (../plugin.ts).
 */
export function generateGitlabOpPipeline(
  ops: ScheduledOpSpec[],
  options: GenerateGitlabOpOptions = {},
): GenerateGitlabOpResult {
  const image = options.image ?? CI_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];
  const stage = options.opsStage ?? DEFAULT_STAGE;
  assertOpsStage(stage);
  const baseFileName = options.opsFileName ?? `${stage}.gitlab-ci.yml`;
  assertOpsFileName(baseFileName);
  // A workspace member's file, jobs and resource groups carry its name
  // (#2542): the root .gitlab-ci.yml includes every member's file, and job
  // names share one namespace across them.
  const member = options.member;
  const fileName = member ? `${member.name}-${baseFileName}` : baseFileName;
  const jobPrefix = member ? `${member.name}-` : "";
  const changes = member ? memberGitlabChanges(member, member.fileDir ? `${member.fileDir}/${fileName}` : undefined) : undefined;
  const cdLine = member && member.dir !== "." && member.dir !== "" ? [`cd ${memberShellDir(member)}`] : [];

  const jobs: OpPipelineJob[] = [];
  const doc: Record<string, unknown> = { stages: [stage], ...nonEmpty("variables", options.variables) };

  const opLines: string[] = [];
  let anyCron = false;

  for (const spec of ops) {
    const subject = `Scheduled Op "${spec.name}"`;
    const setupScript = gitlabSetupScript(subject, spec.setup);
    const idTokens = gitlabIdTokens(spec.name, spec.permissions);
    const findingMode = spec.findingMode ?? "report";
    const trigger = resolveOpTrigger(spec);
    assertTriggerSupportsMode(spec.name, findingMode, trigger);
    if (trigger.kind === "cron") anyCron = true;

    const jobName = jobPrefix + ciJobName(spec.name);
    jobs.push({ jobName, op: spec.name, trigger, findingMode });
    opLines.push(headerLineFor(spec, trigger, jobName, findingMode));
    if (spec.environment) {
      assertGitlabEnvironment(spec.name, spec.environment);
      opLines.push(environmentLine(spec.environment));
    }

    // A push job is the one a gate would otherwise paint red on every merge
    // (#2243). Every other trigger keeps the plain one-line invocation.
    const rules = gitlabRules(subject, trigger, { variable: SELECTOR_VAR, value: spec.name });
    const gated = trigger.kind === "push";
    const runParts = fillCommand(runCommand, spec.name);
    const invocation = gated ? [...runParts, ...GATED_EXIT_FLAG] : runParts;
    const gateSummary = gateSummaryPath(jobName);

    // Per-Op credentials (#2290): a spec's own `variables` merge into this
    // job's `variables:` block, the same block the gated apply's
    // `CHANT_GATE_SUMMARY` already occupies below — GATE_SUMMARY_VAR is
    // internal and listed last, so it always wins a name collision rather
    // than a caller being able to repoint the gate block's own artifact path.
    const jobVariables: Record<string, string> = {
      ...(spec.variables ?? {}),
      ...(gated ? { [GATE_SUMMARY_VAR]: gateSummary } : {}),
    };

    doc[jobName] = {
      stage,
      image,
      // GitLab's stand-in for github's per-Op concurrency group: queue the
      // next run rather than cancel the current one.
      resource_group: jobName,
      ...(idTokens ? { id_tokens: idTokens } : {}),
      ...(spec.environment ? { environment: environmentDoc(spec.environment) } : {}),
      ...nonEmpty("variables", jobVariables),
      rules: changes && trigger.kind !== "cron" ? rules.map((r) => ({ ...r, changes })) : rules,
      script: [...cdLine, ...setupScript, ...beforeScript, invocation.join(" "), ...extraScript],
      // `when: always` because the run this publishes for is the green one: a
      // gated apply succeeds, and the block is the only thing that says a
      // human still has to act. A run that walked through its gate writes no
      // block, and GitLab reports the empty upload as a warning, not a failure.
      ...(gated
        ? { artifacts: { when: "always", paths: [member ? memberRepoPath(member, gateSummary) : gateSummary], expire_in: GATE_ARTIFACT_EXPIRY } }
        : {}),
    };
  }

  const headerLines = [
    `# chant Ops — one job per Op under stage "${stage}", each`,
    "# selected by its own rules:. A merge_request_event or push job needs no",
    "# setup; its rule fires on the event itself.",
  ];
  if (anyCron) {
    headerLines.push(
      "#",
      "# GitLab has no in-file cron. Create one Pipeline Schedule per cron Op",
      "# below (Settings > CI/CD > Schedules): set its cron to the value noted",
      `# here and its ${SELECTOR_VAR} CI/CD variable to the Op's name, so only`,
      "# that job runs on that schedule.",
    );
  }
  headerLines.push("#", ...opLines);

  const yaml = emitGitlabFile(
    [["stages", doc.stages], ...(doc.variables ? [["variables", doc.variables] as const] : []), ...jobs.map(({ jobName }) => [jobName, doc[jobName]] as const)],
    headerLines,
  );

  return { files: [{ name: fileName, yaml }], jobs };
}
