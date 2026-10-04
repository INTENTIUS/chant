/**
 * What the pull-request loop (#3183) asks of a forge: keep one note on the
 * pull request up to date, set a commit status per stage, list who approved
 * the pull request, and find the pull request that merged a commit.
 *
 * GitHub and Forgejo speak the same REST shapes for the first three, at
 * different base URLs (`$GITHUB_API_URL` is right on both, #2305); they part
 * on the commit-to-pull-request lookup and on review states. GitLab has its
 * own API for all four. Each client takes a `fetch`, so the tests drive them
 * with a recording fake and no network.
 *
 * A reviewer is named the way #3163 names a person: `github:<login>`,
 * `gitlab:<login>`, or `<forge>@<host>:<login>` off the forge's default host.
 * The apply compares that string with the approval's `resolvedBy`.
 *
 * Like `./pr-loop.ts`, this bundles without the TypeScript toolchain (#3421):
 * it imports nothing.
 */

export type ForgeKind = "github" | "gitlab" | "forgejo";

export const FORGE_KINDS: readonly ForgeKind[] = ["github", "gitlab", "forgejo"];

/** The subset of the WHATWG `fetch` the clients use. */
export type ForgeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ForgeStatus {
  /** `chant/plan` or `chant/apply`. */
  context: string;
  state: "pending" | "success" | "failure";
  description: string;
  /** The pipeline run, linked from the status. */
  url?: string;
}

export interface PrForge {
  kind: ForgeKind;
  /** Lower-cased, such as `github.com`. */
  host: string;
  /** The URL of the run this process is part of, when the environment says. */
  runUrl?: string;
  /** How #3163 names `login` on this forge. */
  principalOf(login: string): string;
  /** Update the note on `pr` whose body starts with `marker`, or add one. */
  upsertNote(pr: number, marker: string, body: string): Promise<void>;
  setStatus(sha: string, status: ForgeStatus): Promise<void>;
  /** Logins whose standing review approves `pr`. */
  approvers(pr: number): Promise<string[]>;
  /** The merged pull request that produced `sha`, or null. */
  pullRequestFor(sha: string): Promise<number | null>;
}

/** Thrown when a forge answers a call with an error status. */
export class ForgeApiError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${method} ${url} answered ${status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    this.name = "ForgeApiError";
  }
}

const DEFAULT_HOST: Record<ForgeKind, string | null> = { github: "github.com", gitlab: "gitlab.com", forgejo: null };

/** `<forge>:<login>` on the forge's default host, `<forge>@<host>:<login>` elsewhere, lower-cased (#3163's form). */
export function forgePrincipalOf(kind: ForgeKind, host: string, login: string): string {
  const h = host.toLowerCase();
  const l = login.toLowerCase();
  return h === DEFAULT_HOST[kind] ? `${kind}:${l}` : `${kind}@${h}:${l}`;
}

interface Transport {
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Every page of a list, `pageParams(page)` appended to `path`. */
  list(path: string, pageParams: (page: number) => string, pageSize: number): Promise<unknown[]>;
}

function transport(base: string, headers: Record<string, string>, fetchImpl: ForgeFetch): Transport {
  const root = base.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = `${root}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new ForgeApiError(method, url, res.status, text);
    return text ? JSON.parse(text) : null;
  };
  return {
    call,
    async list(path, pageParams, pageSize) {
      const out: unknown[] = [];
      for (let page = 1; page <= 50; page++) {
        const sep = path.includes("?") ? "&" : "?";
        const items = await call("GET", `${path}${sep}${pageParams(page)}`);
        if (!Array.isArray(items)) break;
        out.push(...items);
        if (items.length < pageSize) break;
      }
      return out;
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const loginOf = (v: unknown): string | undefined => (isObject(v) && isObject(v.user) && typeof v.user.login === "string" ? v.user.login : undefined);

export interface GithubForgeOptions {
  /** `$GITHUB_API_URL`: `https://api.github.com`, `<host>/api/v3`, or Forgejo's `<host>/api/v1`. */
  apiBase: string;
  /** `owner/name`. */
  repo: string;
  token: string;
  /** The forge's host, for naming reviewers. Default github.com. */
  host?: string;
  runUrl?: string;
  fetch?: ForgeFetch;
}

