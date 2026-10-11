/**
 * What chant and the products built on it ask of a forge: keep one comment
 * (a merge request note on GitLab) on a pull request up to date, set a commit
 * status, keep one tracking issue in the repository, list who approved a pull
 * request, and find the pull request that merged a commit.
 *
 * The pull-request loop (#3183) uses the note, the status and the review
 * calls. `reconcilePr`'s `comment` and `issue` finding modes post through the
 * same clients (#3757), so a finding needs no `gh` on the runner. terragucci
 * and SQL Yodeler post their own notes, statuses and drift issues through
 * them too (#3759): bodies stay with each product, the finding by marker and
 * the forge's REST shapes live here.
 *
 * GitHub and Forgejo speak the same REST shapes for most of this, at
 * different base URLs (`$GITHUB_API_URL` is right on both, #2305); they part
 * on the commit-to-pull-request lookup, on review states and on page size.
 * GitLab has its own API for all of it. Each client takes a `fetch`, so the
 * tests drive them with a recording fake and no network.
 *
 * A reviewer is named the way #3163 names a person: `github:<login>`,
 * `gitlab:<login>`, or `<forge>@<host>:<login>` off the forge's default host.
 * The apply compares that string with the approval's `resolvedBy`.
 *
 * Like `./pr-loop.ts`, this bundles without the TypeScript toolchain (#3421):
 * it imports nothing but `node:fs`, to read a CI job's event payload.
 * `./pr-forge-bundle.test.ts` holds it to that.
 */

import { readFileSync } from "node:fs";

export type ForgeKind = "github" | "gitlab" | "forgejo";

export const FORGE_KINDS: readonly ForgeKind[] = ["github", "gitlab", "forgejo"];

/** The subset of the WHATWG `fetch` the clients use. */
export type ForgeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ForgeStatus {
  /** The status's name, such as `chant/plan` or `terragucci/plan`. */
  context: string;
  state: "pending" | "success" | "failure";
  /** Cut to what the forge keeps: 140 characters on GitHub and Forgejo, 255 on GitLab. */
  description: string;
  /** The pipeline run, linked from the status. */
  url?: string;
  /** GitLab only: the pipeline the status belongs to. */
  pipelineId?: number;
}

/**
 * How a comment or an issue is told to be the caller's own. By default the
 * body starts with the marker, chant's recipe since #2291, and anyone may
 * have written it.
 */
export interface MarkerMatch {
  /** `prefix` (the default): the body starts with the marker. `anywhere`: the body carries it. */
  match?: "prefix" | "anywhere";
  /**
   * Only a comment or issue written by this login counts: `user.login` on
   * GitHub and Forgejo, `author.username` on GitLab, compared without case.
   * A merge request's author can write a note carrying any marker, so a
   * product that reads its own notes back names its bot here.
   */
  author?: string;
}

/** What {@link PrForge.upsertComment} did. */
export interface CommentResult {
  action: "created" | "updated" | "unchanged";
  /** The comment's or note's id. */
  id: number;
  /** Its web URL, when the forge's answer carries one (GitHub and Forgejo do; a GitLab note does not). */
  url?: string;
}

/** A comment or note {@link PrForge.findComment} read back. */
export interface FoundComment {
  /** The comment's or note's id. */
  id: number;
  body: string;
  /** Its web URL, when the forge's answer carries one (GitHub and Forgejo do; a GitLab note does not). */
  url?: string;
}

/** A finding to keep in a tracking issue. `body` carries the marker. */
export interface IssueFinding {
  title: string;
  body: string;
}

