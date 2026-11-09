/**
 * Reads a product asks of a forge beside the ones `./pr-forge.ts` makes
 * (#4809): the user the token acts as, a pull request with its author, URL,
 * state and merge commit, the pull requests from a branch (or a branch
 * prefix) in any state, every note on a pull request, GitHub's check runs on
 * a commit, a pull request's commits, a collaborator's permission level, and
 * every open pull request in the repository; and a head's workflow runs
 * (GitLab's pipelines), a run, its jobs, and the artifacts it kept, by name in
 * a run or across the repository, as a product's review agent reads them
 * (#4846); the files a head changes since its merge base, a job by id, and
 * a file of a GitLab job's artifacts (#4862).
 *
 * They take the same options as the clients in `./pr-forge.ts` and live in
 * their own module, imported only by the products that call them, so the
 * pull-request loop's and the review agent's bundles do not grow for them
 * (`./pr-forge-bundle.test.ts`, `./pr-loop-bundle.test.ts`,
 * `./review-agent-bundle.test.ts`).
 */

import {
  ForgeApiError,
  type ForgeFetch,
  type ForgeKind,
  type ForgeTarget,
  type GithubForgeOptions,
  type GitlabForgeOptions,
  type OpenPullRequest,
} from "./pr-forge";

/** The user a token acts as: GitHub's and Forgejo's `login`, GitLab's `username`, and the forge's numeric id. */
export interface ForgeUser {
  login: string;
  id?: number;
}

/** A pull request (merge request) as {@link ForgeReads.pullRequest} reads it. */
export interface PullRequestDetail {
  /** The pull request's number, or the merge request's iid. */
  number: number;
  url?: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  /** Its head (source) branch. */
  head: string;
  /** The commit its head points at. */
  headSha?: string;
  /** Its base (target) branch. */
  base?: string;
  /** Who opened it. */
  author?: string;
  /** Its head branch lives in this repository, not a fork. */
  sameRepo: boolean;
  /**
   * Once merged, the commit the merge made on the base branch: the merge or
   * squash commit, or on GitLab the head itself after a fast-forward merge.
   */
  mergeCommit?: string;
  /** When it last changed (ISO 8601). */
  updated?: string;
}

/** A comment (note) on a pull request, as {@link ForgeReads.pullRequestNotes} reads it. */
export interface PullRequestNote {
  id: number;
  body: string;
  author?: string;
  /** The author's numeric id. */
  authorId?: number;
  /** GitLab's own note ("approved this merge request", "added 1 commit"). Always false on GitHub and Forgejo. */
  system: boolean;
  created?: string;
}

/** A GitHub check run on a commit. */
export interface CheckRun {
  id: number;
  name: string;
  /** `queued`, `in_progress` or `completed`, and GitHub's other words for a run not done. */
  status: string;
  /** Once completed: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `stale`. */
  conclusion?: string;
}

/** A person on a commit, as the forge records it. `login` only when the forge ties the address to an account (GitHub, Forgejo). */
export interface CommitPerson {
  name?: string;
  email?: string;
  login?: string;
}

/** One of a pull request's commits. */
export interface PullRequestCommit {
  sha: string;
  message: string;
  author: CommitPerson;
  committer: CommitPerson;
}

/** What {@link ForgeReads.pullRequestsFrom} reads. */
export interface PullRequestsFromOptions {
  /** Take every head branch that starts with the branch given, not only that branch. */
  prefix?: boolean;
  /** At most this many pull requests are read, newest update first. Default 500. */
  limit?: number;
}

/**
 * A workflow run (#4846): a GitHub or Forgejo Actions run, or a GitLab
 * pipeline.
 */
export interface WorkflowRun {
  id: number;
  /**
   * The event that started it. GitHub's `event`. Forgejo's `trigger_event`,
   * the workflow's own trigger: Forgejo lists a `pull_request_target` run
   * with `event: pull_request`, which is {@link listedEvent}. GitLab's
   * `source` (`merge_request_event`, `push`, `schedule`, `api`, ...).
   */
  event: string;
  /** The event as the forge lists it, when that differs from {@link event} (Forgejo's `event` beside its `trigger_event`). */
  listedEvent?: string;
  /** The workflow's file name, such as `pipeline.yml`: the last part of GitHub's `path`, Forgejo's `workflow_id`. GitLab has none. */
  workflow?: string;
  /** GitHub's workflow path without its `@ref`, such as `.github/workflows/pipeline.yml`. */
  path?: string;
  /** The commit it ran on. */
  headSha: string;
  /** The branch it ran on (GitLab's `ref`, which for a merge request pipeline is `refs/merge-requests/<iid>/head`). */
  headBranch?: string;
  /** The repository its head is in, as `owner/name` (GitHub's `head_repository`), when the forge names it. */
  headRepo?: string;
  /** The forge's word for where it is: GitHub's `queued`, `in_progress`, `completed`; Forgejo's and GitLab's `running`, `success`, `failure` or `failed`, ... */
  status: string;
  /** GitHub's conclusion once completed. */
  conclusion?: string;
  /** It finished, whatever its outcome. */
  done: boolean;
  /**
   * The pull requests the run names: GitHub's `pull_requests`, the
   * `pull_request` of Forgejo's `event_payload`, GitLab's merge request when
   * the pipeline is one's. `base` is the base branch the event named.
   */
  pullRequests: { number: number; head?: string; headSha?: string; base?: string }[];
  url?: string;
}