/** Which of the two GitHub-shaped forges a client is talking to. */
function githubShaped(kind: "github" | "forgejo", opts: GithubForgeOptions): PrForge {
  const host = (opts.host ?? "github.com").toLowerCase();
  const api = transport(
    opts.apiBase,
    kind === "github"
      ? { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" }
      : { Authorization: `token ${opts.token}`, Accept: "application/json" },
    opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch),
  );
  const repo = `/repos/${opts.repo}`;
  // GitHub pages with per_page (up to 100); Forgejo with limit (capped at 50 by default).
  const pageSize = kind === "github" ? 100 : 50;
  const pageParams = (page: number) => (kind === "github" ? `per_page=100&page=${page}` : `limit=50&page=${page}`);
  return {
    kind,
    host,
    ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    principalOf: (login) => forgePrincipalOf(kind, host, login),
    async upsertNote(pr, marker, body) {
      const comments = await api.list(`${repo}/issues/${pr}/comments`, pageParams, pageSize);
      const mine = comments.find((c) => isObject(c) && typeof c.body === "string" && c.body.startsWith(marker));
      if (isObject(mine) && (typeof mine.id === "number" || typeof mine.id === "string")) {
        await api.call("PATCH", `${repo}/issues/comments/${mine.id}`, { body });
      } else {
        await api.call("POST", `${repo}/issues/${pr}/comments`, { body });
      }
    },
    async setStatus(sha, status) {
      await api.call("POST", `${repo}/statuses/${sha}`, {
        state: status.state,
        context: status.context,
        description: status.description,
        ...(status.url ? { target_url: status.url } : {}),
      });
    },
    async approvers(pr) {
      // A reviewer's newest deciding review is their standing one. A comment
      // review decides nothing; a dismissed one (GitHub's state, Forgejo's
      // flag) no longer approves.
      const reviews = await api.list(`${repo}/pulls/${pr}/reviews`, pageParams, pageSize);
      const standing = new Map<string, string>();
      for (const r of reviews) {
        const login = loginOf(r);
        if (!login || !isObject(r) || typeof r.state !== "string") continue;
        const state = r.dismissed === true ? "DISMISSED" : r.state.toUpperCase();
        if (state === "COMMENTED" || state === "COMMENT" || state === "PENDING") continue;
        standing.set(login, state);
      }
      return [...standing].filter(([, state]) => state === "APPROVED").map(([login]) => login).sort();
    },
    async pullRequestFor(sha) {
      if (kind === "forgejo") {
        try {
          const pr = await api.call("GET", `${repo}/commits/${sha}/pull`);
          return isObject(pr) && typeof pr.number === "number" ? pr.number : null;
        } catch (err) {
          if (err instanceof ForgeApiError && err.status === 404) return null;
          throw err;
        }
      }
      const prs = await api.call("GET", `${repo}/commits/${sha}/pulls`);
      if (!Array.isArray(prs)) return null;
      const merged = prs.filter((p) => isObject(p) && p.merged_at);
      const exact = merged.find((p) => isObject(p) && p.merge_commit_sha === sha);
      const pick = (exact ?? merged[0]) as Record<string, unknown> | undefined;
      return pick && typeof pick.number === "number" ? pick.number : null;
    },
  };
}

/** A GitHub client (github.com or GitHub Enterprise Server). */
export function githubForge(opts: GithubForgeOptions): PrForge {
  return githubShaped("github", opts);
}

/** A Forgejo (or Gitea) client. `host` is required: Forgejo has no default host. */
export function forgejoForge(opts: GithubForgeOptions & { host: string }): PrForge {
  return githubShaped("forgejo", opts);
}

export interface GitlabForgeOptions {
  /** `$CI_API_V4_URL`. */
  apiBase: string;
  /** `$CI_PROJECT_ID`, or the URL-encoded path. */
  project: string;
  token: string;
  /** Default gitlab.com. */
  host?: string;
  runUrl?: string;
  fetch?: ForgeFetch;
}

const GITLAB_STATE: Record<ForgeStatus["state"], string> = { pending: "pending", success: "success", failure: "failed" };

