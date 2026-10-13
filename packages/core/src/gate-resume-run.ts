/**
 * Resume the job that waits at a gate (#3683), bundle-safe (#3854).
 *
 * A CI job that reaches a gate nobody approved records a pending fact on
 * `chant/lifecycle` and exits 3. Nothing re-runs it when the approval lands,
 * because a push to the ledger branch starts no pipeline. This module closes
 * that loop through the forge's API.
 *
 * When the job runs in CI, the pending fact it records carries a
 * {@link GateRunLocator}, read from the job's environment by
 * {@link resolveGateRunLocator}: which forge, the API base, the repository,
 * the run, and what the forge needs to start it again. After an approval,
 * {@link resumeGateRun} starts it again:
 *
 * | Forge | Call | Token |
 * |---|---|---|
 * | GitHub | `POST /repos/{repo}/actions/runs/{run}/rerun-failed-jobs` | `actions: write` (the job's `GITHUB_TOKEN` with that permission, or a fine-grained token with Actions read and write) |
 * | GitLab | `POST /projects/{id}/jobs/{job}/retry` | a project or personal access token with the `api` scope and the Developer role; `CI_JOB_TOKEN` cannot retry jobs |
 * | Forgejo | `POST /repos/{repo}/actions/workflows/{file}/dispatches` on the run's branch | a token with the `write:repository` scope; Forgejo has no API to re-run a run, so it starts a new run of the workflow |
 *
 * GitHub re-runs the failed job and the jobs that need it, at the same
 * commit. GitLab retries the job, and the jobs it skipped run after it. A
 * Forgejo dispatch runs the whole workflow again at the branch's head, so the
 * jobs before the gate run again too; they must be safe to repeat (a wave
 * whose runs already applied plans nothing and applies nothing new).
 *
 * Resuming approves nothing. The resumed job decides the gate again from the
 * ledger, so resuming a run whose approval does not count only makes it wait
 * again. {@link resumeGateRun} skips a run that is still going, that ended
 * well, or that was already resumed (a later GitHub attempt, a newer GitLab
 * job of the same name, a newer Forgejo run of the workflow), so a scheduled
 * resume job can call it every few minutes without starting a run twice.
 *
 * This module imports no workspace, ledger, schema or git code, so a product
 * that ships one bundled file (terragucci) can import it as
 * `@intentius/chant/gate-resume-run` and resume a job in process. Which
 * approval answers a pending fact is `./op/gate-resume.ts`'s
 * `resolutionAnswering`, which reads the gate's quorum rules and does pull the
 * workspace in; that module re-exports everything here.
 */

import { ForgeApiError, type ForgeFetch, type ForgeKind } from "./pr-forge";
import type { GateRunLocator } from "./op/gate-run-locator";

export { isGateRunLocator, resolveGateRunLocator, type GateRunLocator } from "./op/gate-run-locator";

/** What {@link resumeGateRun} did. */
export type GateResumeOutcome =
  | { status: "resumed"; forge: ForgeKind; how: string; url?: string }
  | { status: "skipped"; forge: ForgeKind; reason: string; url?: string }
  /** Under `dryRun` (#3858): the run is gone and would be started again; nothing was started. */
  | { status: "would-resume"; forge: ForgeKind; how: string; url?: string };

