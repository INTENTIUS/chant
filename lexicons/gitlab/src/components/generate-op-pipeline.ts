/**
 * Generate mode — scheduled Op → GitLab CI YAML (#927).
 *
 * The Op counterpart to `./generate-pipeline.ts` (#563): that module
 * synthesizes a deploy-time component graph as one `.gitlab-ci.yml`; this one
 * synthesizes a cron-triggered job per stateless Op. An Op's cadence is an
 * `OpSchedule` on the Op itself (`packages/core/src/op/types.ts`),
 * runtime-neutral data each reader interprets; this module is the reader that
 * turns it into a GitLab pipeline schedule (`WorkflowAuditOp`/
 * `PipelineAuditOp`/`ReconcileOp` all accept an optional `schedule` precisely
 * for this).
 *
 * Unlike GitHub Actions' per-workflow `on.schedule`, GitLab has no in-file
 * cron at all — a schedule is a project-level object (Settings → CI/CD →
 * Schedules) that runs the project's *existing* `.gitlab-ci.yml` with a
 * chosen cron and CI/CD variables. So every scheduled Op here becomes one
 * job in a single generated file, gated to run only under its own Pipeline
 * Schedule (`$CI_PIPELINE_SOURCE == "schedule"` plus a per-op selector
 * variable) — the cron itself is configured on the Pipeline Schedule, not in
 * this YAML, and the generated file's header comment states what to set up.
 * Each job runs exactly one invocation, `chant run <name>` by default — never
 * inlined audit/reconcile logic. The finding-mode itself is already baked
 * into the Op's own activity args at build time by the composite that
 * created it; GitLab has no per-job `permissions:` concept (unlike GitHub
 * Actions), and `findingMode: "comment"` is refused by name here because it
 * posts onto a GitHub pull-request event GitLab does not have (#2231), so a
 * non-`report` mode's write access comes from whatever
 * `GITLAB_TOKEN`/CI-CD-variable configuration the project already has —
 * this generator documents the requirement rather than fabricating a
 * variable nothing reads.
 *
 * Neither of #2242's two per-Op options survives the crossing, and both are
 * refused by name rather than dropped. A `setup` entry spelled `{ uses }` is
 * a GitHub Actions marketplace action; GitLab CI has `script` and nothing
 * else, so there is no shape to translate it into and no way to approximate
 * `aws-actions/configure-aws-credentials` in a shell line. A `{ run }` entry
 * translates exactly, and is emitted ahead of the `beforeScript` lines, the
 * same position the github generator gives it. An additive `permissions` map
 * is refused for the same reason `permissions:` is absent here at all: GitLab
 * has no per-job token-scope mapping, and its OIDC surface is a different
 * declaration (`id_tokens:` with an `aud`, exchanged for cloud credentials by
 * the job itself) that chant does not generate. Ignoring the map would emit a
 * job that reads as having OIDC and runs with no credentials.
 *
 * The gated-apply mapping (#2243) has nothing to attach to here. It exists
 * because a push-to-main apply that stops at its gate exits 3 and paints the
 * branch red on every merge; this generator has no push pipeline at all,
 * refusing a `push` trigger by name (#2084) because a GitLab schedule is a
 * project-level cron object rather than an event. GitLab does have its own
 * equivalent of the mapping should one ever be wanted — `allow_failure:
 * { exit_codes: [3] }` turns one exit code into a warning rather than a
 * failure, without a flag on the invocation — so the day this generator
 * grows a push trigger, that is the shape to reach for rather than
 * `--gated-exit`.
 */

import { emitYAML } from "@intentius/chant/yaml";
import { resolveOpTrigger } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineOptions as GenerateGitlabOpOptions,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGitlabOpResult,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";

/**
 * Refuse the two #2242 options GitLab cannot honour, by name and before any
 * YAML exists, and return the `run` setup lines that do translate. See the
 * module doc for why each one is a refusal rather than a silent drop.
 */
