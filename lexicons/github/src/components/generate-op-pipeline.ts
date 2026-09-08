/**
 * Generate mode — scheduled Op → GitHub Actions workflow YAML (#927).
 *
 * The Op counterpart to `./generate-pipeline.ts` (#891): that module
 * synthesizes a `workflow_dispatch`-triggered pipeline from a deploy-time
 * component graph, this one synthesizes a cron-triggered workflow per
 * stateless Op. An Op's cadence is an `OpSchedule` on the Op itself
 * (`packages/core/src/op/types.ts`), runtime-neutral data each reader
 * interprets; this module is the reader that turns it into a cron a GitHub
 * runner fires (`WorkflowAuditOp`, `PipelineAuditOp`, `ReconcileOp`, … all
 * accept an optional `schedule` precisely for this).
 *
 * GitHub Actions' `on.schedule` is workflow-scoped, not job-scoped, so unlike
 * the component generator (one combined pipeline for the whole graph) this
 * emits one workflow file per `ScheduledOpSpec`. Each workflow:
 *  - triggers on its `ScheduledOpSpec`'s trigger (#2084): `cron` (the Op's
 *    schedule, plus `workflow_dispatch` so manual runs stay available for
 *    testing/dry-runs), `pull_request` (optionally filtered to `branches`,
 *    no `workflow_dispatch` — a PR event needs no manual escape hatch), or
 *    `push` (filtered to `branches`, defaulting to the repository's default
 *    branch);
 *  - declares only the `permissions:` its `findingMode` (and, for a
 *    `pull_request` trigger, whether that mode posts a comment) needs —
 *    `report` stays read-only, `issue`/`comment`/`pull-request` add the write
 *    scope the Op's own activity uses (`gh issue create` / a comment on the
 *    triggering PR / `gh pr create`, see `@intentius/chant/op`'s
 *    `reconcilePr` activity) — never a blanket `write-all`. `comment` is the
 *    one mode that constrains the trigger rather than only the scope: it
 *    needs a pull request to post onto, so this generator refuses it by name
 *    on any other trigger (#2231);
 *  - runs exactly one invocation, `chant run <name>` by default — never
 *    inlined audit/reconcile logic. The finding-mode itself is already baked
 *    into the Op's own activity args at build time by the composite that
 *    created it; this workflow only supplies the token the mode needs to act.
 *
 * Two per-Op options widen that shape without loosening it (#2242). A spec's
 * `setup` list emits steps between the checkout and the `beforeScript` lines,
 * `uses:` steps included, which is the only way a generated job can reach an
 * action like `aws-actions/configure-aws-credentials`; {@link
 * assertSetupSteps} refuses an unpinned or default-branch ref at build time.
 * A spec's `permissions` map is merged over {@link permissionsFor}, adding
 * scopes the finding-mode never grants (`id-token: write` is the whole
 * reason) and never touching one it does; {@link mergePermissions} refuses a
 * blanket grant, an overlap with the mode's own set, an unknown scope name,
 * and pull-request write on a trigger that has no pull request.
 */

