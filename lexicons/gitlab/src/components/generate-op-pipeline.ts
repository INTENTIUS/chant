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
 * idTokensFor}), the OIDC surface the old refusal already named as the shape
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
 */

import { emitYAML } from "@intentius/chant/yaml";
import { resolveOpTrigger } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineOptions as GenerateGitlabOpOptions,
  OpEnvironment,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGitlabOpResult,
  OpTrigger,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";

export type { GenerateGitlabOpOptions, GenerateGitlabOpResult };

/** GitLab CI job names must be safe YAML keys; Op names are already kebab-case in every fixture, but normalize defensively (mirrors `./generate-pipeline.ts`'s `toJobName`). */
function toJobName(opName: string): string {
  return opName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const DEFAULT_IMAGE = "node:22-slim";

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
 * Default branch assumed for a `push` trigger with no `branches` override.
 * The same value github's generator documents, for the same reason: this
 * operates on a `ScheduledOpSpec` rather than a git checkout, so it cannot
 * read a downstream project's actual default branch. Set `trigger.branches`
 * explicitly on a project whose default branch is something else.
 */
const DEFAULT_PUSH_BRANCH = "main";

/** The pipeline source GitLab reports for a merge-request pipeline. */
const MERGE_REQUEST_SOURCE = '$CI_PIPELINE_SOURCE == "merge_request_event"';

/**
 * The `id_tokens:` entry an `id-token: write` spec gets. The name is the
 * environment variable the JWT lands in, which the job's own setup line reads
 * (`aws sts assume-role-with-web-identity --web-identity-token
 * "$CHANT_ID_TOKEN"`, or the provider's equivalent).
 *
 * `$CI_SERVER_URL` as the audience is GitLab's own documented default: an
 * identity provider federated to a GitLab instance is registered with that
 * instance's URL as its audience, and the variable expands to exactly that on
 * gitlab.com and on a self-managed instance alike. A project whose provider
 * was registered with some other audience edits the generated declaration.
 */
const ID_TOKEN_NAME = "CHANT_ID_TOKEN";
const ID_TOKEN_AUDIENCE = "$CI_SERVER_URL";

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

/**
 * Refuse a branch name that cannot be interpolated into a `rules:`
 * if-expression. The expression is a string GitLab parses, so a `"` would end
 * it early and a `$` would expand as a variable — either one silently changes
 * which pipelines match the job, which is worse than not generating it.
 */
function assertBranchName(specName: string, branch: string): void {
  if (branch.trim() === "") {
    throw new Error(
      `Scheduled Op "${specName}" has an empty branch filter. Name a branch, or drop the filter.`,
    );
  }
  if (/["$\\]/.test(branch)) {
    throw new Error(
      `Scheduled Op "${specName}" filters on branch "${branch}", which carries a character this generator ` +
        `cannot put in a GitLab \`rules:\` expression: a quote would end the expression early and a "$" ` +
        `would expand as a CI/CD variable, either of which silently changes which pipelines run the job. ` +
        `Name a branch without \`"\`, \`$\` or \`\\\`.`,
    );
  }
}

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
 * This trigger's `rules:` entries. Two or more branches are two or more
 * entries: `rules:` is an OR over its list, which is how GitLab spells the
 * alternation github expresses as a `branches:` array.
 */
function rulesFor(spec: ScheduledOpSpec, trigger: OpTrigger): Array<{ if: string }> {
  switch (trigger.kind) {
    case "cron":
      return [{ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SELECTOR_VAR} == "${spec.name}"` }];
    case "pull_request": {
      const branches = trigger.branches ?? [];
      if (branches.length === 0) return [{ if: MERGE_REQUEST_SOURCE }];
      return branches.map((branch) => {
        assertBranchName(spec.name, branch);
        return { if: `${MERGE_REQUEST_SOURCE} && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "${branch}"` };
      });
    }
    case "push": {
      const branches = trigger.branches?.length ? trigger.branches : [DEFAULT_PUSH_BRANCH];
      return branches.map((branch) => {
        assertBranchName(spec.name, branch);
        return { if: `$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "${branch}"` };
      });
    }
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
 * Turn a spec's additive `permissions` (#2242) into the one GitLab
 * declaration that carries the same meaning, refusing everything else by name.
 *
 * `id-token: write` is that one: GitLab's OIDC surface is `id_tokens:`, a
 * per-job declaration of a JWT the job exchanges for cloud credentials
 * itself. `id-token: read` is refused rather than mapped, because GitLab
 * either mints the token into the job or does not — there is no read-only
 * half of it, and emitting the declaration for a spec that asked for read
 * would hand the job more than it asked for.
 *
 * Every other scope is refused, unchanged from the pre-#2256 behaviour:
 * GitLab has no per-job token-scope mapping at all, and a scope quietly
 * dropped would emit a job that reads as granted and runs with nothing.
 */
function idTokensFor(spec: ScheduledOpSpec): Record<string, unknown> | undefined {
  let wantsIdToken = false;
  for (const [rawScope, value] of Object.entries(spec.permissions ?? {})) {
    const scope = rawScope.trim();
    if (scope === "id-token") {
      if (value !== "write") {
        throw new Error(
          `Scheduled Op "${spec.name}" adds permission "id-token: ${value}", but GitLab either mints an ` +
            `OIDC token into a job or does not — there is no read-only half of an \`id_tokens:\` ` +
            `declaration. Ask for { "id-token": "write" }, or drop the option.`,
        );
      }
      wantsIdToken = true;
      continue;
    }
    throw new Error(
      `Scheduled Op "${spec.name}" adds permission "${scope}: ${value}", but GitLab CI has no per-job ` +
        `token-scope mapping — there is no \`permissions:\` key to add it to (#2242). The one scope that ` +
        `does cross over is "id-token": "write", which becomes an \`id_tokens:\` declaration. Drop the ` +
        `option here, or generate this Op for github.`,
    );
  }
  return wantsIdToken ? { [ID_TOKEN_NAME]: { aud: ID_TOKEN_AUDIENCE } } : undefined;
}

