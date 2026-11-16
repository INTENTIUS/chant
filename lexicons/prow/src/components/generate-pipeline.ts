/**
 * Generate mode for Prow (#5189): the jobs chant generates for a component
 * project, as the Prow job config of one GitHub repository.
 *
 * The github lexicon's generator (`generateGithubPipeline`) writes these
 * jobs as GitHub Actions jobs. This one writes the same commands, from the
 * same core helpers, as Prow jobs of the matching kind:
 *
 * - The deploy pipeline, one job per component in wave order and a promote
 *   job after them, is one postsubmit. Prow has no `needs:` between jobs,
 *   so the postsubmit runs the components one after another in the order
 *   `resolveComponentGraph` gives, each seeding from the outputs its
 *   dependencies dumped, and then the promote with each digest its run
 *   recorded.
 * - The gated-wave pipeline is one postsubmit that runs the waves in
 *   order. A wave held at its gate stops the job; rerun it from Deck once
 *   the wave is approved.
 * - The pull request loop's plan is a presubmit with no credential: no
 *   forge token, no runner key, no Secret and no service account, on the
 *   untrusted build cluster. Its note and status go into its report, which
 *   the job keeps in its artifacts. Prow reports the job's result on the
 *   pull request. The check job is a presubmit of the same kind.
 * - The record and the apply on merge are postsubmits on the trusted
 *   cluster, which read the GitHub token from a Secret and take their cloud
 *   identity from a service account. A gate per wave runs the waves in
 *   order in the apply postsubmit. The stale-notes job is a postsubmit too.
 *
 * A job that holds a credential is never a presubmit, which runs a pull
 * request's code (PROW104, PROW105). So a job GitHub runs with a credential
 * while a pull request is open has no Prow form, and the generator refuses
 * the option that adds it by name ({@link prowLoopProblem}).
 *
 * The repository's `owner/name` comes from the forge (`options.forgeRepo`),
 * and the jobs are keyed by it through `forgeJobConfig`.
 */

import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import { hasPublishStep } from "@intentius/chant/components/promote";
import { gatedWaveJobs, GATED_WAVE_RECORD } from "@intentius/chant/components/gated-wave-pipeline";
import { CI_IMAGE, ciJobName, fillCommand } from "@intentius/chant/ci-jobs";
import {
  checkJobOptions,
  PR_APPLY_RECORD,
  PR_LOOP_REPORT_DIR,
  prLoopJobs,
  prLoopSetup,
  prLoopWaveJobs,
  prLoopWithWaves,
  prStaleJob,
  type PrLoopPipelineOptions,
} from "@intentius/chant/components/pr-pipeline";
import { prCheckJob } from "@intentius/chant/components/pr-checks";
import { resolveProductWords } from "@intentius/chant/ci-product-words";
import type { ComponentPipelineJob, ComponentPipelineOptions, ComponentPipelineResult } from "@intentius/chant/lexicon";
import { forgeJobConfig } from "../forge-jobs";
import { prowJobName, renderProwJob, resolveProwSettings, type ProwJobSpec, type ProwRenderContext } from "./prow-jobs";

/** The jobs before they are keyed, with the machine-readable view. */
export interface ProwPipelineDoc {
  repo: string;
  environment: string;
  presubmits: Array<Record<string, unknown>>;
  postsubmits: Array<Record<string, unknown>>;
  stages: string[];
  jobs: ComponentPipelineJob[];
  header: string;
}

/** The job token as a GitHub generator spells it; a Prow job reads it from the token Secret. */
const GITHUB_TOKEN_VALUE = "${{ github.token }}";

/** The pull request loop's options that have no Prow form, each with the reason. */
const NO_PROW_FORM: Array<[keyof PrLoopPipelineOptions, string]> = [
  ["applyBeforeMerge", "applies an open pull request's head with the apply credentials, and on Prow that job would be a presubmit that runs the pull request's code with a credential"],
  ["previewComment", "plans the head again and posts its note from a job that holds the token, and Prow starts no job after a presubmit to post it"],
  ["actionJob", "runs a job with a credential on a comment, and on Prow a comment starts only presubmits, which run the pull request's code"],
  ["locks", "takes the locks with the token after the plan and releases them when the pull request closes, and Prow starts no job after a presubmit or on a close"],
  ["prEnvironment", "applies the pull request's environment from its own code with the environment's credentials"],
  ["refGateStatus", "sets the ref gate's status with the token while the pull request is open"],
  ["evidence", "signs the plan and the checks with the runner key in a job after the pull request's code ran, and Prow starts no job after a presubmit"],
  ["control", "reads the control repo's token from a repository secret, which this generator does not map to a Secret yet"],
  ["identity", "trades the job's OIDC token for a cloud identity, and a Prow job has none; give the postsubmits a service account the cluster binds to the identity (prow.serviceAccounts)"],
  ["prEnvIdentity", "trades the job's OIDC token for a cloud identity, and a Prow job has none"],
  ["runners", "picks GitHub runners, and Prow jobs run on prow.untrustedCluster and prow.trustedCluster"],
  ["secrets", "maps repository secrets, and a Prow job reads a Secret through its pod spec"],
  ["noteCommands", "polls GitLab's merge request notes"],
];

