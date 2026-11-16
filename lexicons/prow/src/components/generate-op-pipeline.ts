/**
 * Op generate mode for Prow (#5189): scheduled Ops as Prow jobs.
 *
 * The github lexicon writes one workflow per Op (`generateGithubOpPipeline`).
 * Prow loads one job config with every job, so this writes one file holding
 * one job per Op, of the kind its trigger matches:
 *
 * - `cron` is a periodic with that cron, which checks the repository's
 *   branch out through `extra_refs`;
 * - `push` is a postsubmit on the trigger's branches;
 * - `pull_request` is a presubmit. It runs the pull request's code, so it
 *   holds no credential: its finding mode is `report` and it takes none of
 *   the Op's variables.
 *
 * The periodics and postsubmits run on the trusted build cluster. They read
 * the GitHub token from a Secret, as a GitHub Op job reads the job token.
 * Some of what a GitHub Op job adds around its run has no Prow form here,
 * such as an agent, a cloud trade or a `uses:` setup step. Each is refused
 * by name.
 */

import { CI_IMAGE, ciJobName, fillCommand, triggerBranches } from "@intentius/chant/ci-jobs";
import { resolveOpTrigger, scheduledOpArtifacts } from "@intentius/chant/lexicon";
import type { ComponentPipelineOptions, OpPipelineJob, OpPipelineResult, ScheduledOpSpec } from "@intentius/chant/lexicon";
import { forgeJobConfig } from "../forge-jobs";
import { prowJobName, renderProwJob, resolveProwSettings, shQuote, type ProwJobSpec, type ProwRenderContext } from "./prow-jobs";

/** The file the Op jobs are written to: `chant-ops.yaml`, or `chant-<member>-ops.yaml` for a workspace member. */
export function prowOpsFileName(member?: string): string {
  return `${prowJobName("chant", member, "ops")}.yaml`;
}

const NO_PROW_FORM: Array<[keyof ScheduledOpSpec, string]> = [
  ["agent", "an agent job"],
  ["commit", "a commit job"],
  ["reviewAgent", "a review split"],
  ["update", "an update on drift"],
  ["cloud", "a cloud trade, which takes the job's OIDC token, and a Prow job has none"],
  ["environment", "a GitHub environment"],
  ["permissions", "GitHub token permissions"],
  ["runner", "a GitHub runner"],
];

/** A run setup step as a line: with its own variables, in a subshell, as a GitHub step's `env:` reaches that step alone. */
function setupLine(step: NonNullable<ScheduledOpSpec["setup"]>[number]): string {
  const run = (step as { run: string }).run;
  const env = Object.entries(step.env ?? {});
  for (const [k, v] of env) if (v.includes("${{")) throw new Error(`a setup step's ${k} reads ${v}, which has no Prow form; a Prow job reads a Secret through its pod spec`);
  return env.length === 0 ? run : `(\n${env.map(([k, v]) => `export ${k}=${shQuote(v)}`).join("\n")}\n${run}\n)`;
}

/** Refuse what a scheduled Op asks for that has no Prow form. */
function assertProwOp(spec: ScheduledOpSpec): void {
  for (const [key, what] of NO_PROW_FORM) {
    const v = spec[key];
    if (v === undefined || v === false || (typeof v === "object" && v !== null && Object.keys(v).length === 0)) continue;
    throw new Error(`Scheduled Op "${spec.name}" sets ${key}, ${what}, which --generate prow writes no job for; drop it, or generate it for GitHub Actions`);
  }
  for (const step of spec.setup ?? []) {
    if ("uses" in step) throw new Error(`Scheduled Op "${spec.name}" has the setup step ${step.uses}, a GitHub action; a Prow job runs shell lines, so give it a run step`);
  }
}

/**
 * One Prow job per scheduled Op, in one job config. Throws for an Op with
 * no trigger and for one whose job has no Prow form.
 */