import { emitYAML } from "@intentius/chant/yaml";
import { resolveOpTrigger } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineOptions as GenerateGithubOpOptions,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGithubOpResult,
  OpSetupStep,
  OpTrigger,
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
  /**
   * The `on:` trigger mapping, per {@link ScheduledOpSpec}'s trigger kind
   * (#2084): `{ schedule, workflow_dispatch }` for cron, `{ pull_request }`
   * for `pull_request`, `{ push }` for `push`.
   */
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
 * Default branch assumed for a `push` trigger with no `branches` override
 * (#2084). There is no generator constant for a downstream project's actual
 * default branch — this operates on a `ScheduledOpSpec`, not a git checkout
 * — so "main" is the documented default; set `trigger.branches` explicitly
 * for a project whose default branch is something else (e.g. "master").
 */
const DEFAULT_PUSH_BRANCH = "main";

/** This trigger's `on:` mapping (#2084): cron unchanged, `pull_request`/`push` new. */
function onFor(trigger: OpTrigger): Record<string, unknown> {
  switch (trigger.kind) {
    case "cron":
      return { schedule: [{ cron: trigger.schedule }], workflow_dispatch: {} };
    case "pull_request":
      // No `workflow_dispatch`: a PR trigger needs no manual-dispatch escape
      // hatch (revisit in review if that's wrong).
      return { pull_request: trigger.branches ? { branches: trigger.branches } : {} };
    case "push":
      return { push: { branches: trigger.branches ?? [DEFAULT_PUSH_BRANCH] } };
  }
}

/**
 * Least-privilege `permissions:` for a scheduled Op's finding-mode and
 * trigger. `report` needs no write access; `issue` needs only `issues:
 * write`; `pull-request` (and `merge-request`, generated the same way when a
 * GitLab-authored spec is targeted at github) needs `contents: write` to
 * push the reconcile branch plus `pull-requests: write` to open the PR. A
 * `pull_request` trigger reports its finding as a comment on the triggering
 * PR itself (#2084): any mode but `report` posts something to act on a
 * finding, so on that trigger every such mode also gets `pull-requests:
 * write` for the comment, whether or not its own scope already included it.
 * `comment` is the mode that actually spends that grant (#2231), and it
 * changes nothing in the repository, so its whole scope is `{ contents: read,
 * pull-requests: write }`.
 */
function permissionsForMode(mode: OpFindingMode): Record<string, "read" | "write"> {
  switch (mode) {
    case "issue":
      return { contents: "read", issues: "write" };
    case "comment":
      return { contents: "read", "pull-requests": "write" };
    case "pull-request":
    case "merge-request":
      return { contents: "write", "pull-requests": "write" };
    case "report":
      return { contents: "read" };
  }
}

function permissionsFor(mode: OpFindingMode, trigger: OpTrigger): Record<string, "read" | "write"> {
  const base = permissionsForMode(mode);
  if (trigger.kind === "pull_request" && mode !== "report") {
    return { ...base, "pull-requests": "write" };
  }
  return base;
}

/**
 * Refuse `findingMode: "comment"` on a trigger that has no pull request
 * (#2231). The mode's activity reads the triggering PR out of the event
 * payload at run time, so a cron- or push-triggered job carrying it would
 * generate fine and then fail on every run. Refusing here names the Op, the
 * mode and the trigger at build time instead.
 */
function assertTriggerSupportsMode(name: string, mode: OpFindingMode, trigger: OpTrigger): void {
  if (mode !== "comment" || trigger.kind === "pull_request") return;
  throw new Error(
    `Scheduled Op "${name}" has findingMode "comment", which posts its finding on the pull request that ` +
      `triggered the run, but its trigger is "${trigger.kind}". A ${trigger.kind} run has no pull request ` +
      `to comment on. Give it a { kind: "pull_request" } trigger, or use findingMode "issue".`,
  );
}

/**
 * Every scope `GITHUB_TOKEN` accepts in a workflow's `permissions:` mapping,
 * kebab-cased as GitHub spells them. An additive scope outside this set is
 * refused by name rather than emitted: GitHub ignores an unknown key, so
 * `id_token` or `idToken` would generate a workflow that looks like it grants
 * OIDC and hands the run no token at all.
 */
const GITHUB_TOKEN_SCOPES = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
]);

/**
 * Refs that name an action repository's own default branch. A generated
 * workflow is committed once and then re-run unattended, often over a cloud
 * role, so "whatever was pushed to that repo last" is not a version — the
 * code that assumes the role can change between the run somebody reviewed and
 * the next one. A release channel the action's author cuts deliberately (`v6`,
 * `v6.2.4`, `stable`) or a commit sha is a version, and both pass: this repo's
 * own workflows pin `actions/checkout@v6` and `dtolnay/rust-toolchain@stable`
 * and name no default branch anywhere.
 */
const DEFAULT_BRANCH_REFS = new Set(["main", "master", "head", "default"]);

/** `owner/repo` or `owner/repo/subpath`, then `@ref`. */
const USES_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)@([^\s@]+)$/;

