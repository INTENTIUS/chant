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
   * Hidden marker identifying this Op's comment on the pull request (comment
   * mode). The activity writes it as the comment's first line and finds the
   * comment again by it on the next run, so a re-run edits one comment instead
   * of stacking a new one. Default: {@link commentMarker} keyed on `env`, so
   * two Ops over two roots get two comments and each updates in place.
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
  /** Opened issue URL (issue mode). */
  issueUrl?: string;
  /** The posted or updated PR comment's URL (comment mode). */
  commentUrl?: string;
  /** The pull request the comment landed on, `owner/repo#number` (comment mode). */
  pullRequest?: string;
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
  return `<!-- chant-reconcile:${env.replace(/[^a-zA-Z0-9._-]+/g, "-")} -->`;
}

/** What a `comment`-mode step says when the run it is in has no pull request. */
export function noPullRequestContextMessage(): string {
  return (
    'reconcilePr mode "comment" posts the finding on the pull request that triggered the run, and this run ' +
    "has none. It needs GITHUB_REPOSITORY plus a pull request number, read from the event payload at " +
    "GITHUB_EVENT_PATH (`.number` / `.pull_request.number`) or from GITHUB_REF (`refs/pull/<n>/merge`). " +
    "GitHub Actions sets those on a pull_request event and on nothing else. Trigger this Op from a " +
    'pull_request workflow, or give it findingMode "issue" or "report".'
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
 * Post `body` as one comment on `ctx`'s pull request, or edit the comment this
 * Op already owns there. The sticky-comment recipe the github lexicon's
 * `PrPlanReport` uses, run from the activity instead of from generated YAML:
 * find the comment whose body starts with `marker`, PATCH it when there is
 * one, POST otherwise. `gh` ships on GitHub's hosted runners and is already
 * this activity's dependency for the issue and pull-request modes, so the
 * mode needs nothing new on the runner.
 */
async function postOrUpdateComment(
  ctx: PullRequestContext,
  marker: string,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const listPath = `repos/${ctx.repo}/issues/${ctx.number}/comments`;
  const jq = `map(select(.body | startswith("${marker}"))) | .[0].id // empty`;
  const { stdout: found } = await execAsync(
    `gh api ${shellQuote(listPath)} --paginate --jq ${shellQuote(jq)}`,
    { signal },
  );
  // `--paginate` prints one `--jq` result per page, so take the first line
  // that is an id and ignore the empty ones the other pages produce.
  const existing = found.split("\n").map((l) => l.trim()).find((l) => /^\d+$/.test(l));
  const field = `body=${marker}\n\n${body}`;

  if (existing) {
    const { stdout } = await execAsync(
      `gh api --method PATCH ${shellQuote(`repos/${ctx.repo}/issues/comments/${existing}`)} ` +
        `-f ${shellQuote(field)} --jq .html_url`,
      { signal },
    );
    return stdout.trim();
  }
  const { stdout } = await execAsync(
    `gh api --method POST ${shellQuote(listPath)} -f ${shellQuote(field)} --jq .html_url`,
    { signal },
  );
  return stdout.trim();
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
 * Reconcile activity: turn regenerated TypeScript into a reviewable artifact.
 *
 * - `report` — return the summary only; no git, no network.
 * - `issue` — open a GitHub issue describing the drift (no code change).
 * - `comment` — post the body as one comment on the pull request that
 *   triggered the run, editing that same comment on every re-run rather than
 *   stacking a new one (#2231). Needs a pull-request-triggered run; fails by
 *   name when there is none. No code change, and the `pull-requests: write`
 *   the generated workflow already grants on that trigger is the whole scope
 *   it spends.
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
  // A caller-supplied body means the finding is already written, so there is
  // nothing for `chant lifecycle plan` to tell us (#2087).
  const entries = args.entries ?? (args.body !== undefined ? [] : await derivePlanEntries(args.env, owned, signal));
  const summary = args.body ?? reconcileSummary(args.env, entries);
  const title = args.title ?? `Reconcile ${args.env}: ${entries.length} change(s) from live`;

  if (mode === "report") {
    return { mode, summary, entries };
  }

  if (mode === "issue") {
    const { stdout } = await execAsync(
      `gh issue create --title ${shellQuote(title)} --body ${shellQuote(summary)}`,
      { signal },
    );
    return { mode, summary, entries, issueUrl: stdout.trim() };
  }

  if (mode === "comment") {
    // The trigger context is read here rather than passed in: a step's args
    // are serialized at build time, and the pull request is not known until
    // the run. Missing context is fatal — see `noPullRequestContextMessage`.
    const ctx = await resolvePullRequestContext();
    const marker = args.marker ?? commentMarker(args.env);
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
