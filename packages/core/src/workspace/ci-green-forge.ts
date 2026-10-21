/**
 * What `chant ci tick` asks of a forge (#3573, ws-103): every check run on a
 * commit, every attempt of each, so the tick can judge a phase by each run's
 * latest attempt.
 *
 * The tags themselves are git's, pushed to the remote like any other ref, so
 * the forge is asked for check runs and nothing else. GitHub is the one
 * forge implemented. Forgejo reports commit statuses rather than check runs,
 * and GitLab reports pipeline jobs, and neither gets a reader here (#4021): a
 * project on either runs its pipelines as chant Ops and sets
 * `ci.green.source` to `runs`, so the tick reads signed Op runs from the run
 * ledger instead (#4044, `./ci-green.ts`). `--forge` refuses them by name and
 * says so.
 *
 * The client takes a `fetch` like the pull-request loop's (`../pr-forge.ts`),
 * so the tests drive it with a recording fake and no network.
 */

import { ForgeApiError, ForgeEnvironmentError, type ForgeFetch, type ForgeKind } from "../pr-forge";
import type { OpRunRecord } from "../op/runtime";

/** One attempt of one check run on a commit. */
export interface CheckRun {
  /** The forge's id. A later attempt of the same check has a larger one. */
  id: number;
  name: string;
  /** `completed` once it has finished; `queued`, `in_progress`, `waiting`, `requested` or `pending` before. */
  status: string;
  /** Set once completed: `success`, `failure`, `skipped`, `cancelled`, `neutral`, `timed_out`, `action_required` or `stale`. */
  conclusion: string | null;
  completedAt: string | null;
  url: string | null;
  /**
   * Set when the "check run" is a chant Op run (#4044, `ci.green.source:
   * "runs"`): the run's id and env, and the runner whose statement it
   * carries with that statement, or a null signer for an unsigned run. `name` is then the Op's name and `id` the run's end
   * time in milliseconds, which orders a re-run after the run it replaced.
   */
  opRun?: OpRunRef;
  /** For a failed Op run, its record's `failure.code` (#4094), which a revoke note names. Absent otherwise. */
  failureCode?: string;
}

/** The Op run a {@link CheckRun} stands for (#4044). */
export interface OpRunRef {
  id: string;
  env: string;
  /** The runner whose statement the run carries, or null for an unsigned run, which counts unless `ci.green.signedSince` asks for one (#4156). */
  signer: string | null;
  /** The run's statement, when it has one. */
  statement?: NonNullable<OpRunRecord["statement"]>;
}

export interface CiForge {
  kind: ForgeKind;
  /** Every check run on `sha`, every attempt. */
  checkRuns(sha: string): Promise<CheckRun[]>;
  /**
   * Run a failed check run's job again (#4169), so a flake costs one more
   * run before the commit counts red: on GitHub, every failed job of its
   * workflow run, so the jobs an aggregate needs go again with it (#4219).
   * Absent on a forge chant can't ask.
   */
  rerun?(run: CheckRun): Promise<void>;
  /**
   * Start a workflow at a ref (#4169), for a build the tick asks for: a
   * bisect step, or `chant ci run --at`. `workflow` is the file's name in
   * `.github/workflows/`, and `ref` a branch or tag. Absent on a forge chant
   * can't ask.
   */
  dispatch?(workflow: string, ref: string): Promise<void>;
}