/** Why `loop` has no Prow form, or undefined when every job it adds has one. */
export function prowLoopProblem(loop: PrLoopPipelineOptions): string | undefined {
  for (const [key, why] of NO_PROW_FORM) {
    const v = loop[key];
    // An empty map, such as `secrets: {}`, adds nothing.
    if (v === undefined || v === false || (typeof v === "object" && v !== null && Object.keys(v).length === 0)) continue;
    return `--generate prow writes no job for prLoop.${key}: it ${why}. Drop it, or generate it for GitHub Actions`;
  }
  const check = checkJobOptions(loop.checkJob);
  if (check?.services?.length) return "--generate prow writes the check job with no service containers: Prow runs a decorated job's containers to completion, so start the service from the check's own lines";
  if (check?.artifacts) return "--generate prow keeps the check job's report directory in the job's artifacts, and takes no GitLab artifacts";
  return undefined;
}

/** The repository the jobs are keyed by, refused when there is none. */
function repoOf(options: ComponentPipelineOptions): string {
  const repo = options.forgeRepo;
  if (!repo) throw new Error("--generate prow keys the jobs by the GitHub repository's owner/name; pass --repo <owner/name>, or run it in a checkout whose origin remote is on GitHub");
  return repo;
}

/** The header the job config starts with: what writes it, and where its jobs run. */
function headerOf(repo: string, env: string, ctx: ProwRenderContext, body: Pick<ProwPipelineDoc, "presubmits" | "postsubmits">): string {
  const s = ctx.settings;
  const token = body.postsubmits.some((j) => JSON.stringify(j).includes('"secretKeyRef"'));
  return [
    `Written by chant build --components --generate prow for ${repo}, environment ${env}.`,
    "Add this file to your Prow installation's job config (its job_config_path).",
    ...(body.presubmits.length > 0 ? [`Presubmits run on ${s.untrustedCluster} and hold no credential.`] : []),
    ...(body.postsubmits.length > 0 ? [`Postsubmits run on ${s.trustedCluster}${token ? ` and read the GitHub token from the Secret ${s.tokenSecret.name}` : ""}.`] : []),
  ].join("\n");
}

/** The deploy pipeline: one postsubmit that runs the components in wave order, then the promote. */
function deployDoc(components: DriverComponent[], env: string, ctx: ProwRenderContext, options: ComponentPipelineOptions): Omit<ProwPipelineDoc, "repo" | "environment" | "header"> {
  const runCommand = options.runCommand ?? ["chant", "run", "--components", "{name}", "--env", env];
  const { waves } = resolveComponentGraph(components);
  const byName = new Map(components.map((c) => [c.name, c]));
  const dependedUpon = new Set<string>();
  for (const c of components) for (const dep of c.dependsOn ?? []) dependedUpon.add(dep);
  const promoteTo = options.promoteTo;
  const pinned = new Set<string>();
  if (promoteTo !== undefined) {
    for (const c of components) if (hasPublishStep(c)) pinned.add(c.name);
    if (pinned.size === 0) throw new Error("no component has a publish step, so no deploy records a release for the promote job to promote");
  }
  const lines: string[] = [];
  const jobs: ComponentPipelineJob[] = [];
  const stages = waves.map((_, i) => `wave-${i + 1}`);
  waves.forEach((wave, i) => {
    for (const name of wave) {
      const component = byName.get(name)!;
      const parts = fillCommand(runCommand, name);
      for (const dep of component.dependsOn ?? []) parts.push("--seed-outputs", `${dep}.outputs.json`);
      if (dependedUpon.has(name)) parts.push("--dump-outputs", `${name}.outputs.json`);
      if (pinned.has(name)) parts.push("--digest-file", `${name}.digest`);
      lines.push(parts.join(" "));
      jobs.push({ jobName: ciJobName(name), component: name, stage: stages[i]!, needs: (component.dependsOn ?? []).map(ciJobName).sort() });
    }
  });
  if (promoteTo !== undefined) {
    const command = [...(options.promoteCommand ?? ["chant", "components", "promote", "--from", env, "--to", promoteTo])];
    for (const name of [...pinned].sort()) command.push("--digest", `"${name}=$(cut -d= -f2- ${name}.digest)"`);
    lines.push(command.join(" "));
    const promoteJob = `promote-${ciJobName(promoteTo)}`;
    jobs.push({ jobName: promoteJob, component: promoteJob, stage: promoteJob, needs: jobs.map((j) => j.jobName).sort() });
  }
  const spec: ProwJobSpec = {
    kind: "postsubmit",
    name: prowJobName("chant", options.member?.name, "components", env),
    description: `chant: deploys the ${components.length} components to ${env} in dependency order${promoteTo !== undefined ? `, then promotes them to ${promoteTo}` : ""}. Rerun it from Deck to deploy again.`,
    lines,
    // A run records on chant/lifecycle and pushes it, as a GitHub job does with the token its checkout keeps.
    env: { GITHUB_TOKEN: GITHUB_TOKEN_VALUE },
    serial: true,
    ...(ctx.settings.serviceAccounts.apply ? { serviceAccount: ctx.settings.serviceAccounts.apply } : {}),
  };
  return { presubmits: [], postsubmits: [renderProwJob(spec, ctx)], stages, jobs };
}