/**
 * Validate a spec's `setup` list (#2242). A `run` entry needs a non-empty
 * line and nothing else. A `uses` entry has to be a pinned
 * `owner/repo[/subpath]@ref`: no bare `owner/repo`, since an unpinned action
 * resolves to its default branch, and no ref in {@link DEFAULT_BRANCH_REFS}
 * for the same reason spelled out loud. Local (`./path`) and container
 * (`docker://`) refs are refused too — they are legal GitHub Actions, but the
 * generator emits a workflow into a repository it has never seen, so it
 * cannot know a local path resolves there.
 */
export function assertSetupSteps(name: string, setup: OpSetupStep[]): void {
  setup.forEach((step, index) => {
    const where = `Scheduled Op "${name}" setup step ${index + 1}`;
    if ("uses" in step) {
      const ref = step.uses.trim();
      const match = USES_PATTERN.exec(ref);
      if (!match) {
        throw new Error(
          `${where} has \`uses: "${step.uses}"\`, which is not a pinned action reference. ` +
            `Write it as owner/repo@ref (optionally owner/repo/subpath@ref), e.g. ` +
            `"aws-actions/configure-aws-credentials@v6". A local "./path" or "docker://" ref is not ` +
            `accepted here: this generator emits a workflow into a repository it cannot inspect, so it ` +
            `has no way to tell whether such a ref resolves there.`,
        );
      }
      const gitRef = match[4];
      if (DEFAULT_BRANCH_REFS.has(gitRef.toLowerCase())) {
        throw new Error(
          `${where} pins \`uses: "${step.uses}"\` to "${gitRef}", the action repository's own default ` +
            `branch, which names whatever was pushed there last rather than a version. A generated ` +
            `workflow is committed once and re-run unattended, often over a cloud role, so pin a release ` +
            `tag or a commit sha instead (e.g. "${match[1]}/${match[2]}@v1" or "@<40-char sha>").`,
        );
      }
      return;
    }
    if (step.run.trim() === "") {
      throw new Error(`${where} has an empty \`run\` line. Give it a command, or drop the entry.`);
    }
  });
}

/**
 * Merge a spec's additive `permissions` over the finding-mode's own set
 * (#2242), refusing by name anything that is not strictly additive:
 *
 *  - a blanket `write-all`/`read-all`, in either the key or the value
 *    position, which is the exact thing {@link permissionsForMode} exists to
 *    avoid;
 *  - a scope GitHub does not define ({@link GITHUB_TOKEN_SCOPES}), because
 *    GitHub ignores the key and the run silently gets nothing;
 *  - a scope the mode already grants, at any value — additive means additive,
 *    so this can neither downgrade `contents: write` to read nor restate it.
 *    A mode whose set is wrong is fixed by changing the mode, where the
 *    scope and the behavior that spends it stay together;
 *  - `pull-requests: write` on a trigger with no pull request. Pull-request
 *    access is what the finding-modes own: `pull-request` grants it together
 *    with the `contents: write` needed to push the branch first, and
 *    `comment` grants it on the one trigger that carries a pull request to
 *    comment on. Adding it beside a mode that posts nothing, on a cron or
 *    push run, grants write access no step in the generated job can spend.
 */
