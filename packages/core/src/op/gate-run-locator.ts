/**
 * Where a CI job that waits at a gate runs, and what its forge needs to start
 * it again (#3683). Read from the job's environment when a pending fact is
 * recorded; `../gate-resume-run.ts` uses it to resume the job. It imports nothing
 * at run time, so `@intentius/chant/point-decision` records it on the pending
 * fact of a gate that asks a decision point too (#3835).
 */

import type { ForgeKind } from "../pr-forge";
import type { RunOrigin } from "../lifecycle/release-ledger";

/** Where the job that recorded a pending fact runs, and what its forge needs to start it again. */
export interface GateRunLocator {
  forge: ForgeKind;
  /** The forge's API base: `$GITHUB_API_URL` (GitHub and Forgejo) or `$CI_API_V4_URL` (GitLab). */
  api: string;
  /** `owner/name` on GitHub and Forgejo, the project id on GitLab. */
  repo: string;
  /** The run: GitHub's and Forgejo's run id, GitLab's pipeline id. */
  run: string;
  /** GitHub: the run attempt that waited. A later attempt means it was already re-run. */
  attempt?: number;
  /** GitLab: the job that waited. */
  job?: string;
  /** GitLab: that job's name, to find a retry of it. */
  jobName?: string;
  /** Forgejo: the workflow file the run came from, which a dispatch names. */
  workflow?: string;
  /** Forgejo: the branch a dispatch runs on. */
  ref?: string;
  /** The run's page, for a person. */
  url?: string;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/**
 * The locator of the CI job this process runs in, or undefined outside CI or
 * when the environment lacks a part a resume needs. Forgejo Actions sets the
 * `GITHUB_*` variables too, and is told apart by `FORGEJO_ACTIONS` or
 * `GITEA_ACTIONS`.
 */
export function resolveGateRunLocator(env: Record<string, string | undefined> = process.env): GateRunLocator | undefined {
  if (env.GITLAB_CI === "true") {
    if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !env.CI_PIPELINE_ID || !env.CI_JOB_ID) return undefined;
    return {
      forge: "gitlab",
      api: trimSlash(env.CI_API_V4_URL),
      repo: env.CI_PROJECT_ID,
      run: env.CI_PIPELINE_ID,
      job: env.CI_JOB_ID,
      ...(env.CI_JOB_NAME ? { jobName: env.CI_JOB_NAME } : {}),
      ...(env.CI_JOB_URL ? { url: env.CI_JOB_URL } : {}),
    };
  }
  if (env.GITHUB_ACTIONS !== "true" || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  const forgejo = env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true";
  const server = env.GITHUB_SERVER_URL ? trimSlash(env.GITHUB_SERVER_URL) : undefined;
  const url = server ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  if (forgejo) {
    const workflow = forgejoWorkflowFile(env);
    const api = env.GITHUB_API_URL ?? (server ? `${server}/api/v1` : undefined);
    if (!api || !workflow || !env.GITHUB_REF_NAME) return undefined;
    return {
      forge: "forgejo",
      api: trimSlash(api),
      repo: env.GITHUB_REPOSITORY,
      run: env.GITHUB_RUN_ID,
      workflow,
      ref: env.GITHUB_REF_NAME,
      ...(url ? { url } : {}),
    };
  }
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  return {
    forge: "github",
    api: trimSlash(env.GITHUB_API_URL ?? "https://api.github.com"),
    repo: env.GITHUB_REPOSITORY,
    run: env.GITHUB_RUN_ID,
    ...(Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * The workflow file a Forgejo run came from, by its base name. Forgejo names
 * a workflow by its file (`GITHUB_WORKFLOW`, `deploy.yml`); `GITHUB_WORKFLOW_REF`
 * (`owner/repo/.forgejo/workflows/deploy.yml@refs/heads/main`) says it too.
 */
function forgejoWorkflowFile(env: Record<string, string | undefined>): string | undefined {
  const fromRef = env.GITHUB_WORKFLOW_REF?.split("@")[0]?.split("/").pop();
  if (fromRef && /\.ya?ml$/.test(fromRef)) return fromRef;
  const name = env.GITHUB_WORKFLOW;
  return name && /\.ya?ml$/.test(name) ? name.split("/").pop() : undefined;
}

/** Whether `value` is a {@link GateRunLocator} a resume can use. */
export function isGateRunLocator(value: unknown): value is GateRunLocator {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.api !== "string" || typeof v.repo !== "string" || typeof v.run !== "string") return false;
  if (v.forge === "github") return true;
  if (v.forge === "gitlab") return typeof v.job === "string";
  if (v.forge === "forgejo") return typeof v.workflow === "string" && typeof v.ref === "string";
  return false;
}

/**
 * The CI run a {@link GateRunLocator} names, in the shape a run and a deploy
 * record carry (#4020). `runId` is the locator's `run`. Forge `github` and
 * `forgejo` both become `github`, as `RunOrigin.forge` documents (the `url`
 * names the host), and `gitlab` stays `gitlab`. `repo` and `url` carry over.
 * The API base, attempt, job and workflow fields stay on the locator, which
 * exists to start the job again.
 */
export function runOriginOfLocator(locator: GateRunLocator): { runId: string; runOrigin: RunOrigin } {
  return {
    runId: locator.run,
    runOrigin: {
      forge: locator.forge === "gitlab" ? "gitlab" : "github",
      repo: locator.repo,
      ...(locator.url ? { url: locator.url } : {}),
    },
  };
}

/**
 * The id of the CI run this process is in, or undefined outside CI: the
 * GitHub (and Forgejo) run id, else the GitLab pipeline id. The same
 * precedence `resolveRunId` (../lifecycle/release-ledger.ts) uses for a
 * deploy record, so a gate and a deploy name the run alike.
 */
export function ciRunIdFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.GITHUB_RUN_ID || env.CI_PIPELINE_ID || undefined;
}

/** The commit the CI job was started for: `GITHUB_SHA` (GitHub and Forgejo) or `CI_COMMIT_SHA` (GitLab). Undefined outside CI. */
export function ciCommitFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.GITHUB_SHA || env.CI_COMMIT_SHA || undefined;
}