export interface TrackIssueOptions extends MarkerMatch {
  /**
   * When the finding has cleared (`null`), close the open issue, after
   * {@link clearComment} when one is given. Off by default: `reconcilePr`'s
   * `issue` mode never closes an issue, and a closed one is never reopened,
   * so the next finding opens a fresh issue.
   */
  closeOnClear?: boolean;
  /** Posted on the issue before it is closed. */
  clearComment?: string;
  /**
   * When the open issue counts as already current, in place of an equal
   * title and body, for a body that names something that changes on every
   * run (the run's URL, a timestamp). A string: unchanged when the titles
   * are equal and the open issue's body carries it, such as the finding's
   * fingerprint. A function: unchanged when it returns true for the open
   * issue and the finding. An unchanged issue is not edited.
   */
  sameWhen?: string | ((open: IssueFinding, finding: IssueFinding) => boolean);
}

/** What {@link PrForge.trackIssue} did. */
export interface IssueResult {
  /**
   * `opened`, `updated`, or `unchanged` (title and body already current) for
   * a finding; `closed`, `left` (open, `closeOnClear` off) or `none` (no open
   * issue) for a cleared one.
   */
  action: "opened" | "updated" | "unchanged" | "closed" | "left" | "none";
  /** The issue's number (GitHub, Forgejo) or iid (GitLab). */
  number?: number;
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
  /**
   * Keep one comment on pull request `pr` (one note on merge request `pr`):
   * the one {@link MarkerMatch} finds is updated, unless its body is already
   * `body`, or one is added. `body` must carry the marker the same way, or
   * the next run could not find it; that is refused before any call. Every
   * page of comments is read, and GitLab's system notes are skipped. When
   * several match, the oldest is kept.
   */
  upsertComment(pr: number, marker: string, body: string, opts?: MarkerMatch): Promise<CommentResult>;
  /**
   * {@link upsertComment} by prefix, without the body check, resolving to the
   * comment's web URL. The pull-request loop's form.
   */
  upsertNote(pr: number, marker: string, body: string): Promise<string | undefined>;
  /**
   * The comment on pull request `pr` (the note on merge request `pr`) that
   * {@link upsertComment} would update for `marker`: the oldest one that
   * {@link MarkerMatch} finds, `author` honoured, so a pull request's author
   * cannot plant one. Undefined when there is none. Every page is read, and
   * GitLab's system notes are skipped.
   */
  findComment(pr: number, marker: string, opts?: MarkerMatch): Promise<FoundComment | undefined>;
  setStatus(sha: string, status: ForgeStatus): Promise<void>;
  /**
   * Keep one OPEN tracking issue for `marker` in line with `finding`: open
   * it, update its title and body, or, when `finding` is `null` and
   * `closeOnClear` is set, close it with a comment. Only open issues are
   * read, so an issue closed by hand stays closed. Pull requests are never
   * taken for issues. When several match, the oldest is kept.
   */
  trackIssue(marker: string, finding: IssueFinding | null, opts?: TrackIssueOptions): Promise<IssueResult>;
  /**
   * {@link trackIssue} by prefix for a finding, without the body check,
   * resolving to the issue's web URL. `reconcilePr`'s `issue` mode's form.
   */
  upsertIssue(marker: string, title: string, body: string): Promise<string | undefined>;
  /** Logins whose standing review approves `pr`. */
  approvers(pr: number): Promise<string[]>;
  /** The merged pull request that produced `sha`, or null. */
  pullRequestFor(sha: string): Promise<number | null>;
}

/** A GitHub or Forgejo client. */
export type GithubShapedForge = PrForge & { kind: "github" | "forgejo" };

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
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

/** A comment, note or issue as the shared recipes read it. `id` is an issue's number or iid. */
interface Thread {
  id: number;
  body: string;
  title?: string;
  author?: string;
  url?: string;
}

/** The calls each forge makes for the shared comment and issue recipes. */
interface Threads {
  comments(pr: number): Promise<Thread[]>;
  addComment(pr: number, body: string): Promise<Thread | undefined>;
  editComment(pr: number, id: number, body: string): Promise<Thread | undefined>;
  /** Open issues only, pull requests left out. */
  openIssues(marker: string): Promise<Thread[]>;
  openIssue(title: string, body: string): Promise<Thread | undefined>;
  editIssue(n: number, title: string, body: string): Promise<Thread | undefined>;
  closeIssue(n: number, comment: string | undefined): Promise<void>;
}