/** A GitLab client. The token needs the `api` scope: a job token cannot write merge-request notes. */
export function gitlabForge(opts: GitlabForgeOptions): PrForge {
  const host = (opts.host ?? "gitlab.com").toLowerCase();
  const api = transport(opts.apiBase, { "PRIVATE-TOKEN": opts.token }, opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch));
  const project = `/projects/${encodeURIComponent(decodeURIComponent(opts.project))}`;
  const pageParams = (page: number) => `per_page=100&page=${page}`;
  return {
    kind: "gitlab",
    host,
    ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    principalOf: (login) => forgePrincipalOf("gitlab", host, login),
    async upsertNote(mr, marker, body) {
      const notes = await api.list(`${project}/merge_requests/${mr}/notes`, pageParams, 100);
      const mine = notes.find((n) => isObject(n) && typeof n.body === "string" && n.body.startsWith(marker));
      if (isObject(mine) && typeof mine.id === "number") {
        await api.call("PUT", `${project}/merge_requests/${mr}/notes/${mine.id}`, { body });
      } else {
        await api.call("POST", `${project}/merge_requests/${mr}/notes`, { body });
      }
    },
    async setStatus(sha, status) {
      await api.call("POST", `${project}/statuses/${sha}`, {
        state: GITLAB_STATE[status.state],
        name: status.context,
        description: status.description,
        ...(status.url ? { target_url: status.url } : {}),
      });
    },
    async approvers(mr) {
      const approvals = await api.call("GET", `${project}/merge_requests/${mr}/approvals`);
      const by = isObject(approvals) && Array.isArray(approvals.approved_by) ? approvals.approved_by : [];
      const logins = by
        .map((a) => (isObject(a) && isObject(a.user) && typeof a.user.username === "string" ? a.user.username : undefined))
        .filter((l): l is string => l !== undefined);
      return [...new Set(logins)].sort();
    },
    async pullRequestFor(sha) {
      const mrs = await api.call("GET", `${project}/repository/commits/${sha}/merge_requests`);
      if (!Array.isArray(mrs)) return null;
      const merged = mrs.find((m) => isObject(m) && m.state === "merged" && (m.merge_commit_sha === sha || m.squash_commit_sha === sha))
        ?? mrs.find((m) => isObject(m) && m.state === "merged");
      return isObject(merged) && typeof merged.iid === "number" ? merged.iid : null;
    },
  };
}

/** Thrown when the environment lacks what a forge client needs. */
export class ForgeEnvironmentError extends Error {
  constructor(kind: ForgeKind, missing: string[]) {
    super(`--forge ${kind} needs ${missing.join(", ")} in the environment`);
    this.name = "ForgeEnvironmentError";
  }
}

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * A client for `kind` from the CI job's environment. The token is
 * `CHANT_FORGE_TOKEN` when set, else the forge's own: `GITHUB_TOKEN` (also
 * set on Forgejo Actions) or `GITLAB_TOKEN`. GitLab's `CI_JOB_TOKEN` cannot
 * write notes, so a GitLab pipeline names a project access token.
 */
export function forgeFromEnv(kind: ForgeKind, env: Record<string, string | undefined> = process.env, fetchImpl?: ForgeFetch): PrForge {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (kind === "gitlab") {
    const token = env.CHANT_FORGE_TOKEN ?? env.GITLAB_TOKEN;
    const missing = [
      ...(env.CI_API_V4_URL ? [] : ["CI_API_V4_URL"]),
      ...(env.CI_PROJECT_ID ? [] : ["CI_PROJECT_ID"]),
      ...(token ? [] : ["CHANT_FORGE_TOKEN (a token with the api scope)"]),
    ];
    if (missing.length > 0) throw new ForgeEnvironmentError(kind, missing);
    return gitlabForge({
      apiBase: env.CI_API_V4_URL!,
      project: env.CI_PROJECT_ID!,
      token: token!,
      host: env.CI_SERVER_HOST ?? hostOf(env.CI_SERVER_URL) ?? "gitlab.com",
      ...(env.CI_PIPELINE_URL ? { runUrl: env.CI_PIPELINE_URL } : {}),
      ...f,
    });
  }
  const token = env.CHANT_FORGE_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const host = hostOf(env.GITHUB_SERVER_URL);
  const missing = [
    ...(env.GITHUB_REPOSITORY ? [] : ["GITHUB_REPOSITORY"]),
    ...(token ? [] : ["GITHUB_TOKEN or CHANT_FORGE_TOKEN"]),
    ...(kind === "forgejo" && !host ? ["GITHUB_SERVER_URL"] : []),
    ...(kind === "forgejo" && !env.GITHUB_API_URL ? ["GITHUB_API_URL"] : []),
  ];
  if (missing.length > 0) throw new ForgeEnvironmentError(kind, missing);
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL.replace(/\/+$/, "")}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const opts = {
    apiBase: env.GITHUB_API_URL ?? "https://api.github.com",
    repo: env.GITHUB_REPOSITORY!,
    token: token!,
    ...(runUrl ? { runUrl } : {}),
    ...f,
  };
  return kind === "forgejo" ? forgejoForge({ ...opts, host: host! }) : githubForge({ ...opts, host: host ?? "github.com" });
}
