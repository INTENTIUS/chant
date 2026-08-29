/**
 * Generate mode — scheduled Op → GitHub Actions workflow YAML (#927).
 *
 * The Op counterpart to `./generate-pipeline.ts` (#891): that module
 * synthesizes a `workflow_dispatch`-triggered pipeline from a deploy-time
 * component graph, this one synthesizes a cron-triggered workflow per
 * stateless Op — the CI-native alternative to a Temporal `TemporalSchedule`
 * for downstream projects that don't run Temporal (`WorkflowAuditOp`,
 * `PipelineAuditOp`, `ReconcileOp`, … all accept an optional `schedule`
 * precisely for this).
 *
 * GitHub Actions' `on.schedule` is workflow-scoped, not job-scoped, so unlike
 * the component generator (one combined pipeline for the whole graph) this
 * emits one workflow file per `ScheduledOpSpec`. Each workflow:
 *  - triggers on `schedule` (the Op's cron) and `workflow_dispatch` (manual
 *    runs stay available for testing/dry-runs);
 *  - declares only the `permissions:` its `findingMode` needs — `report`
 *    stays read-only, `issue`/`pull-request` add the write scope the Op's own
 *    activity uses (`gh issue create` / `gh pr create`, see
 *    `@intentius/chant-lexicon-temporal`'s `reconcilePr` activity) — never a
 *    blanket `write-all`;
 *  - runs exactly one invocation, `chant run <name>` by default — never
 *    inlined audit/reconcile logic. The finding-mode itself is already baked
 *    into the Op's own activity args at build time by the composite that
 *    created it; this workflow only supplies the token the mode needs to act.
 */