const carries = (body: string, marker: string, match: MarkerMatch["match"]): boolean =>
  match === "anywhere" ? body.includes(marker) : body.startsWith(marker);

const ownedBy = (marker: string, opts: MarkerMatch) => (t: Thread): boolean =>
  carries(t.body, marker, opts.match) && (!opts.author || t.author?.toLowerCase() === opts.author.toLowerCase());

function checkMarker(what: string, marker: string, body: string, match: MarkerMatch["match"]): void {
  if (!marker) throw new Error(`the ${what} needs a marker to be found again`);
  if (!carries(body, marker, match)) {
    throw new Error(
      `the ${what} body ${match === "anywhere" ? "does not carry" : "does not start with"} its marker ${JSON.stringify(marker)}, so the next run could not find it`,
    );
  }
}

/** The oldest comment on `pr` that `opts` takes for the caller's own. */
async function ownComment(t: Threads, pr: number, marker: string, opts: MarkerMatch): Promise<Thread | undefined> {
  if (!marker) throw new Error("the comment needs a marker to be found");
  return (await t.comments(pr)).filter(ownedBy(marker, opts)).sort((a, b) => a.id - b.id)[0];
}

async function upsertCommentWith(t: Threads, pr: number, marker: string, body: string, opts: MarkerMatch, check: boolean): Promise<CommentResult> {
  if (check) checkMarker("comment", marker, body, opts.match);
  const mine = await ownComment(t, pr, marker, opts);
  if (!mine) {
    const made = await t.addComment(pr, body);
    return { action: "created", id: made?.id ?? 0, ...(made?.url ? { url: made.url } : {}) };
  }
  if (mine.body === body) return { action: "unchanged", id: mine.id, ...(mine.url ? { url: mine.url } : {}) };
  const edited = await t.editComment(pr, mine.id, body);
  const url = edited?.url ?? mine.url;
  return { action: "updated", id: mine.id, ...(url ? { url } : {}) };
}

async function trackIssueWith(t: Threads, marker: string, finding: IssueFinding | null, opts: TrackIssueOptions, check: boolean): Promise<IssueResult> {
  if (finding && check) checkMarker("issue", marker, finding.body, opts.match);
  const mine = (await t.openIssues(marker)).filter(ownedBy(marker, opts)).sort((a, b) => a.id - b.id)[0];
  const at = (i: Thread | undefined): Omit<IssueResult, "action"> => (i ? { number: i.id, ...(i.url ? { url: i.url } : {}) } : {});
  if (finding === null) {
    if (!mine) return { action: "none" };
    if (!opts.closeOnClear) return { action: "left", ...at(mine) };
    await t.closeIssue(mine.id, opts.clearComment);
    return { action: "closed", ...at(mine) };
  }
  if (!mine) return { action: "opened", ...at(await t.openIssue(finding.title, finding.body)) };
  if (sameIssue({ title: mine.title ?? "", body: mine.body }, finding, opts.sameWhen)) return { action: "unchanged", ...at(mine) };
  const edited = await t.editIssue(mine.id, finding.title, finding.body);
  return { action: "updated", ...at(mine), ...(edited?.url ? { url: edited.url } : {}) };
}

function sameIssue(open: IssueFinding, finding: IssueFinding, sameWhen: TrackIssueOptions["sameWhen"]): boolean {
  if (typeof sameWhen === "function") return sameWhen(open, finding);
  if (open.title !== finding.title) return false;
  return typeof sameWhen === "string" && sameWhen !== "" ? open.body.includes(sameWhen) : open.body === finding.body;
}