/**
 * Refuse a `uses` setup step by name and return the `run` lines that do
 * translate. See the module doc for why a marketplace action is a refusal
 * rather than a silent drop.
 */
function gitlabSetupScript(spec: ScheduledOpSpec): string[] {
  const lines: string[] = [];
  (spec.setup ?? []).forEach((step, index) => {
    if ("uses" in step) {
      throw new Error(
        `Scheduled Op "${spec.name}" setup step ${index + 1} is \`uses: "${step.uses}"\`, a GitHub Actions ` +
          `marketplace action. GitLab CI jobs run \`script\` lines only, so there is nothing to translate it ` +
          `into (#2242). Express the setup as a \`{ run }\` entry, or generate this Op for github/forgejo.`,
      );
    }
    lines.push(step.run);
  });
  return lines;
}

/**
 * Validate a spec's `environment` (#2257) on GitLab's own terms. A GitLab job
 * naming an environment that does not exist creates an unprotected one on
 * first deploy rather than failing, so — as on github — the only shapes worth
 * refusing at build time are the ones that could never bind: a blank name,
 * and a `url` that is neither absolute nor a variable expression GitLab
 * expands, which would render as a dead "View deployment" link.
 */
function assertGitlabEnvironment(name: string, environment: OpEnvironment): void {
  const where = `Scheduled Op "${name}" environment`;
  if (environment.name.trim() === "") {
    throw new Error(
      `${where} has an empty \`name\`. A GitLab environment is a project object, and its approval ` +
        `rules live on that object rather than in this file, so a blank name resolves to nothing. ` +
        `Give it the environment's name, or drop the option.`,
    );
  }
  if (environment.url === undefined) return;
  const url = environment.url.trim();
  if (url === "") {
    throw new Error(
      `${where} "${environment.name}" has an empty \`url\`. Omit the field rather than setting it to "".`,
    );
  }
  if (!/^https?:\/\//.test(url) && !url.includes("$")) {
    throw new Error(
      `${where} "${environment.name}" has \`url: "${environment.url}"\`, which is neither an absolute ` +
        `http(s) URL nor a variable expression GitLab expands. It becomes the environment's own link, ` +
        `so a relative path is a dead link on the environment page rather than an error anywhere.`,
    );
  }
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
      const branches = trigger.branches?.length ? trigger.branches : [DEFAULT_PUSH_BRANCH];
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
  const image = options.image ?? DEFAULT_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];
  const stage = options.opsStage ?? DEFAULT_STAGE;
  assertOpsStage(stage);
  const fileName = options.opsFileName ?? `${stage}.gitlab-ci.yml`;
  assertOpsFileName(fileName);

  const jobs: OpPipelineJob[] = [];
  const doc: Record<string, unknown> = { stages: [stage] };
  if (options.variables && Object.keys(options.variables).length > 0) doc.variables = options.variables;

  const opLines: string[] = [];
  let anyCron = false;

  for (const spec of ops) {
    const setupScript = gitlabSetupScript(spec);
    const idTokens = idTokensFor(spec);
    const findingMode = spec.findingMode ?? "report";
    const trigger = resolveOpTrigger(spec);
    assertTriggerSupportsMode(spec.name, findingMode, trigger);
    if (trigger.kind === "cron") anyCron = true;

    const jobName = toJobName(spec.name);
    jobs.push({ jobName, op: spec.name, trigger, findingMode });
    opLines.push(headerLineFor(spec, trigger, jobName, findingMode));
    if (spec.environment) {
      assertGitlabEnvironment(spec.name, spec.environment);
      opLines.push(environmentLine(spec.environment));
    }

    // A push job is the one a gate would otherwise paint red on every merge
    // (#2243). Every other trigger keeps the plain one-line invocation.
    const gated = trigger.kind === "push";
    const runParts = runCommand.map((part) => part.replace("{name}", spec.name));
    const invocation = gated ? [...runParts, ...GATED_EXIT_FLAG] : runParts;
    const gateSummary = gateSummaryPath(jobName);

    doc[jobName] = {
      stage,
      image,
      // GitLab's stand-in for github's per-Op concurrency group: queue the
      // next run rather than cancel the current one.
      resource_group: jobName,
      ...(idTokens ? { id_tokens: idTokens } : {}),
      ...(spec.environment
        ? {
            environment: {
              name: spec.environment.name,
              ...(spec.environment.url === undefined ? {} : { url: spec.environment.url }),
            },
          }
        : {}),
      ...(gated ? { variables: { [GATE_SUMMARY_VAR]: gateSummary } } : {}),
      rules: rulesFor(spec, trigger),
      script: [...setupScript, ...beforeScript, invocation.join(" "), ...extraScript],
      // `when: always` because the run this publishes for is the green one: a
      // gated apply succeeds, and the block is the only thing that says a
      // human still has to act. A run that walked through its gate writes no
      // block, and GitLab reports the empty upload as a warning, not a failure.
      ...(gated
        ? { artifacts: { when: "always", paths: [gateSummary], expire_in: GATE_ARTIFACT_EXPIRY } }
        : {}),
    };
  }

  const headerLines = [
    `# chant Ops (#927, #2084, #2293) — one job per Op under stage "${stage}", each`,
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

  const sections: string[] = [];
  sections.push("stages:" + emitYAML(doc.stages, 1));
  if (doc.variables) sections.push("variables:" + emitYAML(doc.variables, 1));
  for (const { jobName } of jobs) {
    sections.push(`${jobName}:` + emitYAML(doc[jobName], 1));
  }

  const yaml = headerLines.join("\n") + "\n\n" + sections.join("\n\n") + "\n";

  return { files: [{ name: fileName, yaml }], jobs };
}
