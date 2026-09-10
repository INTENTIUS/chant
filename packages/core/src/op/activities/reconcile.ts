import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * What the reconcile activity does with the regenerated source.
 *
 * `comment` is the one mode that posts nothing new: it writes the body onto
 * the pull request that triggered the run, updating the same comment on every
 * re-run (chant #2231). It therefore needs a pull-request trigger, and
 * {@link resolvePullRequestContext} fails the step by name when the run has
 * none.
 *
 * On GitLab the same mode writes a merge-request note (chant #2256): the same
 * marker, the same edit-in-place, a different API. Which forge a run is on is
 * read off the run's own CI variables rather than configured — a
 * `merge_request_event` pipeline sets `CI_MERGE_REQUEST_IID`, a GitHub
 * `pull_request` event sets `GITHUB_REPOSITORY`, and no run sets both. See
 * {@link mergeRequestContextFrom}.
 *
 * On Forgejo the same mode posts the same GitHub-shaped comment (chant
 * #2291): no forge split at all, because a Forgejo Actions job already sets
 * `GITHUB_REPOSITORY`, `GITHUB_API_URL` and `github.token` the same way a
 * GitHub Actions job does, and Forgejo's own `/api/v1` takes the identical
 * GET/POST/PATCH triple. The one thing that needed fixing was the URL: `gh
 * api` resolves a *relative* path against `/api/v3` for any host other than
 * `github.com`, and Forgejo does not serve `/api/v3` — verified on a real
 * Forgejo 12.0.4+gitea-1.22.0 instance during INTENTIUS/choudoufu#1027. See
 * {@link postOrUpdateComment} and {@link githubApiBaseFrom}.
 *
 * `issue` needs no merge/pull request — its whole point is a cron trigger
 * that has none — so its forge split reads off a wider signal: any GitLab CI
 * job sets `CI_PROJECT_ID`, not only a merge-request one (see {@link
 * gitlabProjectContextFrom}), and any GitHub Actions or Forgejo Actions job
 * sets `GITHUB_REPOSITORY`. Both are sticky now (chant #2292, #2297): each
 * finds and edits the OPEN issue it already owns by a hidden marker, the same
 * recipe `comment` mode's note uses, and opens a new one only when it finds
 * none. Which is why that marker has to name the Op (chant #2319) and why
 * this mode refuses a step that supplies neither an `op` nor a `marker` — see
 * {@link issueMarker} and {@link noIssueIdentityMessage}.
 *
 * none. See {@link postOrUpdateGithubIssue} for the GitHub/GHES/Forgejo half
 * — including why it does not use GitHub's Search API, and the decision that
 * this mode never closes the issue itself. Only a run outside any known CI
 * job — no `CI_PROJECT_ID`, no `GITHUB_REPOSITORY` — falls back to `gh issue
 * create`'s own ambient repo detection, still marker-prefixed so a later CI
 * run of the same Op finds and edits it instead of opening a second one.
 *
 * The credential did not always travel (chant #2320). The URL and the
 * GET/PATCH/POST triple matched `postOrUpdateComment`'s, but that function
 * resolved a token through {@link commentTokenFrom} and forwarded it as
 * `GH_TOKEN` while the issue path forwarded no environment at all, so
 * `CHANT_FORGEJO_TOKEN` never reached `gh`. Both paths now resolve the same
 * way, in the same order, and forward the same variable, with the two
 * refusals differing only in what they name ({@link noCommentTokenMessage},
 * {@link noIssueTokenMessage}). The one deliberate exception is the `gh issue
 * create` fallback above, which runs outside every CI job and so leaves the
 * credential to `gh auth login` — see the comment on that branch. Parity with
 * `comment` mode is not a working Forgejo write, as the next paragraph says.
 *
 * Settled against a real Forgejo 12.0.4+gitea-1.22.0 instance under chant
 * #2315, the way `comment` mode's endpoints were under #2291: the *read*
 * half works — plain paginated listing (no `/search/issues`, confirmed
 * absent from Forgejo's own OpenAPI spec) and the `.pull_request == null`
 * filter both behave exactly as they do against github.com. The *write*
 * half did not, for a reason no mock could have caught: `gh`'s own
 * `GH_TOKEN`/`GITHUB_TOKEN` only authenticate a request to github.com or a
 * ghe.com subdomain (`gh help environment`), never a self-hosted Forgejo,
 * and both this function's POST/PATCH calls and `postOrUpdateComment`'s
 * carried only `GH_TOKEN`. Every write either made on a real Forgejo
 * instance failed with `{"message":"token is required"}` (HTTP 401), with
 * `GH_DEBUG=api` showing no `Authorization` header at all — which is what
 * shipped in 0.62.0 and 0.63.0, `comment` mode included.
 *
 * Both paths now forward that credential as `GH_ENTERPRISE_TOKEN` as well as
 * `GH_TOKEN`, which is the variable `gh` reads for a host in neither of those
 * two classes (chant #2333). Re-run against the same live instance from a
 * shell with no stored `gh auth login`, the identical POST now sends
 * `Authorization: token …` and returns HTTP 201. See {@link ghCredentialEnv}
 * for the whole probe, for why `GH_HOST` turned out not to be needed
 * alongside it, and for why github.com's own behavior is untouched.
 */
export type ReconcileMode = "pull-request" | "issue" | "report" | "comment";

/** A change-set entry that triggered reconciliation. */
export interface ReconcileEntry {
  /** chant entity name. */
  name: string;
  /** create | update | delete | adopt | noop (from `chant lifecycle plan`). */
  action: string;
  /** Resource type, when known. */
  type?: string;
}

export interface ReconcilePrArgs {
  /** Environment to reconcile from (passed to `chant import --from`). */
  env: string;
  /**
   * The change-set entries that triggered this reconcile. Omit to derive them
   * from `chant lifecycle plan <env> --json` at run time — the form used inside
   * an Op, where the entries aren't known until the activity runs.
   */
  entries?: ReconcileEntry[];
  /** What to produce. Default: pull-request. */
  mode?: ReconcileMode;
  /** Output directory for regenerated source. Default: ./infra. */
  output?: string;
  /** Branch to open the PR from. Default: chant/reconcile-<env>. */
  branch?: string;
  /** Restrict live import to chant-owned resources. */
  owned?: boolean;
  /** PR / issue title. Default derived from env. */
  title?: string;
  /**
   * The name of the Op this step belongs to, which is what makes an `issue`
   * mode marker unique (#2319) — see {@link issueMarker}. Set it to the
   * enclosing `Op`'s own `name`; both in-tree composites do, and a
   * hand-written step should too.
   *
   * `issue` mode needs this or an explicit `marker`, and refuses by name
   * ({@link noIssueIdentityMessage}) with neither: without one the marker
   * falls back to naming only the env, two Ops over one env collide on it,
   * and each nightly run silently overwrites the other's report.
   *
   * `comment` mode ignores it. That mode's marker is scoped to one pull
   * request rather than to the repository, so its collision (two `comment`
   * Ops over one env, both triggered by one pull request) is bounded by that
   * pull request's life and leaves nothing behind. Tracked separately rather
   * than folded in here, because changing `commentMarker` would orphan the
   * comments already sitting on open pull requests.
   */
  op?: string;
  /**
   * Hidden marker identifying this Op's own comment or issue. The activity
   * writes it as the first line and finds it again by it on the next run, so
   * a re-run edits one comment/issue instead of stacking a new one. Default:
   * {@link commentMarker} for `comment` mode, keyed on `env`; {@link
   * issueMarker} for `issue` mode, keyed on `op` and `env` together. Supply
   * it directly to own uniqueness yourself — in `issue` mode that is the one
   * way to satisfy the identity requirement without passing `op`.
   */
  marker?: string;
  /**
   * A finding body built by the caller, used verbatim as the issue/PR body in
   * place of {@link reconcileSummary} (chant #2087).
   *
   * The summary this activity writes itself is a change-set table, which is
   * the right artifact when the finding IS a change set. Some observe-dial
   * Ops already hold a better one: `TerraformWatchOp` carries the
   * `terraform plan -no-color` render its own Plan step produced, and
   * re-deriving that from `chant lifecycle plan` here would both lose the
   * plan and run a second, differently-timed read.
   *
   * Supplying it also suppresses the `chant lifecycle plan --json` derivation
   * that fills `entries`: a caller that already knows what it wants to say
   * is not asking this activity to go and find out.
   */
  body?: string;
}

export interface ReconcileResult {
  mode: ReconcileMode;
  /** Branch created (pull-request mode). */
  branch?: string;
  /** Opened PR URL (pull-request mode). */
  prUrl?: string;
  /** Opened or edited issue URL (issue mode; sticky on every forge — #2292, #2297). */
  issueUrl?: string;
  /** The posted or updated PR comment / MR note URL (comment mode). */
  commentUrl?: string;
  /** The pull request the comment landed on, `owner/repo#number` (comment mode, GitHub). */
  pullRequest?: string;
  /** The merge request the note landed on, `group/project!iid` (comment mode, GitLab — #2256). */
  mergeRequest?: string;
  /** The markdown summary used as the PR/issue body. */
  summary: string;
  /** The entries that triggered the reconcile. */
  entries: ReconcileEntry[];
}

/** Default branch name for a reconcile PR. Deterministic — no timestamp. */
export function reconcileBranchName(env: string): string {
  const safe = env.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `chant/reconcile-${safe}`;
}

/**
 * Build the markdown body summarizing which change-set entries triggered the
 * reconcile. Pure — used as the PR/issue body and returned in `report` mode.
 */
export function reconcileSummary(env: string, entries: ReconcileEntry[]): string {
  const lines = [
    `Reconcile from live environment \`${env}\`.`,
    "",
    "This PR regenerates chant TypeScript from live state to close the gap between the cloud and source. It was triggered by the following change-set entries:",
    "",
    "| Entry | Action | Type |",
    "|---|---|---|",
  ];
  for (const e of entries) {
    lines.push(`| ${e.name} | ${e.action} | ${e.type ?? ""} |`);
  }
  if (entries.length === 0) {
    lines.push("| _(none)_ | | |");
  }
  lines.push("");
  lines.push("Review the diff before merging — live import may surface values that need redaction.");
  return lines.join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The pull request a `comment`-mode run posts onto. */
export interface PullRequestContext {
  /** `owner/repo`, from `GITHUB_REPOSITORY`. */
  repo: string;
  /** The pull request number. */
  number: number;
}

/**
 * The hidden marker that makes a `comment`-mode finding findable across
 * re-runs: written as the comment's first line, matched with `startswith` on
 * the next run. Keyed on `env` (slugified the same way {@link
 * reconcileBranchName} slugifies it, which also keeps the value free of the
 * quotes and backslashes it is interpolated next to), so two Ops over two
 * environments own two comments and each updates in place.
 */
export function commentMarker(env: string): string {
  return `<!-- chant-reconcile:${markerSlug(env)} -->`;
}

/**
 * The hidden marker that makes an `issue`-mode finding findable across re-runs
 * (#2292, #2297): written as the issue description's first line, matched on
 * the next run by a `startswith` check (GitHub/Forgejo) or a server-side
 * `search` plus the same check (GitLab). The same recipe {@link commentMarker}
 * names for the `comment` mode's note, kept as its own function (rather than
 * reused) because the two modes write to different resources and a caller may
 * run both against the same `env`.
 *
 * Keyed on the owning Op *and* the env, not the env alone (#2319). An
 * env-keyed marker was not unique, and once #2311 made this mode edit in place
 * that stopped being merely untidy: `postOrUpdateGithubIssue` PATCHes both the
 * title and the body of whatever it matches, so two Ops resolving to one
 * marker rewrite each other's report on every run and the issue alternates
 * between two unrelated findings. Two in-tree pairings hit it — a stock
 * `TerraformWatchOp` and a `live: true` one over the same root (both pass the
 * root as `env`), and a `ReconcileOp` for a chant environment whose name
 * matches some terraform root — and both are ordinary configurations, not
 * abuse. The Op name is the identifier closest to unique that this activity
 * can be handed: it names the Op's output directory and is what `chant run`
 * takes, so two Ops in a project do not share a raw name.
 * `lexicons/github`'s gate notice reached the same conclusion first, keying
 * its own sticky marker on `$CHANT_OP` alone.
 *
 * Both halves are slugified the same way {@link reconcileBranchName} slugifies
 * an env, which also keeps the value free of the quotes and backslashes it is
 * interpolated next to and of anything URL-encoding should have to escape out
 * of. `/` cannot survive that slugify, so it separates the two halves
 * unambiguously: the marker parses back to exactly one `op` slug and one `env`
 * slug.
 *
 * What that leaves, and what is accepted rather than solved (#2319 pre-merge
 * review): the slug is not injective. {@link markerSlug} collapses every run
 * of characters outside `[A-Za-z0-9._-]` to a single `-`, so `"app watch"` and
 * `"app:watch"` share a slug, and so do `"café"` and `"caf€"`. Two Ops named
 * that way in one project over one env would still collide. Nothing in this
 * repository constrains an Op name's character set today, so this cannot be
 * closed here — it wants a charset rule on `OpConfig.name` (which would also
 * settle the output directory and the branch name, both of which slugify the
 * same way and have the same aliasing). Until then the residual is: distinct
 * raw names, distinct markers, unless the names differ only in characters the
 * slug does not keep.
 */
export function issueMarker(op: string, env: string): string {
  return `<!-- chant-reconcile-issue:${markerSlug(op)}/${markerSlug(env)} -->`;
}

/** The slugify both markers share: everything outside `[A-Za-z0-9._-]` collapses to `-`. */
function markerSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * What any mode says about a supplied `marker` it cannot use safely (#2319
 * pre-merge review).
 *
 * The marker is interpolated raw into the `--jq` filter that finds this Op's
 * own comment or issue, inside a jq string literal: `startswith("<marker>")`.
 * Only the whole filter is shell-quoted, so a `"` or a `\` in the marker
 * closes or escapes past that literal — at best a jq syntax error, at worst a
 * filter that matches something other than what the caller wrote. A control
 * character does the same to the jq program's own line structure.
 *
 * Markers this activity builds itself cannot contain any of the three:
 * {@link markerSlug} keeps them to `[A-Za-z0-9._-]` plus the fixed `<!-- … -->`
 * frame. This checks the one that comes in from outside, and refuses rather
 * than escaping, because a marker is an identity a caller has to be able to
 * predict — silently rewriting it would move the issue this run owns.
 */
export function unsafeMarkerMessage(marker: string): string {
  return (
    `reconcilePr was given the marker ${JSON.stringify(marker)}, which it cannot use. The marker goes into ` +
    'the `--jq` filter that finds this Op\'s own comment or issue, as `startswith("<marker>")`, so a double ' +
    "quote, a backslash or a control character in it either breaks that filter or changes what it matches. " +
    "Markers this activity builds itself are slugified to letters, digits, dot, underscore and hyphen and " +
    "cannot contain any of the three. Keep a supplied marker to printable text without `\"` or `\\`, or drop " +
    "`marker` and pass `op` instead."
  );
}

/**
 * The caller's `marker` as this activity will actually use it, or `undefined`
 * when the caller supplied nothing usable (#2319 pre-merge review).
 *
 * Blank is not a marker. `""` and `"   "` used to satisfy the `issue`-mode
 * identity check — `args.marker === undefined` is false for both, and `??`
 * only falls through on nullish — and then built `startswith("")`, which is
 * true of every issue body in the repository. So the step took whichever OPEN
 * non-pull-request issue the forge listed first, very possibly a human's, and
 * PATCHed its title and body. That is the precise failure #2319 exists to
 * close, reachable through the escape hatch #2319 added, which is why the
 * check lives on the field rather than in one mode's branch.
 *
 * Trimming rather than only rejecting: a marker with a trailing space is
 * written and matched consistently either way, and normalizing it here means
 * one definition of "blank" for both modes.
 */
export function suppliedMarker(marker: string | undefined): string | undefined {
  const trimmed = marker?.trim();
  if (!trimmed) return undefined;
  if (/["\\]|[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(unsafeMarkerMessage(trimmed));
  return trimmed;
}

/**
 * What an `issue`-mode step says when it was given no identity to key its
 * marker on (#2319).
 *
 * A refusal rather than a fall back to the pre-#2319 env-only marker, because
 * the fallback is the bug: it is silent, it looks like it worked, and what it
 * costs is the *other* Op's report, which nobody is watching the log of. The
 * step that has to change is the one being refused, and the message names the
 * two ways to change it.
 */
export function noIssueIdentityMessage(env: string): string {
  return (
    'reconcilePr mode "issue" edits the one OPEN issue carrying this Op\'s hidden marker in place, so the ' +
    `marker has to name the Op. This step supplies env "${env}" and no identity, and an env alone is not ` +
    "unique: two Ops over one env — a stock terraform drift watch and a live one over the same root, or a " +
    "terraform root and a chant environment that happen to share a name — resolve to the same marker, and " +
    "each run then rewrites the other's issue title and body. Pass `op` with the Op's own name (every " +
    "composite in tree does), or pass an explicit `marker` you keep unique yourself."
  );
}

/** What a `comment`-mode step says when the run it is in has no pull request and no merge request. */
export function noPullRequestContextMessage(): string {
  return (
    'reconcilePr mode "comment" posts the finding on the pull request or merge request that triggered the ' +
    "run, and this run has none. On GitHub Actions it needs GITHUB_REPOSITORY plus a pull request number, " +
    "read from the event payload at GITHUB_EVENT_PATH (`.number` / `.pull_request.number`) or from " +
    "GITHUB_REF (`refs/pull/<n>/merge`), which a pull_request event sets and nothing else does. On GitLab " +
    "CI it needs CI_MERGE_REQUEST_IID plus the project (CI_MERGE_REQUEST_PROJECT_ID or CI_PROJECT_ID) and " +
    "the API base (CI_API_V4_URL, or CI_SERVER_URL to derive it), which a merge_request_event pipeline " +
    "sets and nothing else does. Trigger this Op from a pull_request or merge_request pipeline, or give " +
    'it findingMode "issue" or "report".'
  );
}

/**
 * Read the pull request number out of a parsed webhook event payload. Pure.
 * A `pull_request` event carries it top-level as `number` and again under
 * `pull_request.number`; both are accepted, neither is invented.
 */
function prNumberFromPayload(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as { number?: unknown; pull_request?: { number?: unknown } };
  if (typeof p.number === "number") return p.number;
  if (typeof p.pull_request?.number === "number") return p.pull_request.number;
  return undefined;
}

/**
 * Derive the triggering pull request from CI environment variables plus the
 * already-parsed event payload. Pure — exported for testing; the IO (reading
 * `GITHUB_EVENT_PATH`) is {@link resolvePullRequestContext}'s.
 *
 * Returns undefined rather than throwing, so the caller owns the message.
 */
export function pullRequestContextFrom(
  env: Record<string, string | undefined>,
  eventPayload?: unknown,
): PullRequestContext | undefined {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) return undefined;
  const fromRef = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1];
  const number = prNumberFromPayload(eventPayload) ?? (fromRef ? Number(fromRef) : undefined);
  if (number === undefined || !Number.isInteger(number) || number <= 0) return undefined;
  return { repo, number };
}

/**
 * Resolve the triggering pull request, reading and parsing the event payload
 * `GITHUB_EVENT_PATH` names. Throws {@link noPullRequestContextMessage} when
 * the run has no pull request, which is the whole point: a `comment` mode that
 * quietly fell back to an issue would post the finding somewhere nobody asked
 * for it.
 */
export async function resolvePullRequestContext(
  env: Record<string, string | undefined> = process.env,
): Promise<PullRequestContext> {
  let payload: unknown;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      payload = JSON.parse(await readFile(eventPath, "utf8"));
    } catch {
      // An unreadable or malformed payload is not fatal on its own: GITHUB_REF
      // may still name the pull request. If it does not, the error below says so.
      payload = undefined;
    }
  }
  const ctx = pullRequestContextFrom(env, payload);
  if (!ctx) throw new Error(noPullRequestContextMessage());
  return ctx;
}

/**
 * The REST base a GitHub-shaped `gh api` call should target, read the same
 * way the runner itself reads it (chant #2291). `GITHUB_API_URL` is a default
 * environment variable every GitHub Actions *and* Forgejo Actions job carries
 * — `https://api.github.com` on github.com, `<host>/api/v3` on GitHub
 * Enterprise Server, and `<host>/api/v1` on Forgejo, which already advertises
 * it correctly (confirmed on a real Forgejo 12.0.4+gitea-1.22.0 instance
 * during INTENTIUS/choudoufu#1027: `$GITHUB_API_URL` read
 * `http://forgejo:3000/api/v1` inside the job).
 *
 * Building the full URL from this rather than handing `gh api` a bare
 * relative path (`repos/…`) is the fix itself: `gh` resolves a relative path
 * by guessing a host-specific prefix of its own — `api.<host>` for
 * `github.com`, `<host>/api/v3` for anything else — and that guess is `/api/v3`
 * for a Forgejo host too, which Forgejo answers 404 for both GET and POST.
 * Handed a full URL, `gh api` uses it verbatim and skips the guess entirely,
 * which is what let the same `gh` binary reach Forgejo's `/api/v1` in the
 * same session, over plain HTTP and over TLS. No Forgejo-specific branch is
 * needed: every host in play (github.com, GHES, Forgejo) sets
 * `GITHUB_API_URL` to the base its own `/repos/...` paths actually live
 * under, so building the URL from it is correct everywhere `gh` already ran,
 * not only on Forgejo.
 */
export function githubApiBaseFrom(env: Record<string, string | undefined>): string {
  return env.GITHUB_API_URL?.trim().replace(/\/+$/, "") || "https://api.github.com";
}

/** The credential a GitHub- or Forgejo-shaped comment call is made with. */
export interface CommentToken {
  value: string;
  /** The variable it came from, so a refusal or a log line can name it. */
  source: string;
}

/**
 * Resolve the token `postOrUpdateComment` sends with, most specific first
 * (chant #2291). `gh` itself already resolves `GH_TOKEN`/`GITHUB_TOKEN`
 * ambiently from the process environment, and the generated workflow sets
 * both to `${{ github.token }}` for every non-`report` finding mode — on
 * Forgejo the same way as on GitHub, and the real-instance read confirmed
 * `github.token` is populated there and good for a 200 read and a 201 write,
 * authored as `forgejo-actions`. So the common case needs nothing set beyond
 * what the generator already emits.
 *
 * `CHANT_FORGEJO_TOKEN` is checked first for the case that ambient token
 * cannot cover: a run posting to a Forgejo instance other than the one the
 * job executes on, where `github.token`'s scope stops at its own instance.
 * Resolving explicitly (rather than leaving it entirely to `gh`) also buys a
 * named failure before the shell-out, in place of `gh`'s own opaque 401.
 */
export function commentTokenFrom(env: Record<string, string | undefined>): CommentToken | undefined {
  for (const source of ["CHANT_FORGEJO_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = env[source]?.trim();
    if (value) return { value, source };
  }
  return undefined;
}

/**
 * The environment a `gh api` call carries {@link commentTokenFrom}'s resolved
 * credential in (chant #2333).
 *
 * `GH_TOKEN` alone is not enough, and that is `gh`'s documented behavior
 * rather than a bug in it. `gh` picks the token per *request host*:
 * `GH_TOKEN`/`GITHUB_TOKEN` are scoped to github.com and `ghe.com`
 * subdomains, and every other host — a self-hosted Forgejo, a self-hosted
 * GitHub Enterprise Server — reads `GH_ENTERPRISE_TOKEN`/
 * `GITHUB_ENTERPRISE_TOKEN` instead (`gh help environment`). #2291 fixed the
 * *URL* half of reaching a non-github.com host and left this half untouched,
 * so 0.62.0 and 0.63.0 both shipped a `comment` mode that posts to Forgejo
 * with no `Authorization` header at all.
 *
 * Confirmed against a real Forgejo 12.0.4+gitea-1.22.0 instance under #2333,
 * from a shell whose `GH_CONFIG_DIR` held no `gh auth login` — the condition
 * a fresh Actions checkout starts from, and the one #2304's verification did
 * not reproduce. Driving this function's own POST with `GH_DEBUG=api`:
 * `GH_TOKEN` alone sent no `Authorization` header and got HTTP 401
 * `{"message":"token is required"}`, `GH_TOKEN` with `GITHUB_TOKEN` beside it
 * got the same 401, and `GH_TOKEN` with `GH_HOST` beside it got the same 401
 * again. `GH_ENTERPRISE_TOKEN` sent `Authorization: token …` and got HTTP 201.
 *
 * So the fix is one variable, set to the same value: whichever class `gh`
 * decides the host falls into, the credential it finds there is the one
 * {@link commentTokenFrom} resolved. That is why this does not branch on the
 * forge, and why it needs no host detection of chant's own — the thing that
 * broke was `gh`'s host classification, and setting both classes to one value
 * is what stops chant depending on it.
 *
 * ## Why `GH_HOST` is deliberately not set
 *
 * #2333 proposed `GH_ENTERPRISE_TOKEN` *plus* a `GH_HOST` derived from
 * `GITHUB_API_URL`, on the reading that the pair was needed. It is not: the
 * live instance took `GH_ENTERPRISE_TOKEN` on its own, with no `GH_HOST`
 * anywhere in the environment, because {@link githubApiBaseFrom} already
 * hands `gh api` a full URL and `gh` reads the host off that URL rather than
 * off its default. `GH_HOST` sets the *default* host for calls that name no
 * host — which is what `gh issue create`'s ambient fallback below relies on —
 * so setting it would buy nothing here and put a variable into the
 * environment of calls that do not want one.
 *
 * ## Why github.com is unchanged
 *
 * Both variables carry the same value, so the question is only which one
 * `gh` reads, and github.com reads `GH_TOKEN`. Probed against the real
 * api.github.com the same way: a valid `GH_TOKEN` with a deliberately
 * garbage `GH_ENTERPRISE_TOKEN` beside it succeeded, and a garbage `GH_TOKEN`
 * with a valid `GH_ENTERPRISE_TOKEN` beside it failed `Bad credentials`.
 * `GH_TOKEN` wins on github.com whatever the enterprise variable holds, so
 * the header a github.com call sends is byte-identical to the one it sent
 * before this change.
 *
 * A *self-hosted* GHES host is in the same class as Forgejo and was equally
 * broken — same `gh` code path, same missing header — so it is fixed by the
 * same variable rather than merely preserved. That was inferred from `gh`'s
 * documented scoping in #2332 and is not exercised here: no GHES instance was
 * available to test against.
 */
export function ghCredentialEnv(base: NodeJS.ProcessEnv, token: CommentToken): NodeJS.ProcessEnv {
  return { ...base, GH_TOKEN: token.value, GH_ENTERPRISE_TOKEN: token.value };
}

/** What a `comment`-mode step says on a pull request it has no credential for. */
export function noCommentTokenMessage(repo: string, number: number): string {
  return (
    `reconcilePr mode "comment" has pull request ${repo}#${number} to post its finding on and no token to ` +
    "post it with. GH_TOKEN or GITHUB_TOKEN, set from github.token, already covers this on a GitHub Actions " +
    "or Forgejo Actions run — set CHANT_FORGEJO_TOKEN to post against a different instance than the one the " +
    "job runs on. CHANT_FORGEJO_TOKEN is read first where the two must differ."
  );
}

/** What an `issue`-mode step says on a repository it has no credential for (#2320). */
export function noIssueTokenMessage(repo: string): string {
  return (
    `reconcilePr mode "issue" has repository ${repo} to open or edit its finding in and no token to do it ` +
    "with. GH_TOKEN or GITHUB_TOKEN, set from github.token, already covers this on a GitHub Actions or " +
    "Forgejo Actions run — set CHANT_FORGEJO_TOKEN to post against a different instance than the one the " +
    "job runs on. CHANT_FORGEJO_TOKEN is read first where the two must differ."
  );
}

/**
 * Post `body` as one comment on `ctx`'s pull request, or edit the comment this
 * Op already owns there. The sticky-comment recipe the github lexicon's
 * `PrPlanReport` uses, run from the activity instead of from generated YAML:
 * find the comment whose body starts with `marker`, PATCH it when there is
 * one, POST otherwise. `gh` ships on GitHub's hosted runners and is already
 * this activity's dependency for the issue and pull-request modes, so the
 * mode needs nothing new on the runner — Forgejo's `act_runner` ships `gh`
 * too, and Forgejo's `/api/v1` takes the same calls (chant #2291).
 *
 * Every call targets a full URL built from {@link githubApiBaseFrom} rather
 * than the bare relative path this used before #2291 — see that function for
 * why a bare path broke Forgejo specifically. The token is resolved
 * explicitly via {@link commentTokenFrom} and forwarded through {@link
 * ghCredentialEnv}, which is a strict superset of `gh`'s own ambient
 * resolution: same value in the common case, a named refusal instead of
 * `gh`'s opaque 401 when neither is set, and — since chant #2333 — the same
 * value under `GH_ENTERPRISE_TOKEN` too, without which the full URL #2291
 * built reached Forgejo carrying no credential.
 */
async function postOrUpdateComment(
  ctx: PullRequestContext,
  marker: string,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const token = commentTokenFrom(process.env);
  if (!token) throw new Error(noCommentTokenMessage(ctx.repo, ctx.number));
  const env = ghCredentialEnv(process.env, token);

  const base = githubApiBaseFrom(process.env);
  const listUrl = `${base}/repos/${ctx.repo}/issues/${ctx.number}/comments`;
  const jq = `map(select(.body | startswith("${marker}"))) | .[0].id // empty`;
  const { stdout: found } = await execAsync(
    `gh api ${shellQuote(listUrl)} --paginate --jq ${shellQuote(jq)}`,
    { signal, env },
  );
  // `--paginate` prints one `--jq` result per page, so take the first line
  // that is an id and ignore the empty ones the other pages produce.
  const existing = found.split("\n").map((l) => l.trim()).find((l) => /^\d+$/.test(l));
  const field = `body=${marker}\n\n${body}`;

  if (existing) {
    const { stdout } = await execAsync(
      `gh api --method PATCH ${shellQuote(`${base}/repos/${ctx.repo}/issues/comments/${existing}`)} ` +
        `-f ${shellQuote(field)} --jq .html_url`,
      { signal, env },
    );
    return stdout.trim();
  }
  const { stdout } = await execAsync(
    `gh api --method POST ${shellQuote(listUrl)} -f ${shellQuote(field)} --jq .html_url`,
    { signal, env },
  );
  return stdout.trim();
}

// ── The GitHub/GHES/Forgejo sticky issue (#2297) ────────────────────────────

/**
 * Minimal `gh` invocation shape {@link postOrUpdateGithubIssue} threads its
 * calls through. `reconcilePr` wraps `execAsync` (carrying its own `signal`)
 * to this shape; `lexiconUpgrade` passes its injectable `GhRunner` straight
 * through, since the two already share this signature. One function, not two
 * copies, because the recipe below — search, then PATCH or POST — is
 * identical for both callers; only the issue's title/body and the marker that
 * owns it differ.
 *
 * The `opts` argument exists so `postOrUpdateGithubIssue` can hand `gh` the
 * token it resolved (chant #2320) rather than leaving `gh` to find one
 * ambiently. A caller that adds nothing of its own can ignore it and pass it
 * straight to `exec`; `reconcilePr` merges it with the `signal` it already
 * carries. It is deliberately not a whole `ExecOptions`: an implementation
 * that had to honour `cwd` or `shell` too would be a second exec wrapper, and
 * the point of this type is that there is only one.
 */
export type GhExec = (
  cmd: string,
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Open `title`/`body` as one GitHub-shaped issue in `repo`, or edit the issue
 * this caller already owns there (#2297) — `postOrUpdateComment`'s issue
 * counterpart, and the GitHub/GHES/Forgejo sibling of GitLab's
 * `postOrUpdateIssue` (#2292): find by marker, PATCH when found, POST when
 * not, so a nightly finding carries one issue holding the current state
 * instead of stacking a new one every run. Shared by `reconcilePr`'s own
 * `issue` mode and `lexiconUpgrade`'s per-lexicon upgrade-status issue.
 *
 * Every call targets a full URL built from {@link githubApiBaseFrom}, the
 * same as `postOrUpdateComment` (#2291) — so this reaches GitHub Enterprise
 * Server the same way it reaches github.com.
 *
 * The credential is resolved and forwarded the same way too (chant #2320),
 * through {@link commentTokenFrom} and out through {@link ghCredentialEnv} on
 * every call. It did not used to be: `reconcilePr` handed this `(cmd) => execAsync(cmd, {
 * signal })` with no `env` at all, so `CHANT_FORGEJO_TOKEN` never reached
 * `gh` and the one case that variable exists for — posting to a Forgejo
 * instance other than the one the job runs on, where `github.token`'s scope
 * stops at its own instance — failed with a 401 or a 404 that named nothing.
 * With no token at all the operator got `gh`'s own error rather than chant's.
 * The refusal here is {@link noIssueTokenMessage}, not the `comment` mode's
 * {@link noCommentTokenMessage}: same resolution order, same advice, but that
 * message names a pull request this mode does not have, and this function is
 * shared with `lexiconUpgrade`, which is not `reconcilePr` at all. The same
 * split GitLab already makes between `noGitlabNoteTokenMessage` and
 * `noGitlabIssueTokenMessage`.
 *
 * ## Why plain pagination instead of GitHub's Search API
 *
 * GitHub offers real server-side full-text search — `gh issue list --search`
 * and `GET /search/issues?q=...` both use it, and chant #2297 (the issue that
 * asked for this) names both as candidates. Neither is used here, for three
 * reasons found while building this:
 *
 * 1. **Consistency.** GitHub's search index is documented as eventually
 *    consistent: an issue this function just wrote is not guaranteed to be
 *    findable by search immediately afterward. That is exactly the
 *    read-after-write the sticky recipe depends on — a false "not found"
 *    means a duplicate issue, which is the bug this activity exists to fix.
 * 2. **The marker itself.** The hidden marker is deliberately punctuation-
 *    heavy (`<!-- chant-reconcile-issue:nightly/app -->`) so it renders
 *    invisibly. GitHub's search tokenizer is not documented to preserve that
 *    shape through `in:body` matching, and a wrong query would either miss the
 *    marker (a duplicate, the same failure mode as above) or over-match and
 *    still need the same client-side `startswith` check this function
 *    already does — at which point the search bought nothing but risk.
 * 3. **Forgejo.** `gh issue list --search` and `/search/issues` are both
 *    absent from Forgejo's API — checked against a live Forgejo instance's
 *    own OpenAPI spec while building this: no `/search/issues`, no
 *    `/repos/issues/search` path anywhere in it (Forgejo's own issues-list
 *    endpoint does carry a real `q` search parameter, but that is a
 *    different endpoint shape than GitHub's, which would mean forking this
 *    function by forge — exactly what the `comment` path (#2291)
 *    deliberately does not do). Chant #2315 confirmed this against a live
 *    call rather than only the spec: plain paginated `GET .../issues?state=
 *    open` on a real Forgejo 12.0.4+gitea-1.22.0 instance interleaves pull
 *    requests with issues exactly as GitHub's endpoint does, and the
 *    `.pull_request == null` filter below excludes them correctly. The write
 *    calls this function makes did not clear the same instance until chant
 *    #2333 gave them a credential `gh` would apply to that host — see the
 *    module doc's `issue` bullet and {@link ghCredentialEnv}.
 *
 * So this reuses the recipe `postOrUpdateComment` already proved for PR
 * comments: list, `--paginate`, filter with `--jq` by an exact `startswith`
 * prefix match, which is correct no matter how many pages it takes. The cost
 * is real — a repository with many thousands of issues pays for every page
 * on every run — and is the accepted trade-off here; narrowing further with
 * GitHub's `creator` filter was considered and left alone, because the
 * identity a `GH_TOKEN` posts as cannot be assumed reliably across a
 * generated workflow and a hand-run one, and a wrong `creator` is a false
 * negative — a duplicate — not just a slower search.
 *
 * ## The close decision (#2297)
 *
 * This never closes the issue, in either branch, matching both GitLab paths
 * (#2256, #2292) — neither of which closes anything either. The search is
 * scoped to `state=open` rather than `state=all`, which makes that decision
 * concrete rather than implicit: a human closing the issue by hand, once the
 * drift it named is actually fixed, is what tells the *next* run to open a
 * fresh issue for a fresh finding instead of silently rewriting the closed
 * one back open-in-substance-but-not-in-state. The alternative — searching
 * `state=all` and reopening on write — would need this activity to guess
 * when a finding is "resolved" with no reliable signal for that (an empty
 * change set this run says nothing about whether the *last* finding was
 * fixed or just not evaluated), and would turn a deliberate human "done" into
 * something the bot silently reverses on its next run.
 *
 * `.pull_request == null` is filtered out of the search because GitHub's
 * issues-list endpoint also returns pull requests, which this function must
 * never mistake for an issue it owns.
 */
export async function postOrUpdateGithubIssue(
  repo: string,
  marker: string,
  title: string,
  body: string,
  exec: GhExec,
): Promise<string> {
  const token = commentTokenFrom(process.env);
  if (!token) throw new Error(noIssueTokenMessage(repo));
  const env = ghCredentialEnv(process.env, token);

  const base = githubApiBaseFrom(process.env);
  const listUrl = `${base}/repos/${repo}/issues?state=open`;
  const jq =
    'map(select((.pull_request == null) and ((.body // "") | startswith(' +
    `"${marker}"))))` +
    " | .[0].number // empty";
  const { stdout: found } = await exec(
    `gh api ${shellQuote(listUrl)} --paginate --jq ${shellQuote(jq)}`,
    { env },
  );
  // `--paginate` prints one `--jq` result per page, same as postOrUpdateComment.
  const existing = found.split("\n").map((l) => l.trim()).find((l) => /^\d+$/.test(l));
  const titleField = shellQuote(`title=${title}`);
  const bodyField = shellQuote(`body=${marker}\n\n${body}`);

  if (existing) {
    const { stdout } = await exec(
      `gh api --method PATCH ${shellQuote(`${base}/repos/${repo}/issues/${existing}`)} ` +
        `-f ${titleField} -f ${bodyField} --jq .html_url`,
      { env },
    );
    return stdout.trim();
  }
  const { stdout } = await exec(
    `gh api --method POST ${shellQuote(`${base}/repos/${repo}/issues`)} -f ${titleField} -f ${bodyField} --jq .html_url`,
    { env },
  );
  return stdout.trim();
}

// ── The GitLab merge-request note (#2256) ───────────────────────────────────

/**
 * The merge request a `comment`-mode run posts its note onto (#2256), as a
 * GitLab CI job knows it. The GitLab counterpart of {@link
 * PullRequestContext}.
 */
export interface MergeRequestContext {
  /** REST v4 base, from `CI_API_V4_URL` or derived from `CI_SERVER_URL`. */
  api: string;
  /** The project holding the merge request — its numeric id, or a `group/project` path. */
  project: string;
  /** The merge request's `iid` (its per-project number, which is what the API path takes). */
  iid: number;
  /** `group/project`, for the human-readable `group/project!iid` on the result. */
  path?: string;
  /** The project's web URL, used to build the note's own URL. */
  webUrl?: string;
}

/**
 * Derive the triggering merge request from a GitLab job's CI variables. Pure
 * — exported for testing, and the whole forge detection: nothing but a
 * `merge_request_event` pipeline sets `CI_MERGE_REQUEST_IID`, so a run that
 * has it is on GitLab and has a merge request, and a run that does not is
 * neither.
 *
 * The project is the merge request's own (`CI_MERGE_REQUEST_PROJECT_ID`) in
 * preference to the pipeline's (`CI_PROJECT_ID`): a merge request opened from
 * a fork runs its pipeline in the fork, and the note belongs on the target
 * project's merge request rather than on an iid that means something else in
 * the fork.
 *
 * Returns undefined rather than throwing, so the caller owns the message.
 */
export function mergeRequestContextFrom(
  env: Record<string, string | undefined>,
): MergeRequestContext | undefined {
  const rawIid = env.CI_MERGE_REQUEST_IID?.trim();
  if (!rawIid) return undefined;
  const iid = Number(rawIid);
  if (!Number.isInteger(iid) || iid <= 0) return undefined;

  const server = env.CI_SERVER_URL?.trim().replace(/\/+$/, "");
  const api = env.CI_API_V4_URL?.trim().replace(/\/+$/, "") || (server ? `${server}/api/v4` : "");
  if (!api) return undefined;

  const project =
    env.CI_MERGE_REQUEST_PROJECT_ID?.trim() ||
    env.CI_PROJECT_ID?.trim() ||
    env.CI_MERGE_REQUEST_PROJECT_PATH?.trim() ||
    env.CI_PROJECT_PATH?.trim() ||
    "";
  if (!project) return undefined;

  const path = env.CI_MERGE_REQUEST_PROJECT_PATH?.trim() || env.CI_PROJECT_PATH?.trim();
  const webUrl = env.CI_MERGE_REQUEST_PROJECT_URL?.trim() || env.CI_PROJECT_URL?.trim();
  return {
    api,
    project,
    iid,
    ...(path ? { path } : {}),
    ...(webUrl ? { webUrl } : {}),
  };
}

/**
 * The GitLab project an `issue`-mode run opens or updates its issue on (#2292),
 * as any GitLab CI job knows it — the counterpart of {@link
 * mergeRequestContextFrom} for a mode that needs no merge request.
 */
export interface GitlabProjectContext {
  /** REST v4 base, from `CI_API_V4_URL` or derived from `CI_SERVER_URL`. */
  api: string;
  /** The project holding the issue — its numeric id, or a `group/project` path. */
  project: string;
  /** `group/project`, for a human-readable result. */
  path?: string;
  /** The project's web URL, used to build the issue's own URL. */
  webUrl?: string;
}

/**
 * Derive the GitLab project an `issue`-mode run is in, from the job's own CI
 * variables. Pure — exported for testing, and the whole forge detection:
 * `CI_PROJECT_ID` is set on every GitLab CI job, merge request or not, and
 * nothing outside GitLab CI sets it — a GitHub Actions run never reaches this
 * branch. Unlike {@link mergeRequestContextFrom}, no `CI_MERGE_REQUEST_IID`
 * is required, since `issue` mode's whole point is a cron trigger that has
 * none.
 *
 * Returns undefined rather than throwing, so the caller owns the fallback:
 * a run with no GitLab signal falls through to `gh issue create`.
 */
export function gitlabProjectContextFrom(
  env: Record<string, string | undefined>,
): GitlabProjectContext | undefined {
  const project = env.CI_PROJECT_ID?.trim();
  if (!project) return undefined;

  const server = env.CI_SERVER_URL?.trim().replace(/\/+$/, "");
  const api = env.CI_API_V4_URL?.trim().replace(/\/+$/, "") || (server ? `${server}/api/v4` : "");
  if (!api) return undefined;

  const path = env.CI_PROJECT_PATH?.trim();
  const webUrl = env.CI_PROJECT_URL?.trim();
  return {
    api,
    project,
    ...(path ? { path } : {}),
    ...(webUrl ? { webUrl } : {}),
  };
}

/** The credential a merge-request note is written with, and the header GitLab reads it from. */
export interface GitlabNoteToken {
  /** `PRIVATE-TOKEN` for a personal/project/group access token, `JOB-TOKEN` for `CI_JOB_TOKEN`. */
  header: "PRIVATE-TOKEN" | "JOB-TOKEN";
  value: string;
  /** The variable it came from, so a refusal or a log line can name it. */
  source: string;
}

/**
 * Resolve the token a merge-request note is written with, most specific
 * first. Pure — exported for testing.
 *
 * Two headers, not one, because GitLab reads two different credentials from
 * two different headers: an access token goes in `PRIVATE-TOKEN`, and the
 * pipeline's own ephemeral `CI_JOB_TOKEN` goes in `JOB-TOKEN`. Sending one in
 * the other's header is a 401, not a fallback.
 *
 * The access token is preferred because it is the one that reliably works:
 * `CI_JOB_TOKEN` reaches only the endpoints GitLab's job-token allowlist
 * names, and the notes API is not among them on current GitLab, so a project
 * that has not widened that allowlist needs a token with `api` scope. It is
 * still accepted last rather than refused, so a project on an instance whose
 * allowlist does cover notes needs no long-lived credential at all.
 */
export function gitlabNoteTokenFrom(
  env: Record<string, string | undefined>,
): GitlabNoteToken | undefined {
  for (const source of ["CHANT_GITLAB_TOKEN", "GITLAB_TOKEN"]) {
    const value = env[source]?.trim();
    if (value) return { header: "PRIVATE-TOKEN", value, source };
  }
  const jobToken = env.CI_JOB_TOKEN?.trim();
  if (jobToken) return { header: "JOB-TOKEN", value: jobToken, source: "CI_JOB_TOKEN" };
  return undefined;
}

/** What a `comment`-mode step says on a merge request it has no credential for. */
export function noGitlabNoteTokenMessage(iid: number): string {
  return (
    `reconcilePr mode "comment" has merge request !${iid} to post its finding on and no token to post it ` +
    "with. Set a GITLAB_TOKEN CI/CD variable (masked, scope: api) on the project — a project access token " +
    "is enough — or, on an instance whose job-token allowlist covers the notes API, make CI_JOB_TOKEN " +
    "available to the job. CHANT_GITLAB_TOKEN is read first where the two must differ."
  );
}

/** What an `issue`-mode step says on a GitLab project it has no credential for (#2292). */
export function noGitlabIssueTokenMessage(project: string): string {
  return (
    `reconcilePr mode "issue" wants to open or update an issue on GitLab project ${project} and has no ` +
    "token to do it with. Set a GITLAB_TOKEN CI/CD variable (masked, scope: api) on the project — a " +
    "project access token is enough — or, on an instance whose job-token allowlist covers the issues API, " +
    "make CI_JOB_TOKEN available to the job. CHANT_GITLAB_TOKEN is read first where the two must differ."
  );
}

/** One page of merge-request notes, as much of each as this activity reads. */
interface GitlabNote {
  id: number;
  body?: string;
  /** GitLab's own generated notes ("changed the description"), never ours. */
  system?: boolean;
}

/** GitLab's REST paths take a URL-encoded project id or `group%2Fproject` path. */
function notesEndpoint(ctx: MergeRequestContext): string {
  return `${ctx.api}/projects/${encodeURIComponent(ctx.project)}/merge_requests/${ctx.iid}/notes`;
}

/** One GitLab REST call, with the failure spelled out rather than swallowed into a parse error. */
async function gitlabRequest(
  url: string,
  token: GitlabNoteToken,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    ...(signal ? { signal } : {}),
    headers: { [token.header]: token.value, "content-type": "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `GitLab API ${init.method ?? "GET"} ${url} answered ${res.status}${detail ? `: ${detail}` : ""} ` +
        `(token from ${token.source}, sent as ${token.header}).`,
    );
  }
  return res;
}

/**
 * Find the note this Op already owns on `ctx`'s merge request, by the same
 * hidden marker `postOrUpdateComment` looks a GitHub comment up by: the
 * marker is the body's first line and the match is a prefix.
 *
 * Pages the way GitLab pages, following the `x-next-page` response header
 * rather than guessing a page count — an active merge request runs past one
 * page of notes routinely, and a lookup that read page one alone would post
 * a second comment instead of editing the first.
 *
 * GitLab's own system notes are skipped: they are the activity feed
 * ("changed the description"), they are never ours, and they are the bulk of
 * what fills those pages.
 */
async function findOwnedNote(
  ctx: MergeRequestContext,
  token: GitlabNoteToken,
  marker: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const endpoint = notesEndpoint(ctx);
  // A merge request with more notes than this has something other than a
  // stale plan comment wrong with it; the bound is what stops a broken
  // `x-next-page` header from looping forever.
  const MAX_PAGES = 50;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gitlabRequest(`${endpoint}?per_page=100&page=${page}`, token, { method: "GET" }, signal);
    const notes = (await res.json()) as GitlabNote[];
    const owned = notes.find((note) => !note.system && (note.body ?? "").startsWith(marker));
    if (owned) return owned.id;
    const next = res.headers.get("x-next-page")?.trim();
    if (!next) return undefined;
  }
  return undefined;
}

/**
 * Post `body` as one note on `ctx`'s merge request, or edit the note this Op
 * already owns there — {@link postOrUpdateComment}'s GitLab half, and the
 * same recipe: find by marker, PUT when there is one, POST when there is not,
 * so a merge request pushed to five times carries one note holding the
 * current finding rather than five stale ones.
 *
 * Over `fetch` rather than a CLI. `gh` is on GitHub's hosted runners and is
 * already this activity's dependency for the issue and pull-request modes;
 * `glab` is on no GitLab runner by default, and a job whose finding step
 * depended on it would fail on the ordinary `node:22-slim` image the
 * generator emits.
 */
async function postOrUpdateNote(
  ctx: MergeRequestContext,
  token: GitlabNoteToken,
  marker: string,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = notesEndpoint(ctx);
  const existing = await findOwnedNote(ctx, token, marker, signal);
  const payload = JSON.stringify({ body: `${marker}\n\n${body}` });
  const res = existing
    ? await gitlabRequest(`${endpoint}/${existing}`, token, { method: "PUT", body: payload }, signal)
    : await gitlabRequest(endpoint, token, { method: "POST", body: payload }, signal);
  const note = (await res.json()) as GitlabNote;
  // GitLab's note payload carries no web URL, unlike GitHub's comment. The
  // anchor is how the UI itself addresses a note, so it is built rather than
  // read; with no project web URL to build it from, the API path is at least
  // a resolvable address for the thing that was written.
  return ctx.webUrl
    ? `${ctx.webUrl}/-/merge_requests/${ctx.iid}#note_${note.id}`
    : `${endpoint}/${note.id}`;
}

// ── The GitLab issue (#2292) ─────────────────────────────────────────────

/** One GitLab issue, as much of it as this activity reads. */
interface GitlabIssue {
  iid: number;
  description?: string;
}

/** GitLab's REST path for a project's issues. */
function issuesEndpoint(ctx: GitlabProjectContext): string {
  return `${ctx.api}/projects/${encodeURIComponent(ctx.project)}/issues`;
}

/**
 * Find the issue this Op already owns in `ctx`'s project, by the same hidden
 * marker `findOwnedNote` looks a merge-request note up by: the marker is the
 * description's first line and the match is a prefix.
 *
 * `search`/`in=description` narrows the request server-side to issues whose
 * description contains the marker, rather than paging every issue the
 * project has ever opened — a long-lived project accumulates issues the way
 * an active merge request accumulates notes, and the marker is exact text a
 * full-text search matches reliably. The `startswith` check after the fetch
 * still decides ownership, the same as the note lookup, since `search` finds
 * the marker anywhere in the field and only a match at the very start is
 * this Op's own issue rather than one that happens to quote it.
 *
 * Paged the way GitLab pages, following the `x-next-page` response header —
 * see {@link findOwnedNote} for why a bounded loop rather than a guessed page
 * count.
 */
async function findOwnedIssue(
  ctx: GitlabProjectContext,
  token: GitlabNoteToken,
  marker: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const endpoint = issuesEndpoint(ctx);
  const MAX_PAGES = 50;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gitlabRequest(
      `${endpoint}?per_page=100&page=${page}&search=${encodeURIComponent(marker)}&in=description`,
      token,
      { method: "GET" },
      signal,
    );
    const issues = (await res.json()) as GitlabIssue[];
    const owned = issues.find((issue) => (issue.description ?? "").startsWith(marker));
    if (owned) return owned.iid;
    const next = res.headers.get("x-next-page")?.trim();
    if (!next) return undefined;
  }
  return undefined;
}

/**
 * Open `title`/`body` as one issue in `ctx`'s project, or edit the issue this
 * Op already owns there — {@link postOrUpdateNote}'s issue counterpart, and
 * the same recipe: find by marker, PUT when there is one, POST when there is
 * not, so a cron Op that finds drift every night carries one issue holding
 * the current finding rather than a new one each run (#2292).
 *
 * `title` is written on every call, POST or PUT, so the issue's headline
 * stays current (e.g. an entry count) even though only the description's
 * marker is what makes the issue findable again.
 */
async function postOrUpdateIssue(
  ctx: GitlabProjectContext,
  token: GitlabNoteToken,
  marker: string,
  title: string,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = issuesEndpoint(ctx);
  const existing = await findOwnedIssue(ctx, token, marker, signal);
  const payload = JSON.stringify({ title, description: `${marker}\n\n${body}` });
  const res = existing
    ? await gitlabRequest(`${endpoint}/${existing}`, token, { method: "PUT", body: payload }, signal)
    : await gitlabRequest(endpoint, token, { method: "POST", body: payload }, signal);
  const issue = (await res.json()) as GitlabIssue;
  // GitLab does return a `web_url` on an issue payload, unlike a note, but
  // building it from the project's own web URL keeps this symmetric with
  // `postOrUpdateNote` and needs no extra field pinned in tests.
  return ctx.webUrl ? `${ctx.webUrl}/-/issues/${issue.iid}` : `${endpoint}/${issue.iid}`;
}

/**
 * Map a `chant lifecycle plan --json` ChangeSet to reconcile entries, dropping
 * `noop` entries (nothing to reconcile). Pure — exported for testing.
 */
export function entriesFromPlan(planJson: string): ReconcileEntry[] {
  const cs = JSON.parse(planJson) as {
    entries?: Array<{ name: string; action: string; type?: string }>;
  };
  return (cs.entries ?? [])
    .filter((e) => e.action !== "noop")
    .map((e) => ({ name: e.name, action: e.action, type: e.type }));
}

/** Derive reconcile entries from `chant lifecycle plan`. */
async function derivePlanEntries(
  env: string,
  owned: boolean,
  signal?: AbortSignal,
): Promise<ReconcileEntry[]> {
  const ownedFlag = owned ? " --owned" : "";
  const { stdout } = await execAsync(
    `chant lifecycle plan ${shellQuote(env)}${ownedFlag} --json`,
    { signal },
  );
  return entriesFromPlan(stdout);
}

/**
 * The marker the run will write and find its finding by, for the two modes
 * that have one, or `undefined` for the two that do not (#2319, and its
 * pre-merge review).
 *
 * Pure, and called before anything else in {@link reconcilePr} so that both
 * refusals it can raise — no identity, unusable marker — happen before the
 * activity shells out to anything.
 *
 * `issue` mode requires an identity: the Op's name, or a marker the caller
 * keeps unique. `comment` mode does not, because its marker is scoped to one
 * pull request rather than to the repository — see `ReconcilePrArgs.op` and
 * {@link issueMarker} for that asymmetry and what is tracked separately.
 * Both modes get the same {@link suppliedMarker} treatment of the field,
 * because a blank or unusable marker is a property of the field, not of the
 * mode reading it.
 */
function resolveMarker(mode: ReconcileMode, args: ReconcilePrArgs): string | undefined {
  if (mode === "issue") {
    const supplied = suppliedMarker(args.marker);
    const op = args.op?.trim();
    if (!supplied && !op) throw new Error(noIssueIdentityMessage(args.env));
    return supplied ?? issueMarker(op as string, args.env);
  }
  if (mode === "comment") {
    return suppliedMarker(args.marker) ?? commentMarker(args.env);
  }
  return undefined;
}

/**
 * Reconcile activity: turn regenerated TypeScript into a reviewable artifact.
 *
 * - `report` — return the summary only; no git, no network.
 * - `issue` — open or edit one issue describing the drift (no code change).
 *   On a GitHub Actions or Forgejo Actions job, or GitHub Enterprise Server,
 *   the OPEN issue already carrying this Op's hidden marker is edited in
 *   place and a new one opened only when there is none (#2297). On a GitLab
 *   CI job (any trigger — the point of this mode is a cron run that has no
 *   merge request), the same recipe against one GitLab issue (#2292). Neither
 *   branch ever closes the issue itself — see {@link postOrUpdateGithubIssue}
 *   for that decision and why. The marker names the Op as well as the env
 *   (#2319), so the step needs `op` or an explicit `marker` and fails by name
 *   with neither; an issue left over from the pre-#2319 env-only marker
 *   matches no Op's marker now and is left where it is, unedited, rather than
 *   adopted by whichever Op happens to run first.
 * - `comment` — post the body as one comment on the pull request that
 *   triggered the run, editing that same comment on every re-run rather than
 *   stacking a new one (#2231) — on GitHub and on Forgejo alike (#2291), the
 *   same GitHub-shaped `issues/{n}/comments` calls against each host's own
 *   API base — or, on a GitLab `merge_request_event` pipeline, as one note on
 *   that merge request by the same recipe (#2256). Needs a pull-request- or
 *   merge-request-triggered run; fails by name when there is none. No code
 *   change, and the `pull-requests: write` the generated workflow already
 *   grants on that trigger is the whole scope it spends on GitHub and
 *   Forgejo; on GitLab the scope is whatever the token it is given carries.
 * - `pull-request` — create a branch, regenerate source via
 *   `chant import --from <env>`, commit, push, and open a PR whose diff is the
 *   regenerated TypeScript. Never commits to the main branch.
 *
 * The body is {@link reconcileSummary}'s change-set table unless `args.body`
 * supplies one, in which case that text is used verbatim and no plan is
 * derived (chant #2087).
 *
 * Requires `chant` and (for non-report modes) `gh`/`git` in the environment.
 */
export async function reconcilePr(args: ReconcilePrArgs, signal?: AbortSignal): Promise<ReconcileResult> {
  const mode = args.mode ?? "pull-request";
  const owned = args.owned ?? false;

  // Resolved first, ahead of the `chant lifecycle plan` shell-out below
  // (#2319 pre-merge review). The identity refusal used to sit inside the
  // `issue` branch, which is after that derivation, so the arg shape that
  // actually reaches it — `{ env, op, mode, owned }`, `ReconcileOp`'s own,
  // with no `body` to short-circuit the plan — ran a shell command before
  // failing. `chant lifecycle plan` is read-only, so nothing was written; but
  // a plan that fails first hands the operator a plan error in place of the
  // named refusal this design rests on, which is the whole point of refusing
  // by name.
  const resolvedMarker = resolveMarker(mode, args);

  // A caller-supplied body means the finding is already written, so there is
  // nothing for `chant lifecycle plan` to tell us (#2087).
  const entries = args.entries ?? (args.body !== undefined ? [] : await derivePlanEntries(args.env, owned, signal));
  const summary = args.body ?? reconcileSummary(args.env, entries);
  const title = args.title ?? `Reconcile ${args.env}: ${entries.length} change(s) from live`;

  if (mode === "report") {
    return { mode, summary, entries };
  }

  if (mode === "issue") {
    // Non-null because `resolveMarker` returns a string for this mode or
    // throws, and it already ran at the top of the function.
    const marker = resolvedMarker!;

    // GitLab first, because its check is the narrow one: `CI_PROJECT_ID` is
    // set on every GitLab CI job, and nothing outside GitLab CI sets it
    // (#2292) — see `gitlabProjectContextFrom`.
    const project = gitlabProjectContextFrom(process.env);
    if (project) {
      const token = gitlabNoteTokenFrom(process.env);
      if (!token) throw new Error(noGitlabIssueTokenMessage(project.project));
      const issueUrl = await postOrUpdateIssue(project, token, marker, title, summary, signal);
      return { mode, summary, entries, issueUrl };
    }

    // GitHub, GHES, or Forgejo next: any job that ran under GitHub Actions or
    // Forgejo Actions carries GITHUB_REPOSITORY (#2297) — see
    // postOrUpdateGithubIssue's own doc comment for the search mechanism and
    // the close decision.
    const repo = process.env.GITHUB_REPOSITORY;
    if (repo) {
      const issueUrl = await postOrUpdateGithubIssue(repo, marker, title, summary, (cmd, opts) =>
        execAsync(cmd, { signal, ...opts }),
      );
      return { mode, summary, entries, issueUrl };
    }

    // Outside any known CI job (a local or manual invocation): fall back to
    // gh's own ambient repo detection, unchanged from before #2297. The
    // marker is still written here — it costs nothing, and means a later CI
    // run of the same Op finds and edits this issue instead of opening a
    // second one.
    //
    // This is the one path that does NOT go through `commentTokenFrom`
    // (#2320), deliberately. It is reached only when the run is outside every
    // CI job chant recognizes, which is where `gh auth login`'s stored
    // credential is the credential — and that is a login `commentTokenFrom`
    // cannot see, so refusing on a missing environment variable here would
    // reject the exact setup the branch exists to serve. `gh` still reads
    // GH_TOKEN and GITHUB_TOKEN off this process's own environment if they
    // are set; what it does not get is CHANT_FORGEJO_TOKEN promoted into
    // GH_TOKEN, because promoting it would silently outrank the login the
    // operator is standing in front of.
    const { stdout } = await execAsync(
      `gh issue create --title ${shellQuote(title)} --body ${shellQuote(`${marker}\n\n${summary}`)}`,
      { signal },
    );
    return { mode, summary, entries, issueUrl: stdout.trim() };
  }

  if (mode === "comment") {
    // The trigger context is read here rather than passed in: a step's args
    // are serialized at build time, and the pull request is not known until
    // the run. Missing context is fatal — see `noPullRequestContextMessage`.
    const marker = resolvedMarker!;

    // GitLab first, because its check is the narrow one: only a
    // `merge_request_event` pipeline sets `CI_MERGE_REQUEST_IID` (#2256), so
    // a run that has it is unambiguously the GitLab case, and a GitHub run
    // never reaches this branch.
    const mr = mergeRequestContextFrom(process.env);
    if (mr) {
      const token = gitlabNoteTokenFrom(process.env);
      if (!token) throw new Error(noGitlabNoteTokenMessage(mr.iid));
      const commentUrl = await postOrUpdateNote(mr, token, marker, summary, signal);
      return {
        mode,
        summary,
        entries,
        commentUrl,
        mergeRequest: `${mr.path ?? mr.project}!${mr.iid}`,
      };
    }

    const ctx = await resolvePullRequestContext();
    const commentUrl = await postOrUpdateComment(ctx, marker, summary, signal);
    return { mode, summary, entries, commentUrl, pullRequest: `${ctx.repo}#${ctx.number}` };
  }

  // pull-request
  const branch = args.branch ?? reconcileBranchName(args.env);
  const output = args.output ?? "./infra";
  const ownedFlag = owned ? " --owned" : "";

  // Never touch the main branch: cut a fresh branch first.
  await execAsync(`git checkout -b ${shellQuote(branch)}`, { signal });
  await execAsync(
    `chant import --from ${shellQuote(args.env)}${ownedFlag} --output ${shellQuote(output)} --force`,
    { signal },
  );
  await execAsync(`git add ${shellQuote(output)}`, { signal });
  await execAsync(`git commit -m ${shellQuote(title)}`, { signal });
  await execAsync(`git push -u origin ${shellQuote(branch)}`, { signal });
  const { stdout } = await execAsync(
    `gh pr create --title ${shellQuote(title)} --body ${shellQuote(summary)} --head ${shellQuote(branch)}`,
    { signal },
  );

  return { mode, branch, summary, entries, prUrl: stdout.trim() };
}