import { emitYAML } from "@intentius/chant/yaml";
import type {
  ComponentPipelineOptions as GenerateGithubOpOptions,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGithubOpResult,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";

export type { GenerateGithubOpOptions, GenerateGithubOpResult };

/**
 * The structured pipeline document behind one generated file, before YAML
 * emission — exposed so a GitHub-Actions dialect (the forgejo lexicon, #969)
 * can reuse the exact trigger/concurrency/job structure and only apply its
 * dialect transform + emit, rather than re-deriving it. Mirrors
 * `./generate-pipeline.ts`'s `GithubPipelineDoc` split.
 */
export interface GithubOpPipelineDoc {
  /** The `on:` trigger mapping (`schedule` + `workflow_dispatch`). */
  on: Record<string, unknown>;
  /** The `env:` mapping, when `options.variables` is set. */
  env?: Record<string, unknown>;
  /** The `concurrency:` mapping — one run at a time per Op. */
  concurrency: Record<string, unknown>;
  /**
   * The `permissions:` mapping for this Op's finding-mode. GitHub-only:
   * Forgejo Actions ignores `permissions:` entirely, so the forgejo dialect
   * drops this section rather than translating it (see ../../forgejo/src/dialect.ts).
   */
  permissions: Record<string, unknown>;
  /** The `jobs:` mapping — one entry, this Op's trigger job. */
  jobsDoc: Record<string, unknown>;
}

/** One generated file: a suggested name plus its pipeline document, pre-emission. */
export interface GithubOpPipelineFile {
  /** Suggested file name (`<op-name>.yml`), relative to the provider's workflow directory. */
  name: string;
  doc: GithubOpPipelineDoc;
}

/** GitHub Actions job ids must match `[a-zA-Z_][a-zA-Z0-9_-]*`; Op names are already kebab-case in every fixture, but normalize defensively (mirrors `./generate-pipeline.ts`'s `toJobName`). */
function toJobName(opName: string): string {
  return opName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const DEFAULT_IMAGE = "node:22-slim";

/**
 * Least-privilege `permissions:` for a scheduled Op's finding-mode. `report`
 * needs no write access; `issue` needs only `issues: write`; `pull-request`
 * (and `merge-request`, generated the same way when a GitLab-authored spec is
 * targeted at github) needs `contents: write` to push the reconcile branch
 * plus `pull-requests: write` to open the PR.
 */
function permissionsFor(mode: OpFindingMode): Record<string, "read" | "write"> {
  switch (mode) {
    case "issue":
      return { contents: "read", issues: "write" };
    case "pull-request":
    case "merge-request":
      return { contents: "write", "pull-requests": "write" };
    case "report":
      return { contents: "read" };
  }
}

/**
 * Build one `GithubOpPipelineDoc` per scheduled Op: cron trigger,
 * least-privilege `permissions:` for its finding-mode, one job that runs
 * `chant run <name>`. Throws nothing — every `ScheduledOpSpec` is independent,
 * unlike the component generator there is no shared graph to resolve.
 */
export function buildGithubOpPipelineDocs(
  ops: ScheduledOpSpec[],
  options: GenerateGithubOpOptions = {},
): { files: GithubOpPipelineFile[]; jobs: OpPipelineJob[] } {
  const image = options.image ?? DEFAULT_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const files: GithubOpPipelineFile[] = [];
  const jobs: OpPipelineJob[] = [];

  for (const spec of ops) {
    const findingMode = spec.findingMode ?? "report";
    const jobName = toJobName(spec.name);
    jobs.push({ jobName, op: spec.name, schedule: spec.schedule, findingMode });

    const runParts = runCommand.map((part) => part.replace("{name}", spec.name));

    // A live-resolution read (rate limits) always benefits from a token;
    // creating an issue/PR additionally needs `gh` CLI's own token variable.
    const stepEnv: Record<string, string> = { GITHUB_TOKEN: "${{ github.token }}" };
    if (findingMode !== "report") stepEnv.GH_TOKEN = "${{ github.token }}";

    const steps: Array<Record<string, unknown>> = [{ uses: "actions/checkout@v4" }];
    for (const line of beforeScript) steps.push({ run: line });
    steps.push({ run: runParts.join(" "), env: stepEnv });
    for (const line of extraScript) steps.push({ run: line });

    const doc: GithubOpPipelineDoc = {
      on: { schedule: [{ cron: spec.schedule }], workflow_dispatch: {} },
      ...(options.variables && Object.keys(options.variables).length > 0 ? { env: options.variables } : {}),
      // One run at a time per Op — a slow audit must not overlap its own next
      // scheduled trigger.
      concurrency: { group: jobName, "cancel-in-progress": false },
      permissions: permissionsFor(findingMode),
      jobsDoc: {
        [jobName]: {
          "runs-on": "ubuntu-latest",
          container: image,
          steps,
        },
      },
    };

    files.push({ name: `${spec.name}.yml`, doc });
  }

  return { files, jobs };
}

/**
 * Emit a `GithubOpPipelineDoc`'s `on`/`env`/`concurrency`/`permissions`/`jobs`
 * mappings as workflow YAML. Shared with the forgejo dialect (#969), which
 * transforms the doc first (and drops `permissions`, which it ignores).
 */
export function emitOpPipelineYAML(doc: GithubOpPipelineDoc): string {
  const sections: string[] = [];
  sections.push("on:" + emitYAML(doc.on, 1));
  if (doc.env && Object.keys(doc.env).length > 0) sections.push("env:" + emitYAML(doc.env, 1));
  sections.push("concurrency:" + emitYAML(doc.concurrency, 1));
  if (Object.keys(doc.permissions).length > 0) sections.push("permissions:" + emitYAML(doc.permissions, 1));
  sections.push("jobs:" + emitYAML(doc.jobsDoc, 1));
  return sections.join("\n\n") + "\n";
}

/**
 * Synthesize one `.github/workflows/*.yml` per scheduled Op. Thin wrapper
 * over {@link buildGithubOpPipelineDocs} + {@link emitOpPipelineYAML}. Wired
 * into core's Op generate mode via the github lexicon plugin's
 * `generateOpPipeline` (../plugin.ts).
 */
export function generateGithubOpPipeline(
  ops: ScheduledOpSpec[],
  options: GenerateGithubOpOptions = {},
): GenerateGithubOpResult {
  const { files, jobs } = buildGithubOpPipelineDocs(ops, options);
  return {
    files: files.map((f) => ({ name: f.name, yaml: emitOpPipelineYAML(f.doc) })),
    jobs,
  };
}