/** The recipes every client shares, over its own {@link Threads}. */
function threadCalls(t: Threads): Pick<PrForge, "upsertComment" | "upsertNote" | "findComment" | "trackIssue" | "upsertIssue"> {
  return {
    async findComment(pr, marker, opts = {}) {
      const c = await ownComment(t, pr, marker, opts);
      return c ? { id: c.id, body: c.body, ...(c.url ? { url: c.url } : {}) } : undefined;
    },
    upsertComment: (pr, marker, body, opts = {}) => upsertCommentWith(t, pr, marker, body, opts, true),
    upsertNote: async (pr, marker, body) => (await upsertCommentWith(t, pr, marker, body, {}, false)).url,
    trackIssue: (marker, finding, opts = {}) => trackIssueWith(t, marker, finding, opts, true),
    upsertIssue: async (marker, title, body) => (await trackIssueWith(t, marker, { title, body }, {}, false)).url,
  };
}

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

/** GitHub keeps a status description to 140 characters; Forgejo follows. */
const GITHUB_DESCRIPTION = 140;
/** GitLab keeps a status description to 255 characters. */
const GITLAB_DESCRIPTION = 255;

/** Which of the two GitHub-shaped forges a client is talking to. */
function githubShaped(kind: "github" | "forgejo", opts: GithubForgeOptions): GithubShapedForge {
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
  const thread = (v: unknown): Thread | undefined => {
    if (!isObject(v)) return undefined;
    const id = num(v.number) ?? num(v.id);
    if (id === undefined) return undefined;
    const author = loginOf(v);
    const url = str(v.html_url);
    return { id, body: str(v.body) ?? "", ...(str(v.title) !== undefined ? { title: str(v.title) } : {}), ...(author ? { author } : {}), ...(url ? { url } : {}) };
  };
  const threads = (items: unknown[]): Thread[] => items.map(thread).filter((t): t is Thread => t !== undefined);
  const t: Threads = {
    comments: async (pr) => threads(await api.list(`${repo}/issues/${pr}/comments`, pageParams, pageSize)),
    addComment: async (pr, body) => thread(await api.call("POST", `${repo}/issues/${pr}/comments`, { body })),
    editComment: async (_pr, id, body) => thread(await api.call("PATCH", `${repo}/issues/comments/${id}`, { body })),
    // Paged in full rather than searched: GitHub's search index lags a
    // write, so a run straight after another would miss the issue it just
    // opened, and Forgejo has no `/search/issues` at all. Both list pull
    // requests among issues; one of those is never ours.
    openIssues: async () =>
      threads((await api.list(`${repo}/issues?state=open`, pageParams, pageSize)).filter((i) => isObject(i) && !isObject(i.pull_request))),
    openIssue: async (title, body) => thread(await api.call("POST", `${repo}/issues`, { title, body })),
    editIssue: async (n, title, body) => thread(await api.call("PATCH", `${repo}/issues/${n}`, { title, body })),
    async closeIssue(n, comment) {
      if (comment) await api.call("POST", `${repo}/issues/${n}/comments`, { body: comment });
      await api.call("PATCH", `${repo}/issues/${n}`, { state: "closed" });
    },
  };
  return {
    kind,
    host,
    ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    principalOf: (login) => forgePrincipalOf(kind, host, login),
    ...threadCalls(t),
    async setStatus(sha, status) {
      await api.call("POST", `${repo}/statuses/${sha}`, {
        state: status.state,
        context: status.context,
        description: status.description.slice(0, GITHUB_DESCRIPTION),
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
export function githubForge(opts: GithubForgeOptions): GithubShapedForge {
  return githubShaped("github", opts);
}

/** A Forgejo (or Gitea) client. `host` is required: Forgejo has no default host. */
export function forgejoForge(opts: GithubForgeOptions & { host: string }): GithubShapedForge {
  return githubShaped("forgejo", opts);
}

export interface GitlabForgeOptions {
  /** `$CI_API_V4_URL`. */
  apiBase: string;
  /** `$CI_PROJECT_ID`, or the URL-encoded path. */
  project: string;
  token: string;
  /**
   * The header the token goes in: `PRIVATE-TOKEN` (the default) for an
   * access token, `JOB-TOKEN` for `CI_JOB_TOKEN`. One in the other's header
   * is a 401.
   */
  tokenHeader?: "PRIVATE-TOKEN" | "JOB-TOKEN";
  /** Default gitlab.com. */
  host?: string;
  runUrl?: string;
  fetch?: ForgeFetch;
}

const GITLAB_STATE: Record<ForgeStatus["state"], string> = { pending: "pending", success: "success", failure: "failed" };

/**
 * A GitLab client. Writing notes needs an access token with the `api` scope
 * on most instances: the job token reaches only the endpoints the instance's
 * job-token allowlist names.
 */
export function gitlabForge(opts: GitlabForgeOptions): PrForge {
  const host = (opts.host ?? "gitlab.com").toLowerCase();
  const api = transport(opts.apiBase, { [opts.tokenHeader ?? "PRIVATE-TOKEN"]: opts.token }, opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch));
  const project = `/projects/${encodeURIComponent(decodeURIComponent(opts.project))}`;
  const pageParams = (page: number) => `per_page=100&page=${page}`;
  const authorOf = (v: Record<string, unknown>): string | undefined => (isObject(v.author) ? str(v.author.username) : undefined);
  const note = (v: unknown): Thread | undefined => {
    if (!isObject(v)) return undefined;
    const id = num(v.id);
    if (id === undefined) return undefined;
    const author = authorOf(v);
    return { id, body: str(v.body) ?? "", ...(author ? { author } : {}) };
  };
  const issue = (v: unknown): Thread | undefined => {
    if (!isObject(v)) return undefined;
    const id = num(v.iid);
    if (id === undefined) return undefined;
    const author = authorOf(v);
    const url = str(v.web_url);
    return { id, body: str(v.description) ?? "", ...(str(v.title) !== undefined ? { title: str(v.title) } : {}), ...(author ? { author } : {}), ...(url ? { url } : {}) };
  };
  const notes = `${project}/merge_requests`;
  const t: Threads = {
    comments: async (mr) =>
      (await api.list(`${notes}/${mr}/notes`, pageParams, 100))
        // System notes ("added 1 commit") are the forge's own, never ours.
        .filter((n) => !(isObject(n) && n.system === true))
        .map(note)
        .filter((n): n is Thread => n !== undefined),
    addComment: async (mr, body) => note(await api.call("POST", `${notes}/${mr}/notes`, { body })),
    editComment: async (mr, id, body) => note(await api.call("PUT", `${notes}/${mr}/notes/${id}`, { body })),
    // `search` narrows the list server-side to issues whose description
    // carries the marker, as `reconcilePr`'s GitLab issue does (#2292); the
    // match itself is still decided here.
    openIssues: async (marker) =>
      (await api.list(`${project}/issues?state=opened&search=${encodeURIComponent(marker)}&in=description`, pageParams, 100))
        .map(issue)
        .filter((i): i is Thread => i !== undefined),
    openIssue: async (title, body) => issue(await api.call("POST", `${project}/issues`, { title, description: body })),
    editIssue: async (n, title, body) => issue(await api.call("PUT", `${project}/issues/${n}`, { title, description: body })),
    async closeIssue(n, comment) {
      if (comment) await api.call("POST", `${project}/issues/${n}/notes`, { body: comment });
      await api.call("PUT", `${project}/issues/${n}`, { state_event: "close" });
    },
  };
  return {
    kind: "gitlab",
    host,
    ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    principalOf: (login) => forgePrincipalOf("gitlab", host, login),
    ...threadCalls(t),
    async setStatus(sha, status) {
      try {
        await api.call("POST", `${project}/statuses/${sha}`, {
          state: GITLAB_STATE[status.state],
          name: status.context,
          description: status.description.slice(0, GITLAB_DESCRIPTION),
          ...(status.url ? { target_url: status.url } : {}),
          ...(status.pipelineId !== undefined ? { pipeline_id: status.pipelineId } : {}),
        });
      } catch (err) {
        // GitLab answers 400 to a status set again to the state it already
        // has ("Cannot transition status via :success from :success"): the
        // status is what was asked for.
        if (err instanceof ForgeApiError && err.status === 400 && /cannot transition status/i.test(err.message)) return;
        throw err;
      }
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
  /**
   * @param kind The forge, or undefined when the environment does not say which.
   * @param missing What is missing, each naming the variable to set.
   */
  constructor(
    readonly kind: ForgeKind | undefined,
    readonly missing: string[],
  ) {
    super(
      kind
        ? `--forge ${kind} needs ${missing.join(", ")} in the environment`
        : "the forge is not known: this is not a GitHub Actions, GitLab CI or Forgejo Actions job, so name the forge",
    );
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
 * A client for `kind` from the CI job's environment, as the pull-request
 * loop reads it. The token is `CHANT_FORGE_TOKEN` when set, else the forge's
 * own: `GITHUB_TOKEN` (also set on Forgejo Actions) or `GITLAB_TOKEN`.
 * GitLab's `CI_JOB_TOKEN` cannot write notes, so a GitLab pipeline names a
 * project access token. {@link forgeTargetFromEnv} is the general reading,
 * with the finding modes' token order.
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

// ── Where a CI job posts (#3759) ─────────────────────────────────────────

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined): boolean => v === "true" || v === "1";

/**
 * The forge a CI job runs on, from its environment, or undefined outside a
 * GitHub Actions, GitLab CI or Forgejo Actions job. Forgejo is told apart by
 * `FORGEJO_ACTIONS` or `GITEA_ACTIONS`, or by a GitHub-style job whose
 * `GITHUB_API_URL` ends in `/api/v1`, which GitHub never serves.
 */
export function detectForge(env: Env = process.env): ForgeKind | undefined {
  if (truthy(env.GITLAB_CI)) return "gitlab";
  if (truthy(env.FORGEJO_ACTIONS) || truthy(env.GITEA_ACTIONS)) return "forgejo";
  if (truthy(env.GITHUB_ACTIONS)) return /\/api\/v1\/?$/.test(env.GITHUB_API_URL ?? "") ? "forgejo" : "github";
  return undefined;
}

/** Where a CI job posts: the forge, the repository, the token, and the pull request and commit when there are ones. */
export interface ForgeTarget {
  kind: ForgeKind;
  /** The REST base: `https://api.github.com`, `<host>/api/v3`, `<host>/api/v1`, or `<host>/api/v4`. */
  apiBase: string;
  /** `owner/name` on GitHub and Forgejo; the project id or path on GitLab. */
  repo: string;
  /** Lower-cased. */
  host: string;
  token: string;
  /** The variable the token came from, for messages. Never the token itself. */
  tokenSource: string;
  /** GitLab: `JOB-TOKEN` when the token is `CI_JOB_TOKEN`, else `PRIVATE-TOKEN`. */
  tokenHeader?: "PRIVATE-TOKEN" | "JOB-TOKEN";
  /** The pull request's number, or the merge request's iid. */
  pr?: number;
  /** The commit a status belongs on: the pull request's head when the event names it. */
  sha?: string;
  /** The run, to link from a status. */
  runUrl?: string;
}

export interface ForgeTargetOptions {
  /** The forge, in place of {@link detectForge}. */
  kind?: ForgeKind;
  /** Read the token from this variable only, in place of the default order. */
  tokenEnv?: string;
  /** Refuse an environment with no pull or merge request. Default false. */
  requirePr?: boolean;
  /** Reads the event payload `GITHUB_EVENT_PATH` names. Default `node:fs`. */
  readFile?: (path: string) => string;
}

/**
 * The token order {@link forgeTargetFromEnv} reads, as guide/ops documents
 * it: a chant-specific variable first, for posting to an instance other than
 * the one the job runs on, then what the job already carries (#3802). A
 * Forgejo job reads `FORGEJO_TOKEN` before the `GITHUB_*` names, and the
 * GitHub row has its own chant variable rather than the Forgejo one.
 */
export const FORGE_TOKEN_ORDER: Record<ForgeKind, readonly string[]> = {
  github: ["CHANT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  forgejo: ["CHANT_FORGEJO_TOKEN", "FORGEJO_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  gitlab: ["CHANT_GITLAB_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN"],
};

/** The pull request and its head from a GitHub-style event payload, or from the ref. */
function prFromEvent(payload: unknown, ref: string | undefined): { pr?: number; sha?: string } {
  const out: { pr?: number; sha?: string } = {};
  if (isObject(payload)) {
    const pr = isObject(payload.pull_request) ? payload.pull_request : undefined;
    const issue = isObject(payload.issue) ? payload.issue : undefined;
    const n = num(pr?.number) ?? (issue && isObject(issue.pull_request) ? num(issue.number) : undefined) ?? (pr ? num(payload.number) : undefined);
    if (n !== undefined && n > 0) out.pr = n;
    const head = pr && isObject(pr.head) ? str(pr.head.sha) : undefined;
    if (head) out.sha = head;
  }
  if (out.pr === undefined) {
    const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref ?? "");
    if (m) out.pr = Number(m[1]);
  }
  return out;
}

/**
 * Where a CI job posts, read from its environment: the forge
 * ({@link detectForge} unless `kind` is given), the repository, the REST
 * base, the host, the token, and the pull request and its head commit when
 * the run has them. Throws {@link ForgeEnvironmentError} naming every
 * missing piece.
 *
 * - GitHub Actions: `GITHUB_REPOSITORY`, `GITHUB_API_URL` (default
 *   `https://api.github.com`), `GITHUB_SERVER_URL`; the pull request from
 *   the event payload at `GITHUB_EVENT_PATH` or `refs/pull/<n>/` in
 *   `GITHUB_REF`, its head from the payload, else `GITHUB_SHA`.
 * - Forgejo Actions: the same, with `FORGEJO_*` read before `GITHUB_*`,
 *   and the REST base `<server>/api/v1` when no API URL is set.
 * - GitLab CI: `CI_API_V4_URL` (or `CI_SERVER_URL/api/v4`), the merge
 *   request's project before the pipeline's (a fork's merge request runs in
 *   the fork), `CI_MERGE_REQUEST_IID`, `CI_COMMIT_SHA`, `CI_PIPELINE_URL`.
 *
 * The token is read in {@link FORGE_TOKEN_ORDER}, or from `tokenEnv` alone.
 */
export function forgeTargetFromEnv(env: Env = process.env, opts: ForgeTargetOptions = {}): ForgeTarget {
  const kind = opts.kind ?? detectForge(env);
  if (!kind) throw new ForgeEnvironmentError(undefined, []);
  const pick = (...names: string[]): string | undefined => names.map((n) => env[n]?.trim()).find((v) => v !== undefined && v !== "");
  const names = opts.tokenEnv ? [opts.tokenEnv] : FORGE_TOKEN_ORDER[kind];
  const tokenSource = names.find((n) => env[n]?.trim());
  const token = tokenSource ? env[tokenSource]!.trim() : undefined;
  const missing: string[] = [];
  const tokenMissing = `a token (${names.join(", ")})`;

  if (kind === "gitlab") {
    const server = pick("CI_SERVER_URL")?.replace(/\/+$/, "");
    const apiBase = pick("CI_API_V4_URL")?.replace(/\/+$/, "") ?? (server ? `${server}/api/v4` : undefined);
    const repo = pick("CI_MERGE_REQUEST_PROJECT_ID", "CI_PROJECT_ID", "CI_MERGE_REQUEST_PROJECT_PATH", "CI_PROJECT_PATH");
    const iid = num(pick("CI_MERGE_REQUEST_IID"));
    if (!apiBase) missing.push("CI_API_V4_URL");
    if (!repo) missing.push("CI_PROJECT_ID");
    if (opts.requirePr && !iid) missing.push("CI_MERGE_REQUEST_IID (a merge request pipeline)");
    if (!token) missing.push(tokenMissing);
    if (missing.length > 0) throw new ForgeEnvironmentError(kind, missing);
    const sha = pick("CI_MERGE_REQUEST_SOURCE_BRANCH_SHA", "CI_COMMIT_SHA");
    const runUrl = pick("CI_PIPELINE_URL");
    return {
      kind,
      apiBase: apiBase!,
      repo: repo!,
      host: pick("CI_SERVER_HOST")?.toLowerCase() ?? hostOf(server) ?? hostOf(apiBase) ?? "gitlab.com",
      token: token!,
      tokenSource: tokenSource!,
      tokenHeader: tokenSource === "CI_JOB_TOKEN" ? "JOB-TOKEN" : "PRIVATE-TOKEN",
      ...(iid ? { pr: iid } : {}),
      ...(sha ? { sha } : {}),
      ...(runUrl ? { runUrl } : {}),
    };
  }

  const fj = kind === "forgejo";
  const read = (name: string): string | undefined => (fj ? pick(`FORGEJO_${name}`, `GITHUB_${name}`) : pick(`GITHUB_${name}`));
  const repo = read("REPOSITORY");
  const server = read("SERVER_URL")?.replace(/\/+$/, "");
  const apiBase = read("API_URL")?.replace(/\/+$/, "") ?? (fj ? (server ? `${server}/api/v1` : undefined) : "https://api.github.com");
  let event: unknown;
  const eventPath = read("EVENT_PATH");
  if (eventPath) {
    try {
      event = JSON.parse((opts.readFile ?? ((p: string) => readFileSync(p, "utf8")))(eventPath));
    } catch {
      // An unreadable payload is not fatal: the ref may still name the pull request.
      event = undefined;
    }
  }
  const { pr, sha: head } = prFromEvent(event, read("REF"));
  if (!repo) missing.push(fj ? "FORGEJO_REPOSITORY or GITHUB_REPOSITORY" : "GITHUB_REPOSITORY");
  if (!apiBase) missing.push("GITHUB_SERVER_URL or GITHUB_API_URL");
  if (opts.requirePr && !pr) missing.push("a pull request (a pull_request event, or refs/pull/<n>/ in GITHUB_REF)");
  if (!token) missing.push(tokenMissing);
  if (missing.length > 0) throw new ForgeEnvironmentError(kind, missing);
  const sha = head ?? read("SHA");
  const runId = read("RUN_ID");
  const runUrl = server && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined;
  return {
    kind,
    apiBase: apiBase!,
    repo: repo!,
    host: hostOf(server) ?? (fj ? hostOf(apiBase)! : "github.com"),
    token: token!,
    tokenSource: tokenSource!,
    ...(pr ? { pr } : {}),
    ...(sha ? { sha } : {}),
    ...(runUrl ? { runUrl } : {}),
  };
}

/** The client for a {@link ForgeTarget}, from {@link forgeTargetFromEnv} or built by hand. */
export function forgeClient(target: ForgeTarget, fetchImpl?: ForgeFetch): PrForge {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  const run = target.runUrl ? { runUrl: target.runUrl } : {};
  if (target.kind === "gitlab") {
    return gitlabForge({
      apiBase: target.apiBase,
      project: target.repo,
      token: target.token,
      host: target.host,
      ...(target.tokenHeader ? { tokenHeader: target.tokenHeader } : {}),
      ...run,
      ...f,
    });
  }
  const opts = { apiBase: target.apiBase, repo: target.repo, token: target.token, host: target.host, ...run, ...f };
  return target.kind === "forgejo" ? forgejoForge(opts) : githubForge(opts);
}