export interface ResumeGateRunOptions {
  token: string;
  /** The approval's time. A Forgejo run of the workflow created after it means the run was already resumed. */
  since?: string;
  fetch?: ForgeFetch;
  /**
   * Read the run as a resume would, and start nothing (#3858): say
   * `would-resume` where it would start it. The calls are reads, so a token
   * with read access to the forge's runs is enough.
   */
  dryRun?: boolean;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function client(base: string, headers: Record<string, string>, fetchImpl: ForgeFetch) {
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = `${trimSlash(base)}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new ForgeApiError(method, url, res.status, text);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

/**
 * Start the job a pending fact's locator names again, or say why not. Throws
 * {@link ForgeApiError} when the forge refuses a call, such as a token
 * without the access the table in the module doc lists.
 */
export async function resumeGateRun(loc: GateRunLocator, opts: ResumeGateRunOptions): Promise<GateResumeOutcome> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  const url = loc.url ? { url: loc.url } : {};
  const skip = (reason: string): GateResumeOutcome => ({ status: "skipped", forge: loc.forge, reason, ...url });
  const wouldResume = (how: string): GateResumeOutcome => ({ status: "would-resume", forge: loc.forge, how: `would ${how}`, ...url });

  if (loc.forge === "github") {
    const call = client(loc.api, { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" }, fetchImpl);
    const path = `/repos/${loc.repo}/actions/runs/${loc.run}`;
    const run = await call("GET", path);
    if (!isObject(run)) throw new Error(`GET ${path} returned no run`);
    if (run.status !== "completed") return skip(`run ${loc.run} is ${String(run.status)}, not finished`);
    const attempt = typeof run.run_attempt === "number" ? run.run_attempt : undefined;
    if (loc.attempt !== undefined && attempt !== undefined && attempt > loc.attempt) {
      return skip(`run ${loc.run} was already re-run (attempt ${attempt}; attempt ${loc.attempt} waited)`);
    }
    if (run.conclusion === "success") return skip(`run ${loc.run} succeeded`);
    if (opts.dryRun) return wouldResume(`re-run the failed jobs of run ${loc.run}`);
    await call("POST", `${path}/rerun-failed-jobs`, {});
    return { status: "resumed", forge: "github", how: `re-ran the failed jobs of run ${loc.run}`, ...url };
  }

  if (loc.forge === "gitlab") {
    const call = client(loc.api, { "PRIVATE-TOKEN": opts.token }, fetchImpl);
    const project = `/projects/${encodeURIComponent(decodeURIComponent(loc.repo))}`;
    const job = await call("GET", `${project}/jobs/${loc.job}`);
    if (!isObject(job)) throw new Error(`GET ${project}/jobs/${loc.job} returned no job`);
    const status = String(job.status);
    if (status === "success") return skip(`job ${loc.job} succeeded`);
    if (!["failed", "canceled", "skipped"].includes(status)) return skip(`job ${loc.job} is ${status}, not finished`);
    const name = loc.jobName ?? (typeof job.name === "string" ? job.name : undefined);
    if (name) {
      // The pipeline's jobs list leaves retried jobs out, so the job of this name is its newest try.
      const jobs = await call("GET", `${project}/pipelines/${loc.run}/jobs?per_page=100`);
      const newest = Array.isArray(jobs) ? jobs.find((j) => isObject(j) && j.name === name) : undefined;
      if (isObject(newest) && String(newest.id) !== String(loc.job)) {
        return skip(`job ${loc.job} (${name}) was already retried as job ${String(newest.id)}`);
      }
    }
    if (opts.dryRun) return wouldResume(`retry job ${loc.job}`);
    const retried = await call("POST", `${project}/jobs/${loc.job}/retry`);
    const id = isObject(retried) && retried.id !== undefined ? ` as job ${String(retried.id)}` : "";
    return { status: "resumed", forge: "gitlab", how: `retried job ${loc.job}${id}`, ...url };
  }

  const call = client(loc.api, { Authorization: `token ${opts.token}`, Accept: "application/json" }, fetchImpl);
  const repo = `/repos/${loc.repo}`;
  const run = await call("GET", `${repo}/actions/runs/${loc.run}`);
  if (!isObject(run)) throw new Error(`GET ${repo}/actions/runs/${loc.run} returned no run`);
  const status = String(run.status);
  if (status === "success") return skip(`run ${loc.run} succeeded`);
  if (["waiting", "running", "blocked", "unknown"].includes(status)) return skip(`run ${loc.run} is ${status}, not finished`);
  const listed = await call("GET", `${repo}/actions/runs?workflow_id=${encodeURIComponent(loc.workflow!)}&limit=50`);
  const runs = isObject(listed) && Array.isArray(listed.workflow_runs) ? listed.workflow_runs : Array.isArray(listed) ? listed : [];
  // Forgejo reports `created` in whole seconds.
  const since = opts.since ? Math.floor(new Date(opts.since).getTime() / 1000) * 1000 : undefined;
  const later = runs.find(
    (r) =>
      isObject(r) && Number(r.id) > Number(loc.run) &&
      (r.prettyref === undefined || r.prettyref === loc.ref) &&
      (since === undefined || (typeof r.created === "string" && new Date(r.created).getTime() >= since)),
  );
  if (isObject(later)) return skip(`run ${String(later.id)} of ${loc.workflow} started after the approval`);
  if (opts.dryRun) return wouldResume(`dispatch ${loc.workflow} on ${loc.ref}`);
  await call("POST", `${repo}/actions/workflows/${encodeURIComponent(loc.workflow!)}/dispatches`, { ref: loc.ref });
  return { status: "resumed", forge: "forgejo", how: `dispatched ${loc.workflow} on ${loc.ref}`, ...url };
}

/**
 * The token a resume uses: `CHANT_FORGE_TOKEN`, else the forge's own
 * (`GITHUB_TOKEN` or `GH_TOKEN` on GitHub and Forgejo, `GITLAB_TOKEN` on
 * GitLab), the same order the pull-request loop reads (`../pr-forge.ts`).
 */
export function resumeTokenFromEnv(forge: ForgeKind, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.CHANT_FORGE_TOKEN) return env.CHANT_FORGE_TOKEN;
  return forge === "gitlab" ? env.GITLAB_TOKEN : env.GITHUB_TOKEN ?? env.GH_TOKEN;
}