export function generateProwOpPipeline(ops: ScheduledOpSpec[], options: ComponentPipelineOptions = {}): OpPipelineResult {
  const repo = options.forgeRepo;
  if (!repo) throw new Error("--generate prow keys the jobs by the GitHub repository's owner/name; set forgeRepo in the spec's options, or run it in a checkout whose origin remote is on GitHub");
  const settings = resolveProwSettings(options.prow);
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const member = options.member;
  const ctx: ProwRenderContext = {
    settings,
    repo,
    branch: "main",
    image: options.image ?? CI_IMAGE,
    variables: { ...options.variables },
    before: options.beforeScript ?? [],
    after: options.extraScript ?? [],
    ...(member && member.dir !== "." && member.dir !== "" ? { dir: member.dir } : {}),
  };
  const presubmits: Array<Record<string, unknown>> = [];
  const postsubmits: Array<Record<string, unknown>> = [];
  const periodics: Array<Record<string, unknown>> = [];
  const jobs: OpPipelineJob[] = [];
  for (const spec of ops) {
    assertProwOp(spec);
    const trigger = resolveOpTrigger(spec);
    const findingMode = spec.findingMode ?? "report";
    if (findingMode === "comment") throw new Error(`Scheduled Op "${spec.name}" has findingMode "comment", which posts on the pull request with the token, and on Prow a pull request's job is a presubmit, which holds no credential; use findingMode "report" or "issue" on a cron or push trigger`);
    if (trigger.kind === "pull_request" && findingMode !== "report") throw new Error(`Scheduled Op "${spec.name}" has findingMode "${findingMode}" on a pull_request trigger, and on Prow that job is a presubmit, which runs the pull request's code and holds no token; use findingMode "report"`);
    if (trigger.kind === "pull_request" && Object.keys(spec.variables ?? {}).length > 0) throw new Error(`Scheduled Op "${spec.name}" sets variables on a pull_request trigger, and on Prow that job is a presubmit, which runs the pull request's code; keep them on a cron or push Op`);
    const name = prowJobName("chant", member?.name, "op", ciJobName(spec.name));
    jobs.push({ jobName: name, op: spec.name, trigger, findingMode });
    const token: Record<string, string> = trigger.kind === "pull_request" ? {} : findingMode === "report" ? { GITHUB_TOKEN: "${{ github.token }}" } : { GITHUB_TOKEN: "${{ github.token }}", GH_TOKEN: "${{ github.token }}" };
    const artifacts = scheduledOpArtifacts(spec);
    const job: ProwJobSpec = {
      kind: trigger.kind === "cron" ? "periodic" : trigger.kind === "push" ? "postsubmit" : "presubmit",
      name,
      description: `chant: runs the Op ${spec.name}${trigger.kind === "cron" ? ` on ${trigger.schedule}` : trigger.kind === "push" ? " on each merge" : " on each pull request, with no credential"}.`,
      lines: [...(spec.setup ?? []).map(setupLine), fillCommand(runCommand, spec.name).join(" ")],
      env: { ...spec.variables, ...token },
      ...(artifacts.length > 0 ? { keep: artifacts.flatMap((a) => a.paths) } : {}),
      ...(trigger.kind === "cron" ? { cron: trigger.schedule } : {}),
      ...(trigger.kind !== "cron" ? { branches: triggerBranches(trigger) ?? [] } : {}),
      serial: trigger.kind !== "pull_request",
    };
    const rendered = renderProwJob(job, ctx);
    (job.kind === "presubmit" ? presubmits : job.kind === "postsubmit" ? postsubmits : periodics).push(rendered);
  }
  const header = [
    `Written by chant run --generate prow for ${repo}.`,
    "Add this file to your Prow installation's job config (its job_config_path).",
    `Presubmits run on ${settings.untrustedCluster} and hold no credential. Postsubmits and periodics run on ${settings.trustedCluster} and read the GitHub token from the Secret ${settings.tokenSecret.name}.`,
  ].join("\n");
  const yaml = forgeJobConfig({ forge: "github", repo }, { presubmits, postsubmits, periodics }, { header });
  return { files: [{ name: prowOpsFileName(member?.name), yaml }], jobs };
}