/** One of a run's jobs. */
export interface RunJob {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  done: boolean;
  /** The run (pipeline) it belongs to, when the forge names it (#4862). */
  run?: number;
  /** The branch or ref it ran on: GitHub's and Forgejo's `head_branch`, GitLab's `ref`. */
  ref?: string;
  /** GitLab only: true when it ran for a tag. */
  tag?: boolean;
  /** The job's page on the forge. */
  url?: string;
}

/** A file a comparison changes, with the path it had before a rename when the forge names it (#4862). */
export interface ChangedFile {
  path: string;
  previousPath?: string;
}

/** What {@link ForgeReads.compare} reads. */
export interface Comparison {
  files: ChangedFile[];
  /**
   * True when the forge may have left files out: GitHub lists at most 300,
   * Forgejo listed fewer commits than it counts or a commit without its
   * files, GitLab's compare timed out.
   */
  truncated: boolean;
}

/**
 * An artifact a run kept, not expired. On GitLab, a job's artifacts archive:
 * `id` is the job's id and `name` its name.
 */
export interface RunArtifact {
  id: number;
  name: string;
  /** The run that kept it, when the forge names it. */
  run?: number;
  /** The commit that run ran on, when the forge names it. */
  headSha?: string;
  size?: number;
}

/** What {@link ForgeReads.headRuns} reads. */
export interface HeadRunsOptions {
  /** Only runs of this event (GitHub's and Forgejo's `event`, GitLab's `source`). */
  event?: string;
  /** At most this many runs. Default 100. */
  limit?: number;
}

/** What {@link ForgeReads.branchRuns} reads. */
export interface BranchRunsOptions {
  /** Only runs of this event (GitHub's and Forgejo's `event`, GitLab's `source`). */
  event?: string;
  /** At most this many runs. Default 100. */
  limit?: number;
}

/** What {@link ForgeReads.pullRequestsUpdated} reads. */
export interface PullRequestsUpdatedOptions {
  /** At most this many pull requests. Default 500. */
  limit?: number;
}

/** What {@link ForgeReads.artifacts} reads. */
export interface ArtifactsOptions {
  /** Only the artifacts this run (pipeline) kept. Without it, the repository's. */
  run?: number;
  /** At most this many artifacts. Default 100. */
  limit?: number;
}

/** The reads, for GitHub, Forgejo and GitLab alike. */
export interface ForgeReads {
  kind: ForgeKind;
  /** The user the client's token acts as (`GET /user`). Undefined when the forge names none. */
  tokenUser(): Promise<ForgeUser | undefined>;
  /** A pull request in any state, or undefined when the forge has none by that number. */
  pullRequest(pr: number): Promise<PullRequestDetail | undefined>;
  /**
   * The pull requests in any state whose head is `branch` (with `prefix`,
   * whose head starts with it), from this repository, newest first by number.
   */
  pullRequestsFrom(branch: string, opts?: PullRequestsFromOptions): Promise<PullRequestDetail[]>;
  /** Every comment on a pull request, GitLab's system notes among them, oldest first. */
  pullRequestNotes(pr: number): Promise<PullRequestNote[]>;
  /** GitHub's check runs on `sha`, the newest per name. Forgejo and GitLab have none and answer `[]`. */
  checkRuns(sha: string): Promise<CheckRun[]>;
  /** A pull request's commits, in the order the forge lists them. */
  pullRequestCommits(pr: number): Promise<PullRequestCommit[]>;
  /**
   * The permission `login` holds on the repository: GitHub's `admin`,
   * `maintain`, `write`, `triage`, `read` or `none`; Forgejo's `owner`,
   * `admin`, `write`, `read` or `none`; GitLab's `guest`, `reporter`,
   * `developer`, `maintainer` or `owner` (project or inherited). Undefined
   * when the forge knows no such user or member.
   */
  permission(login: string): Promise<string | undefined>;
  /** Every open pull request in the repository, into any base, ascending by number. */
  openPullRequests(): Promise<OpenPullRequest[]>;
  /** The workflow runs (GitLab's pipelines) on commit `sha`, newest first (#4846). */
  headRuns(sha: string, opts?: HeadRunsOptions): Promise<WorkflowRun[]>;
  /** The workflow runs (GitLab's pipelines) on branch `branch`, newest first (#4785). */
  branchRuns(branch: string, opts?: BranchRunsOptions): Promise<WorkflowRun[]>;
  /**
   * The pull requests in any state updated at or after `since` (ISO 8601),
   * forks' among them, newest update first (#4785): what a poll of comment
   * commands reads.
   */
  pullRequestsUpdated(since: string, opts?: PullRequestsUpdatedOptions): Promise<PullRequestDetail[]>;
  /** A workflow run (pipeline), or undefined when the forge has none by that id. */
  run(id: number): Promise<WorkflowRun | undefined>;
  /** A run's jobs, in the order the forge lists them. */
  runJobs(run: number): Promise<RunJob[]>;
  /** The artifacts named `name` that are not expired, in a run or across the repository, newest first. */
  artifacts(name: string, opts?: ArtifactsOptions): Promise<RunArtifact[]>;
  /**
   * The files `head` changes since its merge base with `base` (#4862):
   * GitHub's and Forgejo's `compare/<base>...<head>`, GitLab's
   * `repository/compare` with `straight=false`. Forgejo names each commit's
   * files, without a rename's old path, so a file a later commit changes
   * back is still listed.
   */
  compare(base: string, head: string): Promise<Comparison>;
  /** A job by id, or undefined when the forge has none by that id (#4862). */
  job(id: number): Promise<RunJob | undefined>;
  /**
   * GitLab only: one file of a job's artifacts, as text, or undefined when
   * the job kept no such file (#4862). GitHub and Forgejo hand an artifact
   * out as one archive.
   */
  artifactFile?(job: number, path: string): Promise<string | undefined>;
}

