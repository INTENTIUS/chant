/**
 * What chant and the products built on it ask of a forge: keep one comment
 * (a merge request note on GitLab) on a pull request up to date, set a commit
 * status, keep one tracking issue in the repository, list who approved a pull
 * request, find the pull request that merged a commit, and open or edit a
 * pull request (a merge request on GitLab) for a branch.
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
 * Opening a pull request goes over REST too (#3798): `gh pr` speaks GitHub's
 * GraphQL, which Forgejo does not serve, so chant's own pull-request paths
 * open theirs through {@link PrForge.openPullRequest} on Forgejo and GitLab.
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
  /**
   * GitLab's own states, plus GitHub's `failure` and `error`. Each forge gets
   * the nearest state it has ({@link statusStateFor}): `running` is `pending`
   * on GitHub and Forgejo, `canceled` is `error` there, and `failure` and
   * `error` are `failed` on GitLab.
   */
  state: ForgeStatusState;
  /** Cut to what the forge keeps: 140 characters on GitHub and Forgejo, 255 on GitLab. */
  description: string;
  /** The pipeline run, linked from the status. */
  url?: string;
  /** GitLab only: the pipeline the status belongs to. */
  pipelineId?: number;
}

/** A runner job's commit status (#4097): the states GitHub and Forgejo both keep. */
export interface CommitStatus {
  context: string;
  state: "pending" | "success" | "failure" | "error";
  /** Cut to 140 characters. */
  description: string;
  /** Where the status links to. Omitted from the request when absent. */
  targetUrl?: string;
}

/** A commit status's state, as a caller names it. */
export type ForgeStatusState = "pending" | "running" | "success" | "failed" | "failure" | "canceled" | "error";

/** Every {@link ForgeStatusState}, for a caller that reads one from its own input. */
export const FORGE_STATUS_STATES: readonly ForgeStatusState[] = ["pending", "running", "success", "failed", "failure", "canceled", "error"];

/**
 * What each forge is sent for a {@link ForgeStatusState} (#3834). GitHub
 * keeps `pending`, `success`, `failure` and `error`; Forgejo the same and
 * `warning`; GitLab `pending`, `running`, `success`, `failed` and `canceled`.
 * A state the forge lacks becomes its nearest one.
 */
const STATUS_STATE: Record<"github" | "gitlab", Record<ForgeStatusState, string>> = {
  github: { pending: "pending", running: "pending", success: "success", failed: "failure", failure: "failure", canceled: "error", error: "error" },
  gitlab: { pending: "pending", running: "running", success: "success", failed: "failed", failure: "failed", canceled: "canceled", error: "failed" },
};