export function mergePermissions(
  name: string,
  base: Record<string, "read" | "write">,
  additive: Record<string, "read" | "write">,
  trigger: OpTrigger,
): Record<string, "read" | "write"> {
  const merged: Record<string, "read" | "write"> = { ...base };
  for (const [rawScope, value] of Object.entries(additive)) {
    const scope = rawScope.trim();
    const where = `Scheduled Op "${name}" adds permission "${scope}: ${value}"`;
    if (scope === "write-all" || scope === "read-all" || String(value).endsWith("-all")) {
      throw new Error(
        `${where}, a blanket grant. \`permissions\` on a scheduled Op is additive over the ` +
          `least-privilege set its finding-mode needs, one named scope at a time. Name the scopes the ` +
          `job actually spends (e.g. { "id-token": "write" }).`,
      );
    }
    if (!GITHUB_TOKEN_SCOPES.has(scope)) {
      throw new Error(
        `${where}, which is not a GITHUB_TOKEN permission scope. GitHub ignores an unrecognized key, so ` +
          `this would emit a workflow that reads as granted and hands the run nothing. Known scopes: ` +
          `${[...GITHUB_TOKEN_SCOPES].sort().join(", ")}.`,
      );
    }
    if (scope in base) {
      throw new Error(
        `${where}, but its finding-mode already grants "${scope}: ${base[scope]}". These permissions are ` +
          `additive only — they never replace, widen or downgrade a scope the mode computed. Change the ` +
          `Op's findingMode if that set is wrong, and add only scopes no mode grants (e.g. "id-token").`,
      );
    }
    if (scope === "pull-requests" && trigger.kind !== "pull_request") {
      throw new Error(
        `${where}, but this Op's trigger is "${trigger.kind}", which carries no pull request. Pull-request ` +
          `write access belongs to a finding-mode: "pull-request" grants it with the contents: write its ` +
          `branch push needs, and "comment" grants it on the pull_request trigger. Set findingMode instead ` +
          `of adding the scope here.`,
      );
    }
    merged[scope] = value;
  }
  return merged;
}

/** Emit one setup entry as a GitHub Actions step. */
function setupStepDoc(step: OpSetupStep): Record<string, unknown> {
  if ("uses" in step) {
    return {
      uses: step.uses,
      ...(step.with && Object.keys(step.with).length > 0 ? { with: step.with } : {}),
      ...(step.env && Object.keys(step.env).length > 0 ? { env: step.env } : {}),
    };
  }
  return {
    run: step.run,
    ...(step.env && Object.keys(step.env).length > 0 ? { env: step.env } : {}),
  };
}

/**
 * Build one `GithubOpPipelineDoc` per scheduled Op: its trigger, its `setup`
 * steps, least-privilege `permissions:` for its finding-mode plus whatever
 * the spec adds, one job that runs `chant run <name>`. Every
 * `ScheduledOpSpec` is independent — unlike the component generator there is
 * no shared graph to resolve — so the only thing this refuses is a spec that
 * contradicts itself: no trigger at all (`resolveOpTrigger`), `findingMode:
 * "comment"` on a trigger that has no pull request ({@link
 * assertTriggerSupportsMode}), an unpinned `setup` action ({@link
 * assertSetupSteps}), or a `permissions` entry that is not additive ({@link
 * mergePermissions}).
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
    const trigger = resolveOpTrigger(spec);
    assertTriggerSupportsMode(spec.name, findingMode, trigger);
    const jobName = toJobName(spec.name);
    jobs.push({ jobName, op: spec.name, trigger, findingMode });

    const runParts = runCommand.map((part) => part.replace("{name}", spec.name));

    // A live-resolution read (rate limits) always benefits from a token;
    // creating an issue/PR additionally needs `gh` CLI's own token variable.
    const stepEnv: Record<string, string> = { GITHUB_TOKEN: "${{ github.token }}" };
    if (findingMode !== "report") stepEnv.GH_TOKEN = "${{ github.token }}";

    const setup = spec.setup ?? [];
    assertSetupSteps(spec.name, setup);

    const steps: Array<Record<string, unknown>> = [{ uses: "actions/checkout@v4" }];
    for (const step of setup) steps.push(setupStepDoc(step));
    for (const line of beforeScript) steps.push({ run: line });
    steps.push({ run: runParts.join(" "), env: stepEnv });
    for (const line of extraScript) steps.push({ run: line });

    const doc: GithubOpPipelineDoc = {
      on: onFor(trigger),
      ...(options.variables && Object.keys(options.variables).length > 0 ? { env: options.variables } : {}),
      // One run at a time per Op — a slow audit must not overlap its own next
      // scheduled trigger.
      concurrency: { group: jobName, "cancel-in-progress": false },
      permissions: mergePermissions(
        spec.name,
        permissionsFor(findingMode, trigger),
        spec.permissions ?? {},
        trigger,
      ),
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