interface Get {
  (path: string): Promise<unknown>;
  /** Pages of a list until one comes back short, at most `max` items. */
  list(path: string, max?: number): Promise<unknown[]>;
  /** The body as text, or undefined on a 404. */
  text(path: string): Promise<string | undefined>;
}

function getter(base: string, headers: Record<string, string>, fetchImpl: ForgeFetch, pageSize: number, pageParams: (page: number) => string): Get {
  const root = base.replace(/\/+$/, "");
  const get = (async (path: string) => {
    const url = `${root}${path}`;
    const res = await fetchImpl(url, { method: "GET", headers });
    const text = await res.text();
    if (!res.ok) throw new ForgeApiError("GET", url, res.status, text);
    return text ? JSON.parse(text) : null;
  }) as Get;
  get.list = async (path, max = 50 * pageSize) => {
    const out: unknown[] = [];
    for (let page = 1; out.length < max; page++) {
      const items = await get(`${path}${path.includes("?") ? "&" : "?"}${pageParams(page)}`);
      if (!Array.isArray(items)) break;
      out.push(...items);
      if (items.length < pageSize) break;
    }
    return out.slice(0, max);
  };
  get.text = async (path) => {
    const url = `${root}${path}`;
    const res = await fetchImpl(url, { method: "GET", headers });
    const text = await res.text();
    if (res.status === 404) return undefined;
    if (!res.ok) throw new ForgeApiError("GET", url, res.status, text);
    return text;
  };
  return get;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const notFound = (err: unknown): boolean => err instanceof ForgeApiError && err.status === 404;
const newestFirst = (a: { number: number }, b: { number: number }): number => b.number - a.number;
const defined = <T>(v: T | undefined): v is T => v !== undefined;
const person = (name: unknown, email: unknown, login?: unknown): CommitPerson => {
  const n = str(name);
  const e = str(email);
  const l = str(login);
  return { ...(n ? { name: n } : {}), ...(e ? { email: e } : {}), ...(l ? { login: l } : {}) };
};
const userOf = (v: unknown, field: "login" | "username"): ForgeUser | undefined => {
  const login = isObject(v) ? str(v[field]) : undefined;
  const id = isObject(v) ? num(v.id) : undefined;
  return login ? { login, ...(id !== undefined ? { id } : {}) } : undefined;
};
const orUndefined = async <T>(read: Promise<T>): Promise<T | undefined> => {
  try {
    return await read;
  } catch (err) {
    if (notFound(err)) return undefined;
    throw err;
  }
};
const DEFAULT_LIMIT = 500;
const RUN_LIMIT = 100;
const byIdDesc = (a: { id: number }, b: { id: number }): number => b.id - a.id;
/** Forgejo's and GitLab's words for a run or job that is over. GitHub says `completed`. */
const OVER = new Set(["completed", "success", "failure", "failed", "cancelled", "canceled", "skipped"]);

/** Pages of a list the forge wraps in an object (`{ total_count, workflow_runs }`), or answers bare, until a page comes back short. */
async function listIn(get: Get, path: string, field: string, pageSize: number, pageParams: (page: number) => string, max: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= 50 && out.length < max; page++) {
    const got = await get(`${path}${path.includes("?") ? "&" : "?"}${pageParams(page)}`);
    const items = (Array.isArray(got) ? got : isObject(got) && Array.isArray(got[field]) ? got[field] : []).filter(isObject);
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out.slice(0, max);
}

function githubShapedReads(kind: "github" | "forgejo", opts: GithubForgeOptions): ForgeReads {
  const headers =
    kind === "github"
      ? { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), Accept: "application/vnd.github+json" }
      : { ...(opts.token ? { Authorization: `token ${opts.token}` } : {}), Accept: "application/json" };
  // GitHub pages with per_page (up to 100); Forgejo with limit (capped at 50 by default).
  const pageSize = kind === "github" ? 100 : 50;
  const get = getter(opts.apiBase, headers, opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch), pageSize, (page) => (kind === "github" ? `per_page=100&page=${page}` : `limit=50&page=${page}`));
  const repo = `/repos/${opts.repo}`;
  const sameRepo = (v: Record<string, unknown>): boolean => {
    const full = isObject(v.head) && isObject(v.head.repo) ? str(v.head.repo.full_name) : undefined;
    return full === undefined || full.toLowerCase() === opts.repo.toLowerCase();
  };
  const detail = (v: unknown): PullRequestDetail | undefined => {
    if (!isObject(v)) return undefined;
    const number = num(v.number);
    if (number === undefined) return undefined;
    const head = isObject(v.head) ? v.head : {};
    const merged = v.merged === true || !!str(v.merged_at);
    const mergeCommit = merged ? str(v.merge_commit_sha) : undefined;
    const fields = {
      url: str(v.html_url),
      headSha: str(head.sha),
      base: isObject(v.base) ? str(v.base.ref) : undefined,
      author: isObject(v.user) ? str(v.user.login) : undefined,
      mergeCommit,
      updated: str(v.updated_at),
    };
    const out: PullRequestDetail = { number, title: str(v.title) ?? "", body: str(v.body) ?? "", state: merged ? "merged" : v.state === "open" ? "open" : "closed", head: str(head.ref) ?? "", sameRepo: sameRepo(v) };
    for (const [k, val] of Object.entries(fields)) if (val !== undefined) (out as unknown as Record<string, unknown>)[k] = val;
    return out;
  };
  const pageParams = (page: number): string => (kind === "github" ? `per_page=100&page=${page}` : `limit=50&page=${page}`);
  const runOf = (v: unknown): WorkflowRun | undefined => {
    if (!isObject(v)) return undefined;
    const id = num(v.id);
    const headSha = str(v.head_sha) ?? str(v.commit_sha);
    if (id === undefined || !headSha) return undefined;
    const listed = str(v.event) ?? "";
    const event = str(v.trigger_event) ?? listed;
    const path = str(v.path)?.replace(/@.*$/, "");
    const workflow = str(v.workflow_id) ?? path?.split("/").pop();
    const status = str(v.status) ?? "";
    const conclusion = str(v.conclusion);
    const headRepo = isObject(v.head_repository) ? str(v.head_repository.full_name) : undefined;
    const pullRequests: WorkflowRun["pullRequests"] = [];
    for (const p of Array.isArray(v.pull_requests) ? v.pull_requests.filter(isObject) : []) {
      const number = num(p.number);
      if (number === undefined) continue;
      const head = isObject(p.head) ? p.head : {};
      const fields = { head: str(head.ref), headSha: str(head.sha), base: isObject(p.base) ? str(p.base.ref) : undefined };
      pullRequests.push({ number, ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)) });
    }
    // Forgejo names the event's pull request only in the payload it keeps as a string.
    let payload: unknown = v.event_payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = undefined;
      }
    }
    const pull = isObject(payload) && isObject(payload.pull_request) ? payload.pull_request : undefined;
    const number = pull ? num(pull.number) : undefined;
    if (pull && number !== undefined && !pullRequests.some((p) => p.number === number)) {
      const head = isObject(pull.head) ? pull.head : {};
      const fields = { head: str(head.ref), headSha: str(head.sha), base: isObject(pull.base) ? str(pull.base.ref) : undefined };
      pullRequests.push({ number, ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)) });
    }
    const fields = { listedEvent: listed !== event ? listed : undefined, workflow, path, headBranch: str(v.head_branch), headRepo, conclusion, url: str(v.html_url) };
    const out: WorkflowRun = { id, event, headSha, status, done: OVER.has(status), pullRequests };
    for (const [k, val] of Object.entries(fields)) if (val !== undefined) (out as unknown as Record<string, unknown>)[k] = val;
    return out;
  };
  const artifactOf = (v: Record<string, unknown>, name: string): RunArtifact | undefined => {
    const id = num(v.id);
    if (id === undefined || str(v.name) !== name || v.expired === true) return undefined;
    const wr = isObject(v.workflow_run) ? v.workflow_run : {};
    const run = num(wr.id) ?? num(v.run_id) ?? num(v.workflow_run_id);
    const headSha = str(wr.head_sha);
    const size = num(v.size_in_bytes) ?? num(v.size);
    return { id, name, ...(run !== undefined ? { run } : {}), ...(headSha ? { headSha } : {}), ...(size !== undefined ? { size } : {}) };
  };
  /** Forgejo answers a pull request list with 404 while the repository is still empty; a missing repository 404s on its own read too. */
  const pulls = async (query: string, max?: number): Promise<unknown[]> => {
    try {
      return await get.list(`${repo}/pulls?${query}`, max);
    } catch (err) {
      if (kind !== "forgejo" || !notFound(err)) throw err;
      await get(repo);
      return [];
    }
  };
  return {
    kind,
    tokenUser: async () => userOf(await get("/user"), "login"),
    pullRequest: async (pr) => detail(await orUndefined(get(`${repo}/pulls/${pr}`))),
    async pullRequestsFrom(branch, o = {}) {
      const limit = o.limit ?? DEFAULT_LIMIT;
      // GitHub filters an exact head (`owner:branch`) server-side; Forgejo's list takes no head filter.
      const exactOnGithub = kind === "github" && !o.prefix;
      const query = exactOnGithub
        ? `state=all&head=${encodeURIComponent(`${opts.repo.split("/")[0]}:${branch}`)}`
        : kind === "github"
          ? "state=all&sort=updated&direction=desc"
          : "state=all&sort=recentupdate";
      const listed = (await pulls(query, limit)).map(detail).filter(defined);
      return listed.filter((p) => p.sameRepo && (o.prefix ? p.head.startsWith(branch) : p.head === branch)).sort(newestFirst);
    },
    async pullRequestNotes(pr) {
      const out: PullRequestNote[] = [];
      for (const c of await get.list(`${repo}/issues/${pr}/comments`)) {
        const id = isObject(c) ? num(c.id) : undefined;
        if (!isObject(c) || id === undefined) continue;
        const author = isObject(c.user) ? str(c.user.login) : undefined;
        const authorId = isObject(c.user) ? num(c.user.id) : undefined;
        const created = str(c.created_at);
        out.push({ id, body: str(c.body) ?? "", ...(author ? { author } : {}), ...(authorId !== undefined ? { authorId } : {}), system: false, ...(created ? { created } : {}) });
      }
      return out;
    },
    async checkRuns(sha) {
      if (kind !== "github") return [];
      // The check runs list is an object ({ total_count, check_runs }), not an array, so it is paged here.
      const runs: Record<string, unknown>[] = [];
      for (let page = 1; page <= 50; page++) {
        const got = await get(`${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
        const items = isObject(got) && Array.isArray(got.check_runs) ? got.check_runs.filter(isObject) : [];
        runs.push(...items);
        if (items.length < 100) break;
      }
      const newest = new Map<string, CheckRun>();
      for (const r of runs) {
        const id = num(r.id);
        const name = str(r.name);
        if (id === undefined || !name) continue;
        const conclusion = str(r.conclusion);
        const had = newest.get(name);
        if (!had || id > had.id) newest.set(name, { id, name, status: str(r.status) ?? "queued", ...(conclusion ? { conclusion } : {}) });
      }
      return [...newest.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async pullRequestCommits(pr) {
      const out: PullRequestCommit[] = [];
      for (const c of await get.list(`${repo}/pulls/${pr}/commits`)) {
        const sha = isObject(c) ? str(c.sha) : undefined;
        if (!isObject(c) || !sha) continue;
        const git = isObject(c.commit) ? c.commit : {};
        const a = isObject(git.author) ? git.author : {};
        const m = isObject(git.committer) ? git.committer : {};
        out.push({ sha, message: str(git.message) ?? "", author: person(a.name, a.email, isObject(c.author) ? c.author.login : undefined), committer: person(m.name, m.email, isObject(c.committer) ? c.committer.login : undefined) });
      }
      return out;
    },
    async permission(login) {
      let got: unknown;
      try {
        got = await get(`${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      } catch (err) {
        // GitHub answers 404 for a user it does not know; Forgejo 403 or 404 for one who is no collaborator.
        if (err instanceof ForgeApiError && (err.status === 404 || err.status === 403)) return undefined;
        throw err;
      }
      return isObject(got) ? str(got.permission) : undefined;
    },
    async openPullRequests() {
      const out: OpenPullRequest[] = [];
      for (const v of await pulls("state=open")) {
        if (!isObject(v) || !isObject(v.head) || !isObject(v.base)) continue;
        const number = num(v.number);
        const head = str(v.head.ref);
        const headSha = str(v.head.sha);
        const base = str(v.base.ref);
        if (number === undefined || !head || !headSha || !base) continue;
        const baseSha = str(v.base.sha);
        const author = isObject(v.user) ? str(v.user.login) : undefined;
        out.push({ number, head, headSha, base, ...(baseSha ? { baseSha } : {}), ...(author ? { author } : {}), fork: !sameRepo(v) });
      }
      return out.sort((a, b) => a.number - b.number);
    },
    async headRuns(sha, o = {}) {
      const query = `head_sha=${encodeURIComponent(sha)}${o.event ? `&event=${encodeURIComponent(o.event)}` : ""}`;
      const listed = (await listIn(get, `${repo}/actions/runs?${query}`, "workflow_runs", pageSize, pageParams, o.limit ?? RUN_LIMIT)).map(runOf).filter(defined);
      // Forgejo filters by the listed event, so a pull_request_target run comes back for `pull_request`: both words count.
      return listed.filter((r) => r.headSha === sha && (!o.event || r.event === o.event || r.listedEvent === o.event)).sort(byIdDesc);
    },
    async branchRuns(branch, o = {}) {
      const query = `branch=${encodeURIComponent(branch)}${o.event ? `&event=${encodeURIComponent(o.event)}` : ""}`;
      const listed = (await listIn(get, `${repo}/actions/runs?${query}`, "workflow_runs", pageSize, pageParams, o.limit ?? RUN_LIMIT)).map(runOf).filter(defined);
      return listed.filter((r) => r.headBranch === undefined || r.headBranch === branch).filter((r) => !o.event || r.event === o.event || r.listedEvent === o.event).sort(byIdDesc);
    },
    async pullRequestsUpdated(since, o = {}) {
      const limit = o.limit ?? DEFAULT_LIMIT;
      const from = Date.parse(since);
      const out: PullRequestDetail[] = [];
      // Newest update first, so the first page item older than `since` ends the read.
      const query = kind === "github" ? "state=all&sort=updated&direction=desc" : "state=all&sort=recentupdate";
      for (let page = 1; page <= 50 && out.length < limit; page++) {
        let items: unknown;
        try {
          items = await get(`${repo}/pulls?${query}&${pageParams(page)}`);
        } catch (err) {
          if (kind !== "forgejo" || !notFound(err)) throw err;
          await get(repo);
          return [];
        }
        const list = Array.isArray(items) ? items : [];
        let older = false;
        for (const v of list) {
          const d = detail(v);
          if (!d) continue;
          if (d.updated !== undefined && Date.parse(d.updated) < from) {
            older = true;
            break;
          }
          out.push(d);
        }
        if (older || list.length < pageSize) break;
      }
      return out.slice(0, limit);
    },
    run: async (id) => runOf(await orUndefined(get(`${repo}/actions/runs/${id}`))),
    runJobs: async (run) => (await listIn(get, `${repo}/actions/runs/${run}/jobs`, "jobs", pageSize, pageParams, 1000)).map(jobOf).filter(defined),
    async artifacts(name, o = {}) {
      const where = o.run !== undefined ? `${repo}/actions/runs/${o.run}/artifacts` : `${repo}/actions/artifacts`;
      const listed = await listIn(get, `${where}?name=${encodeURIComponent(name)}`, "artifacts", pageSize, pageParams, o.limit ?? RUN_LIMIT);
      return listed.map((a) => artifactOf(a, name)).filter(defined).map((a) => (o.run !== undefined && a.run === undefined ? { ...a, run: o.run } : a)).sort(byIdDesc);
    },
    async compare(base, head) {
      const got = await get(`${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      const c = isObject(got) ? got : {};
      if (kind === "github") {
        const listed = Array.isArray(c.files) ? c.files.filter(isObject) : [];
        const files = listed.map((f) => changed(f.filename, f.previous_filename)).filter(defined);
        return { files, truncated: listed.length >= GITHUB_COMPARE_FILES };
      }
      // Forgejo names the files of each commit between the merge base and the head.
      const commits = Array.isArray(c.commits) ? c.commits.filter(isObject) : [];
      const seen = new Set<string>();
      const files: ChangedFile[] = [];
      for (const commit of commits) {
        for (const f of Array.isArray(commit.files) ? commit.files.filter(isObject) : []) {
          const file = changed(f.filename);
          if (file && !seen.has(file.path)) {
            seen.add(file.path);
            files.push(file);
          }
        }
      }
      const total = num(c.total_commits);
      return { files, truncated: (total !== undefined && commits.length < total) || commits.some((commit) => !Array.isArray(commit.files)) };
    },
    job: async (id) => jobOf(await orUndefined(get(`${repo}/actions/jobs/${id}`))),
  };
}

/** GitHub lists at most this many files of a comparison. */
const GITHUB_COMPARE_FILES = 300;

const changed = (path: unknown, previous?: unknown): ChangedFile | undefined => {
  const p = str(path);
  const was = str(previous);
  return p ? { path: p, ...(was && was !== p ? { previousPath: was } : {}) } : undefined;
};

/** A job as GitHub, Forgejo or GitLab answers it. */
function jobOf(j: unknown): RunJob | undefined {
  if (!isObject(j)) return undefined;
  const id = num(j.id);
  const name = str(j.name);
  if (id === undefined || !name) return undefined;
  const status = str(j.status) ?? "";
  const conclusion = str(j.conclusion);
  const run = num(j.run_id) ?? (isObject(j.pipeline) ? num(j.pipeline.id) : undefined);
  const ref = str(j.head_branch) ?? str(j.ref);
  const url = str(j.html_url) ?? str(j.web_url);
  return {
    id,
    name,
    status,
    ...(conclusion ? { conclusion } : {}),
    done: OVER.has(status),
    ...(run !== undefined ? { run } : {}),
    ...(ref ? { ref } : {}),
    ...(typeof j.tag === "boolean" ? { tag: j.tag } : {}),
    ...(url ? { url } : {}),
  };
}

/** GitLab's access levels, by the number its API answers. */
const GITLAB_ROLES: Record<number, string> = { 5: "minimal", 10: "guest", 15: "planner", 20: "reporter", 30: "developer", 40: "maintainer", 50: "owner" };

/** The reads for a GitHub client's options. */
export function githubReads(opts: GithubForgeOptions): ForgeReads {
  return githubShapedReads("github", opts);
}

/** The reads for a Forgejo (or Gitea) client's options. */
export function forgejoReads(opts: GithubForgeOptions): ForgeReads {
  return githubShapedReads("forgejo", opts);
}

/** The reads for a GitLab client's options. */
export function gitlabReads(opts: GitlabForgeOptions): ForgeReads {
  const get = getter(opts.apiBase, opts.token ? { [opts.tokenHeader ?? "PRIVATE-TOKEN"]: opts.token } : {}, opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch), 100, (page) => `per_page=100&page=${page}`);
  const project = `/projects/${encodeURIComponent(decodeURIComponent(opts.project))}`;
  const mrs = `${project}/merge_requests`;
  const gitlabPage = (page: number): string => `per_page=100&page=${page}`;
  const MR_REF = /^refs\/merge-requests\/(\d+)\/(?:head|merge|train)$/;
  const pipelineOf = (v: unknown): WorkflowRun | undefined => {
    if (!isObject(v)) return undefined;
    const id = num(v.id);
    const headSha = str(v.sha);
    if (id === undefined || !headSha) return undefined;
    const status = str(v.status) ?? "";
    const ref = str(v.ref);
    const mr = ref ? MR_REF.exec(ref) : null;
    const fields = { headBranch: ref, url: str(v.web_url) };
    const out: WorkflowRun = { id, event: str(v.source) ?? "", headSha, status, done: OVER.has(status), pullRequests: mr ? [{ number: Number(mr[1]), headSha }] : [] };
    for (const [k, val] of Object.entries(fields)) if (val !== undefined) (out as unknown as Record<string, unknown>)[k] = val;
    return out;
  };
  /** A job's artifacts archive, when it kept one. */
  const archiveOf = (j: Record<string, unknown>, name: string): RunArtifact | undefined => {
    const id = num(j.id);
    if (id === undefined || str(j.name) !== name) return undefined;
    const files = Array.isArray(j.artifacts) ? j.artifacts.filter(isObject) : [];
    const archive = files.find((f) => f.file_type === "archive") ?? (isObject(j.artifacts_file) ? j.artifacts_file : undefined);
    if (!archive) return undefined;
    const expires = str(j.artifacts_expire_at);
    if (expires && Date.parse(expires) <= Date.now()) return undefined;
    const pipeline = isObject(j.pipeline) ? j.pipeline : {};
    const run = num(pipeline.id);
    const headSha = str(pipeline.sha);
    const size = num(archive.size);
    return { id, name, ...(run !== undefined ? { run } : {}), ...(headSha ? { headSha } : {}), ...(size !== undefined ? { size } : {}) };
  };
  const own = (v: Record<string, unknown>): boolean => num(v.source_project_id) === undefined || num(v.source_project_id) === num(v.target_project_id);
  const detail = (v: unknown): PullRequestDetail | undefined => {
    if (!isObject(v)) return undefined;
    const number = num(v.iid);
    if (number === undefined) return undefined;
    const state = v.state === "merged" ? "merged" : v.state === "opened" ? "open" : "closed";
    // A fast-forward merge makes no merge commit: the head is then what the base points at.
    const mergeCommit = state === "merged" ? (str(v.merge_commit_sha) ?? str(v.squash_commit_sha) ?? str(v.sha)) : undefined;
    const fields = {
      url: str(v.web_url),
      headSha: str(v.sha),
      base: str(v.target_branch),
      author: isObject(v.author) ? str(v.author.username) : undefined,
      mergeCommit,
      updated: str(v.updated_at),
    };
    const out: PullRequestDetail = { number, title: str(v.title) ?? "", body: str(v.description) ?? "", state, head: str(v.source_branch) ?? "", sameRepo: own(v) };
    for (const [k, val] of Object.entries(fields)) if (val !== undefined) (out as unknown as Record<string, unknown>)[k] = val;
    return out;
  };
  return {
    kind: "gitlab",
    tokenUser: async () => userOf(await get("/user"), "username"),
    pullRequest: async (mr) => detail(await orUndefined(get(`${mrs}/${mr}`))),
    async pullRequestsFrom(branch, o = {}) {
      const query = o.prefix ? "state=all&order_by=updated_at&sort=desc" : `state=all&source_branch=${encodeURIComponent(branch)}&order_by=updated_at&sort=desc`;
      const listed = (await get.list(`${mrs}?${query}`, o.limit ?? DEFAULT_LIMIT)).map(detail).filter(defined);
      return listed.filter((m) => m.sameRepo && (o.prefix ? m.head.startsWith(branch) : m.head === branch)).sort(newestFirst);
    },
    async pullRequestNotes(mr) {
      const out: PullRequestNote[] = [];
      for (const n of await get.list(`${mrs}/${mr}/notes?sort=asc&order_by=created_at`)) {
        const id = isObject(n) ? num(n.id) : undefined;
        if (!isObject(n) || id === undefined) continue;
        const author = isObject(n.author) ? str(n.author.username) : undefined;
        const authorId = isObject(n.author) ? num(n.author.id) : undefined;
        const created = str(n.created_at);
        out.push({ id, body: str(n.body) ?? "", ...(author ? { author } : {}), ...(authorId !== undefined ? { authorId } : {}), system: n.system === true, ...(created ? { created } : {}) });
      }
      return out;
    },
    checkRuns: async () => [],
    async pullRequestCommits(mr) {
      const out: PullRequestCommit[] = [];
      for (const c of await get.list(`${mrs}/${mr}/commits`)) {
        const sha = isObject(c) ? str(c.id) : undefined;
        if (!isObject(c) || !sha) continue;
        out.push({ sha, message: str(c.message) ?? "", author: person(c.author_name, c.author_email), committer: person(c.committer_name, c.committer_email) });
      }
      return out;
    },
    async permission(login) {
      const users = await get(`/users?username=${encodeURIComponent(login)}`);
      const id = Array.isArray(users) ? users.map((u) => (isObject(u) && u.username === login ? num(u.id) : undefined)).find(defined) : undefined;
      if (id === undefined) return undefined;
      const member = await orUndefined(get(`${project}/members/all/${id}`));
      const level = isObject(member) ? num(member.access_level) : undefined;
      return level === undefined ? undefined : (GITLAB_ROLES[level] ?? String(level));
    },
    async openPullRequests() {
      const out: OpenPullRequest[] = [];
      for (const m of await get.list(`${mrs}?state=opened`)) {
        if (!isObject(m)) continue;
        const number = num(m.iid);
        const head = str(m.source_branch);
        const headSha = str(m.sha);
        const base = str(m.target_branch);
        if (number === undefined || !head || !headSha || !base) continue;
        const baseSha = isObject(m.diff_refs) ? str(m.diff_refs.base_sha) : undefined;
        const author = isObject(m.author) ? str(m.author.username) : undefined;
        out.push({ number, head, headSha, base, ...(baseSha ? { baseSha } : {}), ...(author ? { author } : {}), fork: !own(m) });
      }
      return out.sort((a, b) => a.number - b.number);
    },
    async headRuns(sha, o = {}) {
      const query = `sha=${encodeURIComponent(sha)}${o.event ? `&source=${encodeURIComponent(o.event)}` : ""}&order_by=id&sort=desc`;
      const listed = (await listIn(get, `${project}/pipelines?${query}`, "", 100, gitlabPage, o.limit ?? RUN_LIMIT)).map(pipelineOf).filter(defined);
      return listed.filter((r) => r.headSha === sha && (!o.event || r.event === o.event)).sort(byIdDesc);
    },
    async branchRuns(branch, o = {}) {
      const query = `ref=${encodeURIComponent(branch)}${o.event ? `&source=${encodeURIComponent(o.event)}` : ""}&order_by=id&sort=desc`;
      const listed = (await listIn(get, `${project}/pipelines?${query}`, "", 100, gitlabPage, o.limit ?? RUN_LIMIT)).map(pipelineOf).filter(defined);
      return listed.filter((r) => r.headBranch === branch && (!o.event || r.event === o.event)).sort(byIdDesc);
    },
    async pullRequestsUpdated(since, o = {}) {
      const listed = await get.list(`${mrs}?state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=desc`, o.limit ?? DEFAULT_LIMIT);
      return listed.map(detail).filter(defined);
    },
    run: async (id) => pipelineOf(await orUndefined(get(`${project}/pipelines/${id}`))),
    runJobs: async (run) => (await get.list(`${project}/pipelines/${run}/jobs?include_retried=false`)).map(jobOf).filter(defined),
    async artifacts(name, o = {}) {
      const limit = o.limit ?? RUN_LIMIT;
      // GitLab keeps artifacts per job: a pipeline's jobs of that name, or the project's newest jobs, that kept an archive.
      const jobs = o.run !== undefined ? await get.list(`${project}/pipelines/${o.run}/jobs`) : await get.list(`${project}/jobs`, 10 * limit);
      return jobs.filter(isObject).map((j) => archiveOf(j, name)).filter(defined).sort(byIdDesc).slice(0, limit);
    },
    async compare(base, head) {
      const got = await get(`${project}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}&straight=false`);
      const c = isObject(got) ? got : {};
      const files = (Array.isArray(c.diffs) ? c.diffs.filter(isObject) : []).map((d) => changed(d.new_path ?? d.old_path, d.old_path)).filter(defined);
      return { files, truncated: c.compare_timeout === true };
    },
    job: async (id) => jobOf(await orUndefined(get(`${project}/jobs/${id}`))),
    artifactFile: (job, path) => get.text(`${project}/jobs/${job}/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`),
  };
}

/** The reads for a {@link ForgeTarget}, the way `forgeClient` builds its client. */
export function forgeReadsFor(target: ForgeTarget, fetchImpl?: ForgeFetch): ForgeReads {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (target.kind === "gitlab") {
    return gitlabReads({ apiBase: target.apiBase, project: target.repo, token: target.token, host: target.host, ...(target.tokenHeader ? { tokenHeader: target.tokenHeader } : {}), ...f });
  }
  const opts = { apiBase: target.apiBase, repo: target.repo, token: target.token, host: target.host, ...f };
  return target.kind === "forgejo" ? forgejoReads(opts) : githubReads(opts);
}
