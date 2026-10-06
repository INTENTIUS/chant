/**
 * What `chant ci tick` asks of a forge (#3573, ws-103): every check run on a
 * commit, every attempt of each, so the tick can judge a phase by each run's
 * latest attempt.
 *
 * The tags themselves are git's, pushed to the remote like any other ref, so
 * the forge is asked for check runs and nothing else. GitHub is the one
 * forge implemented. Forgejo reports commit statuses rather than check runs,
 * and GitLab reports pipeline jobs; each can implement {@link CiForge} by
 * mapping those to {@link CheckRun}s, and until one does `--forge` refuses
 * them by name.
 *
 * The client takes a `fetch` like the pull-request loop's (`../pr-forge.ts`),
 * so the tests drive it with a recording fake and no network.
 */

import { ForgeApiError, ForgeEnvironmentError, type ForgeFetch, type ForgeKind } from "../pr-forge";

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
}

export interface CiForge {
  kind: ForgeKind;
  /** Every check run on `sha`, every attempt. */
  checkRuns(sha: string): Promise<CheckRun[]>;
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
  };
}

/** Thrown for a forge `chant ci tick` has no check-run client for yet. */
export class CiForgeUnsupportedError extends Error {
  constructor(kind: string) {
    super(`check runs are read from GitHub only so far, and --forge asked for ${kind}; see #3573`);
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