/** The state `kind` is sent for `state`. Forgejo takes GitHub's. */
export function statusStateFor(kind: ForgeKind, state: ForgeStatusState): string {
  const mapped = STATUS_STATE[kind === "gitlab" ? "gitlab" : "github"][state];
  if (mapped === undefined) throw new Error(`a commit status state is one of ${FORGE_STATUS_STATES.join(", ")}, not ${JSON.stringify(state)}`);
  return mapped;
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
   * Only a comment or issue written by this login, or by any of these
   * logins, counts: `user.login` on GitHub and Forgejo, `author.username` on
   * GitLab, compared without case. A merge request's author can write a note
   * carrying any marker, so a product that reads its own notes back names
   * its bot here. A list is for a bot whose login the job cannot know in
   * advance, such as `gitea-actions` or `forgejo-actions` on Forgejo (#3834).
   * An empty list matches nobody.
   */
  author?: string | readonly string[];
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

/** What {@link PrForge.addComment} posted. */
export interface AddedComment {
  /** The new comment's or note's id. */
  id: number;
  /** Its web URL, when the forge's answer carries one (GitHub and Forgejo do; a GitLab note does not). */
  url?: string;
}

/** An open tracking issue {@link PrForge.findIssue} read back. */
export interface FoundIssue {
  /** The issue's number (GitHub, Forgejo) or iid (GitLab). */
  number: number;
  title: string;
  body: string;
  /** When the issue was opened: the forge's `created_at`, an ISO 8601 string. */
  created?: string;
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
  /** When the issue was opened (the forge's `created_at`, ISO 8601), for an issue that exists after the call or was just closed. */
  created?: string;
}

/** A pull request (merge request) for {@link PrForge.openPullRequest} to open. */
export interface PullRequestSpec {
  /** The branch with the change, in the same repository. */
  head: string;
  /** The branch it merges into. Default: the repository's default branch, read from the forge. */
  base?: string;
  title: string;
  body: string;
  /**
   * Open it as a draft: GitHub's `draft`, GitLab's `Draft: ` title prefix,
   * Forgejo's `WIP: ` title prefix (it has no draft field).
   */
  draft?: boolean;
}

/** A pull request (merge request) as the forge answered it. */
export interface PullRequest {
  /** The pull request's number, or the merge request's iid. */
  number: number;
  url?: string;
  title: string;
  body: string;
  /** Its head (source) branch. */
  head: string;
  /** Its base (target) branch. */
  base?: string;
}

/** An open pull request as `chant ci serve` polls it (#4095). */
export interface OpenPullRequest {
  number: number;
  /** Its head branch. */
  head: string;
  /** The commit its head branch points at. */
  headSha: string;
  /** The branch it merges into. */
  base: string;
  /** The base branch's commit as the forge last measured the pull request against it. */
  baseSha?: string;
  /** Who opened it. */
  author?: string;
  /** Its head branch lives in another repository, a fork. */
  fork: boolean;
}

/** What {@link PrForge.mergePullRequest} merges, and how. */
export interface MergeOptions {
  /** The head commit the caller reviewed. The merge happens only while the pull request's head is still this commit. */
  sha: string;
  /** Default `merge`. GitLab has no one-call rebase merge, so `rebase` is refused there. */
  method?: "merge" | "squash" | "rebase";
  /** The merge (squash) commit's title. */
  title?: string;
  /** The merge (squash) commit's message body. */
  message?: string;
  /** Delete the head branch after a merge. A failure to delete does not undo the merge. */
  deleteBranch?: boolean;
}

/** The outcome of {@link PrForge.mergePullRequest}. */
export interface MergeResult {
  merged: boolean;
  /** The commit the merge produced, when the forge says. */
  sha?: string;
  /** Why it was not merged: the head moved, a conflict, a failing check, a required review. */
  reason?: string;
}

/** Statuses a forge answers a refused merge with: not allowed, head moved, conflict, invalid. */
const MERGE_REFUSED = new Set([405, 406, 409, 422]);

/** A refused merge as a result, any other failure rethrown. */
function refusedMerge(err: unknown): MergeResult {
  if (err instanceof ForgeApiError && MERGE_REFUSED.has(err.status)) {
    let reason = err.detail;
    try {
      const j = JSON.parse(err.detail) as Record<string, unknown>;
      const m = j.message ?? j.error;
      if (typeof m === "string") reason = m;
    } catch {
      /* not JSON: the raw text is the reason */
    }
    return { merged: false, reason: reason.slice(0, 300) || `the forge refused the merge (${err.status})` };
  }
  throw err;
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
  /**
   * Post a new comment on pull request `pr` (a new note on merge request
   * `pr`). No marker is looked for or required, and an earlier comment is
   * never edited: every call adds one. For replies, where
   * {@link upsertComment} would overwrite the last.
   */
  addComment(pr: number, body: string): Promise<AddedComment>;
  setStatus(sha: string, status: ForgeStatus): Promise<void>;
  /**
   * GitHub and Forgejo (#4097): set a commit status from a runner's job, one
   * of `pending`, `success`, `failure` or `error`. The request is the one
   * {@link setStatus} sends (`POST /repos/{owner}/{repo}/statuses/{sha}`), with
   * the description cut to 140 characters and `target_url` only when given.
   * `chant ci run` posts a job's progress through it.
   */
  setCommitStatus?(sha: string, status: CommitStatus): Promise<void>;
  /**
   * Keep one OPEN tracking issue for `marker` in line with `finding`: open
   * it, update its title and body, or, when `finding` is `null` and
   * `closeOnClear` is set, close it with a comment. Only open issues are
   * read, so an issue closed by hand stays closed. Pull requests are never
   * taken for issues. When several match, the oldest is kept.
   */
  trackIssue(marker: string, finding: IssueFinding | null, opts?: TrackIssueOptions): Promise<IssueResult>;
  /**
   * The OPEN issue {@link trackIssue} would keep for `marker`: the oldest one
   * {@link MarkerMatch} finds, `author` honoured, pull requests left out.
   * Undefined when there is none. Writes nothing, so a client built without a
   * token reads a public repository's issue with it.
   */
  findIssue(marker: string, opts?: MarkerMatch): Promise<FoundIssue | undefined>;
  /**
   * {@link trackIssue} by prefix for a finding, without the body check,
   * resolving to the issue's web URL. `reconcilePr`'s `issue` mode's form.
   */
  upsertIssue(marker: string, title: string, body: string): Promise<string | undefined>;
  /** Logins whose standing review approves `pr`. */
  approvers(pr: number): Promise<string[]>;
  /**
   * Logins of the people who wrote `pr` (#4000): its author, and the author
   * and committer of each of its commits. GitHub and Forgejo name a commit's
   * people by the account its email belongs to; a commit whose email is on no
   * account adds nobody. GitLab names them by email only, so each email is
   * looked up among the users (`GET /users?search=`), which matches an
   * account's public email; an email no account shows publicly adds nobody.
   * Sorted, without repeats.
   */
  authors(pr: number): Promise<string[]>;
  /** The merged pull request that produced `sha`, or null. */
  pullRequestFor(sha: string): Promise<number | null>;
  /**
   * Whether pull request `pr` (merge request `pr` on GitLab) is still open
   * (#4293): neither merged nor closed. A pull request the forge does not
   * know reads as not open. Target locks (../lifecycle/target-lock.ts) read
   * a lock whose holder is not open as released.
   */
  pullRequestOpen?(pr: number): Promise<boolean>;
  /**
   * Open a pull request (a merge request on GitLab) from `head` into `base`,
   * or into the default branch when `base` is not given. Over REST on every
   * forge, so it works on Forgejo, where `gh pr create` cannot (#3798).
   */
  openPullRequest(spec: PullRequestSpec): Promise<PullRequest>;
  /**
   * The OPEN pull request whose head is branch `head` in this repository (a
   * fork's branch of the same name is not it), or undefined. The oldest when
   * there are several.
   */
  findPullRequest(head: string): Promise<PullRequest | undefined>;
  /** Change an open pull request's title or body. */
  editPullRequest(pr: number, change: { title?: string; body?: string }): Promise<PullRequest | undefined>;
  /** Add labels to a pull request by name. Forgejo needs them to exist; GitHub and GitLab make them. */
  addLabels(pr: number, labels: readonly string[]): Promise<void>;
  /** The names of the labels pull request `pr` carries (#4292), for `ci.labels`. */
  labels?(pr: number): Promise<string[]>;
  /**
   * Merge pull request `pr` only if its head is still `opts.sha`. A moved
   * head, a conflict or a branch rule the forge enforces comes back as
   * `{ merged: false, reason }`; auth, missing-pull-request and server errors
   * still throw.
   */
  mergePullRequest(pr: number, opts: MergeOptions): Promise<MergeResult>;
  /**
   * GitHub and Forgejo (#4095): every open pull request into `base`, with
   * its head commit, oldest first. `chant ci serve` polls it.
   */
  openPullRequests?(base: string): Promise<OpenPullRequest[]>;
  /** GitHub and Forgejo (#4095): the commit `branch` points at, or undefined when there is no such branch. */
  branchHead?(branch: string): Promise<string | undefined>;
  /**
   * When a scheduled Op's generated job last ran from its schedule or by hand
   * (#4289). GitHub reads the workflow `workflow` names and its `schedule` and
   * `workflow_dispatch` runs. Forgejo reads the repository's runs and keeps
   * the ones from that workflow file. GitLab reads the active pipeline
   * schedules whose `CHANT_SCHEDULED_OP` variable is `op` and their last
   * pipelines. Throws a {@link ForgeApiError} when the forge will not say.
   */
  scheduledRuns?(query: ScheduledRunsQuery): Promise<ScheduledRuns>;
}

/** Which scheduled Op job {@link PrForge.scheduledRuns} asks about. */
export interface ScheduledRunsQuery {
  /** The Op's name, the value of GitLab's `CHANT_SCHEDULED_OP` selector. */
  op: string;
  /** GitHub and Forgejo: the Op's workflow file name, such as `drift-watch.yml`. */
  workflow: string;
}

/** What a forge says about a scheduled Op job's runs (#4289). */
export interface ScheduledRuns {
  /** When the job last ran from its schedule or by hand (ISO 8601), if it ever did. */
  last?: string;
  /** GitHub: the workflow is off, and why (`disabled_inactivity`, `disabled_manually`). */
  disabled?: string;
  /** GitLab: no active pipeline schedule selects the Op. */
  noSchedule?: boolean;
}

/** The newest of some ISO 8601 times, ignoring what does not parse. */
function newestTime(times: readonly (string | undefined)[]): string | undefined {
  return times.filter((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/** A GitHub or Forgejo client. */
export type GithubShapedForge = PrForge & { kind: "github" | "forgejo" };

/** Thrown when a forge answers a call with an error status. */
export class ForgeApiError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly detail: string,
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
  /** An issue's `created_at`. */
  created?: string;
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

/** Whether `author` is one of `want`, without case. No `want` (or `""`) takes anyone. */
const authorIn = (want: MarkerMatch["author"], author: string | undefined): boolean => {
  if (want === undefined || want === "") return true;
  const logins = (typeof want === "string" ? [want] : want).map((l) => l.toLowerCase());
  return author !== undefined && logins.includes(author.toLowerCase());
};

const ownedBy = (marker: string, opts: MarkerMatch) => (t: Thread): boolean =>
  carries(t.body, marker, opts.match) && authorIn(opts.author, t.author);

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
  const at = (i: Thread | undefined): Omit<IssueResult, "action"> =>
    i ? { number: i.id, ...(i.url ? { url: i.url } : {}), ...(i.created ? { created: i.created } : {}) } : {};
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
function threadCalls(t: Threads): Pick<PrForge, "upsertComment" | "upsertNote" | "findComment" | "addComment" | "trackIssue" | "findIssue" | "upsertIssue"> {
  return {
    async addComment(pr, body) {
      const made = await t.addComment(pr, body);
      return { id: made?.id ?? 0, ...(made?.url ? { url: made.url } : {}) };
    },
    async findIssue(marker, opts = {}) {
      if (!marker) throw new Error("the issue needs a marker to be found");
      const i = (await t.openIssues(marker)).filter(ownedBy(marker, opts)).sort((a, b) => a.id - b.id)[0];
      return i ? { number: i.id, title: i.title ?? "", body: i.body, ...(i.created ? { created: i.created } : {}), ...(i.url ? { url: i.url } : {}) } : undefined;
    },
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
  /** Without one, no credential is sent: enough to read a public repository ({@link PrForge.findComment}, {@link PrForge.findIssue}). */
  token?: string;
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
      ? { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), Accept: "application/vnd.github+json" }
      : { ...(opts.token ? { Authorization: `token ${opts.token}` } : {}), Accept: "application/json" },
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
    const created = str(v.created_at);
    return { id, body: str(v.body) ?? "", ...(created ? { created } : {}), ...(str(v.title) !== undefined ? { title: str(v.title) } : {}), ...(author ? { author } : {}), ...(url ? { url } : {}) };
  };
  const threads = (items: unknown[]): Thread[] => items.map(thread).filter((t): t is Thread => t !== undefined);
  const pull = (v: unknown): PullRequest | undefined => {
    if (!isObject(v)) return undefined;
    const number = num(v.number);
    const head = isObject(v.head) ? str(v.head.ref) : undefined;
    if (number === undefined) return undefined;
    const base = isObject(v.base) ? str(v.base.ref) : undefined;
    const url = str(v.html_url);
    return { number, title: str(v.title) ?? "", body: str(v.body) ?? "", head: head ?? "", ...(base ? { base } : {}), ...(url ? { url } : {}) };
  };
  /** A pull request whose head branch lives in this repository, not a fork. */
  const fromHere = (v: unknown, head: string): boolean => {
    if (!isObject(v) || !isObject(v.head) || v.head.ref !== head) return false;
    const full = isObject(v.head.repo) ? str(v.head.repo.full_name) : undefined;
    return full === undefined || full.toLowerCase() === opts.repo.toLowerCase();
  };
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
  const postStatus = async (sha: string, state: ForgeStatusState, context: string, description: string, url?: string): Promise<void> => {
    await api.call("POST", `${repo}/statuses/${sha}`, {
      state: statusStateFor(kind, state),
      context,
      description: description.slice(0, GITHUB_DESCRIPTION),
      ...(url ? { target_url: url } : {}),
    });
  };
  return {
    kind,
    host,
    ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    principalOf: (login) => forgePrincipalOf(kind, host, login),
    ...threadCalls(t),
    async setStatus(sha, status) {
      await postStatus(sha, status.state, status.context, status.description, status.url);
    },
    async setCommitStatus(sha, status) {
      await postStatus(sha, status.state, status.context, status.description, status.targetUrl);
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
    async authors(pr) {
      const logins = new Set<string>();
      const add = (v: unknown) => {
        if (isObject(v) && typeof v.login === "string" && v.login !== "") logins.add(v.login);
      };
      const opened = await api.call("GET", `${repo}/pulls/${pr}`);
      if (isObject(opened)) add(opened.user);
      for (const c of await api.list(`${repo}/pulls/${pr}/commits`, pageParams, pageSize)) {
        if (!isObject(c)) continue;
        add(c.author);
        add(c.committer);
      }
      return [...logins].sort();
    },
    async pullRequestOpen(pr) {
      try {
        const got = await api.call("GET", `${repo}/pulls/${pr}`);
        return isObject(got) && got.state === "open" && got.merged !== true;
      } catch (err) {
        if (err instanceof ForgeApiError && err.status === 404) return false;
        throw err;
      }
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
    async openPullRequest(spec) {
      const base = spec.base ?? (await defaultBranchOf(api, repo, "default_branch"));
      const title = spec.draft && kind === "forgejo" ? `WIP: ${spec.title}` : spec.title;
      const made = await api.call("POST", `${repo}/pulls`, {
        title,
        body: spec.body,
        head: spec.head,
        base,
        ...(spec.draft && kind === "github" ? { draft: true } : {}),
      });
      return pull(made) ?? { number: 0, title, body: spec.body, head: spec.head, base };
    },
    async findPullRequest(head) {
      // GitHub filters by `owner:branch` server-side; Forgejo's list takes no
      // head filter, so every open page is read and matched here.
      const owner = opts.repo.split("/")[0];
      const query = kind === "github" ? `?state=open&head=${encodeURIComponent(`${owner}:${head}`)}` : "?state=open";
      let listed: unknown[];
      try {
        listed = await api.list(`${repo}/pulls${query}`, pageParams, pageSize);
      } catch (err) {
        // Forgejo answers the list with 404 while it still counts the repository
        // as empty (just after the first push). That is no pull request; a
        // repository that is really missing 404s on its own read too.
        if (kind !== "forgejo" || !(err instanceof ForgeApiError) || err.status !== 404) throw err;
        await api.call("GET", repo);
        return undefined;
      }
      const open = listed.filter((p) => fromHere(p, head));
      return open.map(pull).filter((p): p is PullRequest => p !== undefined).sort((a, b) => a.number - b.number)[0];
    },
    async openPullRequests(base) {
      // GitHub filters by base server-side; Forgejo's list is matched here.
      const query = kind === "github" ? `?state=open&base=${encodeURIComponent(base)}` : "?state=open";
      let listed: unknown[];
      try {
        listed = await api.list(`${repo}/pulls${query}`, pageParams, pageSize);
      } catch (err) {
        // Forgejo answers 404 while it counts the repository as empty, as findPullRequest notes.
        if (kind !== "forgejo" || !(err instanceof ForgeApiError) || err.status !== 404) throw err;
        await api.call("GET", repo);
        return [];
      }
      const out: OpenPullRequest[] = [];
      for (const v of listed) {
        if (!isObject(v) || !isObject(v.head) || !isObject(v.base)) continue;
        const number = num(v.number);
        const head = str(v.head.ref);
        const headSha = str(v.head.sha);
        const into = str(v.base.ref);
        if (number === undefined || !head || !headSha || into !== base) continue;
        const baseSha = str(v.base.sha);
        const author = isObject(v.user) ? str(v.user.login) : undefined;
        out.push({ number, head, headSha, base: into, ...(baseSha ? { baseSha } : {}), ...(author ? { author } : {}), fork: !fromHere(v, head) });
      }
      return out.sort((a, b) => a.number - b.number);
    },
    async branchHead(branch) {
      let b: unknown;
      try {
        b = await api.call("GET", `${repo}/branches/${branch.split("/").map(encodeURIComponent).join("/")}`);
      } catch (err) {
        if (err instanceof ForgeApiError && err.status === 404) return undefined;
        throw err;
      }
      // GitHub names the commit `sha`, Forgejo `id`.
      const commit = isObject(b) && isObject(b.commit) ? b.commit : undefined;
      return commit ? str(commit.sha) ?? str(commit.id) : undefined;
    },
    async scheduledRuns(q) {
      const file = encodeURIComponent(q.workflow);
      if (kind === "github") {
        const workflow = await api.call("GET", `${repo}/actions/workflows/${file}`);
        const runs = await Promise.all(["schedule", "workflow_dispatch"].map((event) => api.call("GET", `${repo}/actions/workflows/${file}/runs?event=${event}&per_page=1`)));
        const last = newestTime(runs.flatMap((r) => (isObject(r) && Array.isArray(r.workflow_runs) ? r.workflow_runs.map((w) => (isObject(w) ? str(w.created_at) : undefined)) : [])));
        const state = (isObject(workflow) ? str(workflow.state) : undefined) ?? "active";
        return { ...(last ? { last } : {}), ...(state.startsWith("disabled") ? { disabled: state } : {}) };
      }
      // Forgejo lists a repository's runs newest first; the event and the workflow are read from each run, whatever the query honours.
      const listed = await api.call("GET", `${repo}/actions/runs?event=schedule&limit=50`);
      const runs = Array.isArray(listed) ? listed : isObject(listed) && Array.isArray(listed.workflow_runs) ? listed.workflow_runs : [];
      const ours = runs.filter((r): r is Record<string, unknown> => {
        if (!isObject(r)) return false;
        const event = str(r.event) ?? str(r.trigger_event);
        const workflow = str(r.workflow_id) ?? str(r.path);
        return (event === "schedule" || event === "workflow_dispatch") && (workflow === undefined || workflow.endsWith(q.workflow));
      });
      const last = newestTime(ours.map((r) => str(r.created) ?? str(r.created_at) ?? str(r.started)));
      return last ? { last } : {};
    },
    async editPullRequest(pr, change) {
      return pull(await api.call("PATCH", `${repo}/pulls/${pr}`, { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.body !== undefined ? { body: change.body } : {}) }));
    },
    async addLabels(pr, labels) {
      if (labels.length === 0) return;
      await api.call("POST", `${repo}/issues/${pr}/labels`, { labels: [...labels] });
    },
    async labels(pr) {
      const listed = await api.list(`${repo}/issues/${pr}/labels`, pageParams, pageSize);
      return listed.map((l) => (isObject(l) ? str(l.name) : undefined)).filter((n): n is string => n !== undefined);
    },
    async mergePullRequest(pr, m) {
      const method = m.method ?? "merge";
      let res: unknown;
      try {
        res =
          kind === "github"
            ? await api.call("PUT", `${repo}/pulls/${pr}/merge`, {
                sha: m.sha,
                merge_method: method,
                ...(m.title !== undefined ? { commit_title: m.title } : {}),
                ...(m.message !== undefined ? { commit_message: m.message } : {}),
              })
            : await api.call("POST", `${repo}/pulls/${pr}/merge`, {
                Do: method,
                head_commit_id: m.sha,
                ...(m.title !== undefined ? { MergeTitleField: m.title } : {}),
                ...(m.message !== undefined ? { MergeMessageField: m.message } : {}),
                ...(m.deleteBranch ? { delete_branch_after_merge: true } : {}),
              });
      } catch (err) {
        return refusedMerge(err);
      }
      if (isObject(res) && res.merged === false) return { merged: false, reason: str(res.message) ?? "the forge did not merge it" };
      // Forgejo answers an empty body, so the merge commit is read back.
      const after = await api.call("GET", `${repo}/pulls/${pr}`).catch(() => undefined);
      const sha = (isObject(res) ? str(res.sha) : undefined) ?? (isObject(after) ? str(after.merge_commit_sha) : undefined);
      if (kind === "github" && m.deleteBranch && isObject(after) && isObject(after.head) && str(after.head.ref) && fromHere(after, str(after.head.ref) as string)) {
        const ref = (str(after.head.ref) as string).split("/").map(encodeURIComponent).join("/");
        await api.call("DELETE", `${repo}/git/refs/heads/${ref}`).catch(() => undefined);
      }
      return { merged: true, ...(sha ? { sha } : {}) };
    },
  };
}

/** The repository's default branch, from `GET` on the repository (`/repos/{repo}`, `/projects/{id}`). */
async function defaultBranchOf(api: Transport, path: string, field: string): Promise<string> {
  const r = await api.call("GET", path);
  const branch = isObject(r) ? str(r[field]) : undefined;
  if (!branch) throw new Error(`${path} names no default branch to open the pull request against; pass base`);
  return branch;
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
  /** Without one, no credential is sent: enough to read a public project ({@link PrForge.findComment}, {@link PrForge.findIssue}). */
  token?: string;
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

/**
 * A GitLab client. Writing notes needs an access token with the `api` scope
 * on most instances: the job token reaches only the endpoints the instance's
 * job-token allowlist names.
 */
export function gitlabForge(opts: GitlabForgeOptions): PrForge {
  const host = (opts.host ?? "gitlab.com").toLowerCase();
  const api = transport(opts.apiBase, opts.token ? { [opts.tokenHeader ?? "PRIVATE-TOKEN"]: opts.token } : {}, opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch));
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
    const created = str(v.created_at);
    return { id, body: str(v.description) ?? "", ...(created ? { created } : {}), ...(str(v.title) !== undefined ? { title: str(v.title) } : {}), ...(author ? { author } : {}), ...(url ? { url } : {}) };
  };
  const notes = `${project}/merge_requests`;
  const mergeRequest = (v: unknown): PullRequest | undefined => {
    if (!isObject(v)) return undefined;
    const number = num(v.iid);
    if (number === undefined) return undefined;
    const base = str(v.target_branch);
    const url = str(v.web_url);
    return { number, title: str(v.title) ?? "", body: str(v.description) ?? "", head: str(v.source_branch) ?? "", ...(base ? { base } : {}), ...(url ? { url } : {}) };
  };
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
          state: statusStateFor("gitlab", status.state),
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
    async authors(mr) {
      const logins = new Set<string>();
      const merge = await api.call("GET", `${notes}/${mr}`);
      const author = isObject(merge) ? authorOf(merge) : undefined;
      if (author) logins.add(author);
      const emails = new Set<string>();
      for (const c of await api.list(`${notes}/${mr}/commits`, pageParams, 100)) {
        if (!isObject(c)) continue;
        for (const email of [str(c.author_email), str(c.committer_email)]) if (email) emails.add(email.toLowerCase());
      }
      for (const email of [...emails].sort()) {
        const users = await api.call("GET", `/users?search=${encodeURIComponent(email)}`);
        for (const u of Array.isArray(users) ? users : []) if (isObject(u) && typeof u.username === "string") logins.add(u.username);
      }
      return [...logins].sort();
    },
    async pullRequestOpen(mr) {
      try {
        const got = await api.call("GET", `${notes}/${mr}`);
        return isObject(got) && got.state === "opened";
      } catch (err) {
        if (err instanceof ForgeApiError && err.status === 404) return false;
        throw err;
      }
    },
    async pullRequestFor(sha) {
      const mrs = await api.call("GET", `${project}/repository/commits/${sha}/merge_requests`);
      if (!Array.isArray(mrs)) return null;
      const merged = mrs.find((m) => isObject(m) && m.state === "merged" && (m.merge_commit_sha === sha || m.squash_commit_sha === sha))
        ?? mrs.find((m) => isObject(m) && m.state === "merged");
      return isObject(merged) && typeof merged.iid === "number" ? merged.iid : null;
    },
    async openPullRequest(spec) {
      const base = spec.base ?? (await defaultBranchOf(api, project, "default_branch"));
      const title = spec.draft ? `Draft: ${spec.title}` : spec.title;
      const made = await api.call("POST", notes, { source_branch: spec.head, target_branch: base, title, description: spec.body });
      return mergeRequest(made) ?? { number: 0, title, body: spec.body, head: spec.head, base };
    },
    async findPullRequest(head) {
      const open = await api.list(`${notes}?state=opened&source_branch=${encodeURIComponent(head)}`, pageParams, 100);
      return open
        // A fork's merge request into this project has another source project.
        .filter((m) => isObject(m) && m.source_branch === head && (m.source_project_id === undefined || m.source_project_id === m.project_id))
        .map(mergeRequest)
        .filter((m): m is PullRequest => m !== undefined)
        .sort((a, b) => a.number - b.number)[0];
    },
    async scheduledRuns(q) {
      // The variable the gitlab lexicon's generated Op file selects a scheduled job by.
      const selects = (d: unknown): boolean =>
        isObject(d) && Array.isArray(d.variables) && d.variables.some((v) => isObject(v) && v.key === "CHANT_SCHEDULED_OP" && v.value === q.op);
      const schedules = await api.list(`${project}/pipeline_schedules?scope=active`, pageParams, 100);
      // A schedule's variables are on each schedule, not the list.
      const details = await Promise.all(schedules.map((s) => api.call("GET", `${project}/pipeline_schedules/${isObject(s) ? num(s.id) : ""}`)));
      const ours = details.filter(selects);
      const ids = ours.map((d) => (isObject(d) && isObject(d.last_pipeline) ? num(d.last_pipeline.id) : undefined)).filter((n): n is number => n !== undefined && n > 0);
      const pipelines = await Promise.all(ids.map((id) => api.call("GET", `${project}/pipelines/${id}`)));
      const last = newestTime(pipelines.map((p) => (isObject(p) ? str(p.created_at) : undefined)));
      return { ...(last ? { last } : {}), ...(ours.length === 0 ? { noSchedule: true } : {}) };
    },
    async editPullRequest(mr, change) {
      return mergeRequest(await api.call("PUT", `${notes}/${mr}`, { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.body !== undefined ? { description: change.body } : {}) }));
    },
    async addLabels(mr, labels) {
      if (labels.length === 0) return;
      await api.call("PUT", `${notes}/${mr}`, { add_labels: labels.join(",") });
    },
    async labels(mr) {
      const m = await api.call("GET", `${notes}/${mr}`);
      return isObject(m) && Array.isArray(m.labels) ? m.labels.filter((l): l is string => typeof l === "string") : [];
    },
    async mergePullRequest(mr, m) {
      const method = m.method ?? "merge";
      if (method === "rebase") throw new Error("GitLab has no one-call rebase merge; use method merge or squash");
      const text = m.title !== undefined ? (m.message ? `${m.title}\n\n${m.message}` : m.title) : m.message;
      let res: unknown;
      try {
        res = await api.call("PUT", `${notes}/${mr}/merge`, {
          sha: m.sha,
          ...(method === "squash" ? { squash: true, ...(text !== undefined ? { squash_commit_message: text } : {}) } : {}),
          ...(text !== undefined ? { merge_commit_message: text } : {}),
          ...(m.deleteBranch ? { should_remove_source_branch: true } : {}),
        });
      } catch (err) {
        return refusedMerge(err);
      }
      const sha = isObject(res) ? (str(res.merge_commit_sha) ?? str(res.squash_commit_sha)) : undefined;
      if (isObject(res) && res.state !== undefined && res.state !== "merged") return { merged: false, reason: `the merge request is ${String(res.state)}` };
      return { merged: true, ...(sha ? { sha } : {}) };
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
