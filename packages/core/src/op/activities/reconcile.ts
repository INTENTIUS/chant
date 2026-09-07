import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** What the reconcile activity does with the regenerated source. */
export type ReconcileMode = "pull-request" | "issue" | "report";

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