export interface GithubCiForgeOptions {
  /** `$GITHUB_API_URL`: `https://api.github.com` or `<host>/api/v3`. */
  apiBase: string;
  /** `owner/name`. */
  repo: string;
  token: string;
  fetch?: ForgeFetch;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A GitHub client (github.com or GitHub Enterprise Server) for check runs. The token needs `checks: read`. */
export function githubCiForge(opts: GithubCiForgeOptions): CiForge {
  const root = opts.apiBase.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  const headers = { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" };
  const rerunRuns = new Set<number>();
  return {
    kind: "github",
    async checkRuns(sha) {
      // filter=all: every attempt, not only the newest per suite, so a re-run's
      // own run is judged against the run it replaced by id.
      const out: CheckRun[] = [];
      for (let page = 1; page <= 50; page++) {
        const url = `${root}/repos/${opts.repo}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`;
        const res = await fetchImpl(url, { method: "GET", headers });
        const text = await res.text();
        if (!res.ok) throw new ForgeApiError("GET", url, res.status, text);
        const body: unknown = text ? JSON.parse(text) : null;
        const runs = isObject(body) && Array.isArray(body.check_runs) ? body.check_runs : [];
        for (const r of runs) {
          if (!isObject(r) || typeof r.id !== "number" || typeof r.name !== "string") continue;
          out.push({
            id: r.id,
            name: r.name,
            status: str(r.status) ?? "queued",
            conclusion: str(r.conclusion),
            completedAt: str(r.completed_at),
            url: str(r.html_url),
          });
        }
        const total = isObject(body) && typeof body.total_count === "number" ? body.total_count : 0;
        if (runs.length < 100 || out.length >= total) break;
      }
      return out;
    },
    // An Actions job's check run has the job's id. Re-running only that job
    // would re-run an aggregate such as `suites` against the shards' old
    // results, so the failed jobs of its workflow run go again together,
    // each run once per tick (#4219). Both calls need `actions: write`.
    async rerun(run) {
      const jobUrl = `${root}/repos/${opts.repo}/actions/jobs/${run.id}`;
      const res = await fetchImpl(jobUrl, { method: "GET", headers });
      const text = await res.text();
      if (!res.ok) throw new ForgeApiError("GET", jobUrl, res.status, text);
      const job: unknown = text ? JSON.parse(text) : null;
      const runId = isObject(job) && typeof job.run_id === "number" ? job.run_id : null;
      if (runId === null) {
        await post(`${jobUrl}/rerun`, {});
        return;
      }
      if (rerunRuns.has(runId)) return;
      rerunRuns.add(runId);
      await post(`${root}/repos/${opts.repo}/actions/runs/${runId}/rerun-failed-jobs`, {});
    },
    async dispatch(workflow, ref) {
      await post(`${root}/repos/${opts.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref });
    },
  };

  async function post(url: string, body: unknown): Promise<void> {
    const res = await fetchImpl(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new ForgeApiError("POST", url, res.status, await res.text());
  }
}

/** Thrown for a forge `chant ci tick` has no check-run client for yet. */
export class CiForgeUnsupportedError extends Error {
  constructor(kind: string) {
    super(
      `check runs are read from GitHub only, and --forge asked for ${kind}. A ${kind} project runs its pipelines as chant Ops and sets ci.green.source to "runs" (or passes --source runs), so the tick reads signed Op runs from chant/lifecycle instead`,
    );
    this.name = "CiForgeUnsupportedError";
  }
}

/**
 * A check-run client for `kind` from the CI job's environment: the token is
 * `CHANT_FORGE_TOKEN` when set, else `GITHUB_TOKEN` or `GH_TOKEN`, and the
 * repository is `GITHUB_REPOSITORY`.
 */
export function ciForgeFromEnv(kind: string = "github", env: Record<string, string | undefined> = process.env, fetchImpl?: ForgeFetch): CiForge {
  if (kind !== "github") throw new CiForgeUnsupportedError(kind);
  const token = env.CHANT_FORGE_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const missing = [...(env.GITHUB_REPOSITORY ? [] : ["GITHUB_REPOSITORY"]), ...(token ? [] : ["GITHUB_TOKEN or CHANT_FORGE_TOKEN"])];
  if (missing.length > 0) throw new ForgeEnvironmentError("github", missing);
  return githubCiForge({
    apiBase: env.GITHUB_API_URL ?? "https://api.github.com",
    repo: env.GITHUB_REPOSITORY!,
    token: token!,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