function gitlabSetupScript(spec: ScheduledOpSpec): string[] {
  if (spec.permissions && Object.keys(spec.permissions).length > 0) {
    const scopes = Object.entries(spec.permissions)
      .map(([scope, value]) => `${scope}: ${value}`)
      .join(", ");
    throw new Error(
      `Scheduled Op "${spec.name}" adds permissions { ${scopes} }, but GitLab CI has no per-job token-scope ` +
        `mapping — there is no \`permissions:\` key to add them to (#2242). Its OIDC surface is a separate ` +
        `\`id_tokens:\` declaration the job exchanges for cloud credentials itself, which chant does not ` +
        `generate. Drop the option here, or generate this Op for github.`,
    );
  }
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

export type { GenerateGitlabOpOptions, GenerateGitlabOpResult };

/** GitLab CI job names must be safe YAML keys; Op names are already kebab-case in every fixture, but normalize defensively (mirrors `./generate-pipeline.ts`'s `toJobName`). */
function toJobName(opName: string): string {
  return opName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const DEFAULT_IMAGE = "node:22-slim";
const STAGE = "scheduled-ops";

/** The CI/CD variable a Pipeline Schedule sets to select which job it runs. */
const SELECTOR_VAR = "CHANT_SCHEDULED_OP";

/** One setup line per Op in the generated file's header comment. */
function setupLine(spec: ScheduledOpSpec, cron: string, jobName: string, mode: OpFindingMode): string {
  const tokenNote = mode === "report" ? "" : " — needs a GITLAB_TOKEN CI/CD variable (masked, scope: api)";
  return `#   ${jobName}: cron "${cron}", ${SELECTOR_VAR}="${spec.name}", finding-mode ${mode}${tokenNote}`;
}

/**
 * Synthesize one `.gitlab-ci.yml` job per scheduled Op, all in a single file
 * (GitLab has no per-file cron — see the module doc). Wired into core's Op
 * generate mode via the gitlab lexicon plugin's `generateOpPipeline`
 * (../plugin.ts).
 */
export function generateGitlabOpPipeline(
  ops: ScheduledOpSpec[],
  options: GenerateGitlabOpOptions = {},
): GenerateGitlabOpResult {
  const image = options.image ?? DEFAULT_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const jobs: OpPipelineJob[] = [];
  const doc: Record<string, unknown> = { stages: [STAGE] };
  if (options.variables && Object.keys(options.variables).length > 0) doc.variables = options.variables;

  const headerLines = [
    "# Scheduled Ops (chant #927) — GitLab has no in-file cron. Create one",
    "# Pipeline Schedule per Op below (Settings > CI/CD > Schedules): set its",
    `# cron to the value noted here and its ${SELECTOR_VAR} CI/CD variable to`,
    "# the Op's name, so only that job runs on that schedule.",
    "#",
  ];

  for (const spec of ops) {
    const setupScript = gitlabSetupScript(spec);
    const findingMode = spec.findingMode ?? "report";
    if (findingMode === "comment") {
      // The mode posts onto the pull request that triggered the run (#2231),
      // read out of the GitHub Actions event payload by `reconcilePr`. GitLab
      // has neither that event model nor that payload, and core carries no
      // GitLab API client that would post the merge-request note instead, so
      // this refuses the mode by name rather than emitting a job whose finding
      // step fails on every pipeline.
      throw new Error(
        `Scheduled Op "${spec.name}" has findingMode "comment", which posts its finding on the pull request ` +
          `that triggered the run. GitLab has no pull_request event and chant has no GitLab merge-request ` +
          `note activity (#2231). Use findingMode "issue" or "merge-request" here, or generate this Op for ` +
          `github.`,
      );
    }
    const trigger = resolveOpTrigger(spec);
    if (trigger.kind !== "cron") {
      throw new Error(
        `Scheduled Op "${spec.name}" has a "${trigger.kind}" trigger, but GitLab has no pull_request/push event model ` +
          `(#2084) — only a project-level Pipeline Schedule (cron). Give it a cron trigger, or generate it for github/forgejo instead.`,
      );
    }
    const jobName = toJobName(spec.name);
    jobs.push({ jobName, op: spec.name, trigger, findingMode });
    headerLines.push(setupLine(spec, trigger.schedule, jobName, findingMode));

    const runParts = runCommand.map((part) => part.replace("{name}", spec.name));
    const script = [...setupScript, ...beforeScript, runParts.join(" "), ...extraScript];

    doc[jobName] = {
      stage: STAGE,
      image,
      rules: [{ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SELECTOR_VAR} == "${spec.name}"` }],
      script,
    };
  }

  const sections: string[] = [];
  sections.push("stages:" + emitYAML(doc.stages, 1));
  if (doc.variables) sections.push("variables:" + emitYAML(doc.variables, 1));
  for (const { jobName } of jobs) {
    sections.push(`${jobName}:` + emitYAML(doc[jobName], 1));
  }

  const yaml = headerLines.join("\n") + "\n\n" + sections.join("\n\n") + "\n";

  return { files: [{ name: "scheduled-ops.gitlab-ci.yml", yaml }], jobs };
}