/** The gated-wave pipeline: one postsubmit that runs the waves in order. */
function gatedWaveDoc(components: DriverComponent[], env: string, ctx: ProwRenderContext, options: ComponentPipelineOptions): Omit<ProwPipelineDoc, "repo" | "environment" | "header"> {
  const waveJobs = gatedWaveJobs(components, env, options.gatedWaves!);
  const spec: ProwJobSpec = {
    kind: "postsubmit",
    name: prowJobName("chant", options.member?.name, "waves", env),
    description: `chant: runs the ${waveJobs.length} waves in order, each behind its gate ${options.gatedWaves!.gate}-wave-<k>. A held wave stops the job; rerun it from Deck once the wave is approved.`,
    lines: waveJobs.map((j) => j.command.join(" ")),
    keep: [GATED_WAVE_RECORD],
    env: { GITHUB_TOKEN: GITHUB_TOKEN_VALUE },
    serial: true,
    ...(ctx.settings.serviceAccounts.apply ? { serviceAccount: ctx.settings.serviceAccounts.apply } : {}),
  };
  return {
    presubmits: [],
    postsubmits: [renderProwJob(spec, ctx)],
    stages: waveJobs.map((j) => j.jobName),
    jobs: waveJobs.map((j) => ({ jobName: j.jobName, component: `wave ${j.wave}`, stage: j.jobName, needs: j.needs })),
  };
}

/** The pull request loop: the plan and check presubmits, and the record, apply and stale-notes postsubmits. */
function prLoopDoc(components: DriverComponent[], env: string, ctx: ProwRenderContext, options: ComponentPipelineOptions): Omit<ProwPipelineDoc, "repo" | "environment" | "header"> {
  const loop = prLoopWithWaves(options.prLoop!, options.gatedWaves);
  const problem = prowLoopProblem(loop);
  if (problem) throw new Error(problem);
  const member = options.member?.name;
  const [plan, apply, record] = prLoopJobs("github", env, loop, member);
  const s = ctx.settings;
  const name = (kind: string) => prowJobName("chant", member, kind, env);
  const presubmits: ProwJobSpec[] = [
    {
      kind: "presubmit",
      name: name("plan"),
      description: `chant: plans the members this pull request reaches in ${env}, with no credential. The note and the status are in the report the job keeps in its artifacts.`,
      lines: [...(plan!.build ?? []), ...(plan!.checkout ?? []), ...(plan!.setup ?? []), plan!.run.command],
      env: plan!.run.env,
      keep: [PR_LOOP_REPORT_DIR],
    },
  ];
  const check = checkJobOptions(loop.checkJob);
  const jobs: ComponentPipelineJob[] = [{ jobName: name("plan"), component: "pull request plan", stage: "presubmit", needs: [] }];
  if (check) {
    const words = resolveProductWords(loop.words);
    const job = prCheckJob("github", { ...check, ...(words.bin ? { bin: words.bin } : {}) });
    presubmits.push({
      kind: "presubmit",
      name: name("check"),
      description: "chant: runs the check stage's hooks on the pull request's commit, with no credential, and keeps the report in the job's artifacts.",
      lines: [...(job.before ?? []), job.command],
      env: job.env,
      keep: [job.dir],
    });
    jobs.push({ jobName: name("check"), component: "pull request check", stage: "presubmit", needs: [] });
  }
  const postsubmits: ProwJobSpec[] = [
    {
      kind: "postsubmit",
      name: name("record"),
      description: `chant: plans the merged commit in ${env} and writes the merge record; it applies nothing.`,
      lines: [...(record!.build ?? []), ...(record!.checkout ?? []), ...(record!.setup ?? []), record!.run.command],
      env: record!.run.env,
      keep: [PR_LOOP_REPORT_DIR],
      serial: true,
      ...(s.serviceAccounts.plan ? { serviceAccount: s.serviceAccounts.plan } : {}),
    },
  ];
  jobs.push({ jobName: name("record"), component: "merge record", stage: "postsubmit", needs: [] });
  if (loop.applyOnMerge) {
    const waves = loop.waveGate ? prLoopWaveJobs(components, apply!) : [apply!];
    postsubmits.push({
      kind: "postsubmit",
      name: name("apply"),
      description: loop.waveGate
        ? `chant: applies the newest green commit to ${env} a wave at a time, under the approval its plan has. A held wave stops the job; rerun it from Deck once the wave is approved.`
        : `chant: applies the newest green commit to ${env} under the merged changes' approvals.`,
      lines: [...(apply!.build ?? []), ...waves.flatMap((w) => [...(w.checkout ?? []), ...(w.setup ?? []), w.run.command])],
      env: apply!.run.env,
      keep: [PR_LOOP_REPORT_DIR, PR_APPLY_RECORD],
      serial: true,
      ...(s.serviceAccounts.apply ? { serviceAccount: s.serviceAccounts.apply } : {}),
    });
    jobs.push({ jobName: name("apply"), component: loop.waveGate ? `green apply, ${waves.length} waves` : "green apply", stage: "postsubmit", needs: [] });
  }
  const stale = prStaleJob("github", env, loop, member);
  if (stale) {
    postsubmits.push({
      kind: "postsubmit",
      name: name("stale-notes"),
      description: "chant: marks the open pull requests' notes posted against another commit of the branch stale.",
      lines: [stale.command],
      env: stale.env,
    });
    jobs.push({ jobName: name("stale-notes"), component: "pull request stale notes", stage: "postsubmit", needs: [] });
  }
  return {
    presubmits: presubmits.map((j) => renderProwJob(j, ctx)),
    postsubmits: postsubmits.map((j) => renderProwJob(j, ctx)),
    stages: ["presubmit", "postsubmit"],
    jobs,
  };
}

/**
 * The Prow jobs for a set of components, before they are keyed by the
 * repository. Throws for a dependency cycle or an unknown dependency, as
 * the forge generators do, and for an option with no Prow form.
 */
export function buildProwPipelineDoc(components: DriverComponent[], options: ComponentPipelineOptions = {}): ProwPipelineDoc {
  const repo = repoOf(options);
  const env = options.env ?? "production";
  const image = options.image ?? CI_IMAGE;
  const settings = resolveProwSettings(options.prow);
  const loop = options.prLoop;
  const branch = loop?.branch ?? "main";
  const member = options.member;
  const ctx: ProwRenderContext = {
    settings,
    repo,
    branch,
    image,
    variables: { ...options.variables, CHANT_ENV: env },
    before: [...(loop ? prLoopSetup(image, loop.engineSetup) : []), ...(options.beforeScript ?? [])],
    after: options.extraScript ?? [],
    ...(member && member.dir !== "." && member.dir !== "" ? { dir: member.dir } : {}),
  };
  // Every graph is resolved first, so a cycle is refused whichever pipeline it is.
  resolveComponentGraph(components);
  let body: Omit<ProwPipelineDoc, "repo" | "environment" | "header">;
  if (loop) {
    if (options.promoteTo !== undefined) throw new Error("a pull-request pipeline has no promote job; drop --promote-to or --pr-loop");
    body = prLoopDoc(components, env, ctx, options);
  } else if (options.gatedWaves) {
    if (options.promoteTo !== undefined) throw new Error("a gated-wave pipeline has no promote job; drop --promote-to or --wave-gate");
    body = gatedWaveDoc(components, env, ctx, options);
  } else {
    body = deployDoc(components, env, ctx, options);
  }
  return { repo, environment: env, header: headerOf(repo, env, ctx, body), ...body };
}

/**
 * `chant build --components --generate prow`: the Prow job config for a
 * component project, keyed by the repository's `owner/name`. Wired in
 * through the prow lexicon plugin's `generateComponentPipeline`.
 */
export function generateProwPipeline(components: DriverComponent[], options: ComponentPipelineOptions = {}): ComponentPipelineResult {
  const doc = buildProwPipelineDoc(components, options);
  const yaml = forgeJobConfig({ forge: "github", repo: doc.repo }, { presubmits: doc.presubmits, postsubmits: doc.postsubmits }, { header: doc.header });
  return { yaml, stages: doc.stages, jobs: doc.jobs, env: doc.environment };
}
