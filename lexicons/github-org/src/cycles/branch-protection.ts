/**
 * Branch-protection & repository-ruleset cycle.
 *
 * This is the TEMPLATE cycle — the first concrete implementation of the `Cycle`
 * interface. Every subsequent cycle should follow this four-part structure:
 *
 *   1. Config shape   — what the caller declares in `GovernanceConfig`
 *   2. fetchLive      — read live state from the GitHub API (budget-aware)
 *   3. buildDesired   — map config → the diff's `OrgConfig` shape (pure)
 *   4. apply          — create / update / delete one `ChangeSetEntry` (budget-aware)
 *
 * See `src/cycles/README.md` for the copy-paste guide.
 *
 * GitHub API endpoints used:
 *   GET  /repos/{owner}/{repo}/branches/{branch}/protection
 *   PUT  /repos/{owner}/{repo}/branches/{branch}/protection
 *   DELETE /repos/{owner}/{repo}/branches/{branch}/protection
 *
 * Selective-by-omission: repos absent from config are never touched. Fields
 * absent from a `BranchProtectionConfig` entry are not reconciled.
 *
 * ## Scope
 *
 * `TScope` is `BranchProtectionScope` — a plain object with `org` (required)
 * and an optional `repos` map. When `repos` is present, `fetchLive` fetches
 * the live branch protection state for those repos. When absent, `fetchLive`
 * returns an empty state (all desired entries will appear as creates).
 *
 * Typical usage with the runner:
 *
 * ```ts
 * await runReconcile({
 *   config,
 *   client,
 *   cycles: [branchProtectionCycle],
 *   scope: {
 *     org: "my-org",
 *     repos: config.orgs["my-org"]!.repos,
 *   },
 *   mode: "apply",
 * });
 * ```
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, BranchProtectionConfig, RepoConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveBranchProtectionConfig } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/**
 * Scope for the branch-protection cycle.
 *
 * Pass `repos` to enable accurate live-fetch (fetches branch protection state
 * for each configured repo). Omit `repos` to get fast-path behaviour where all
 * desired rules are treated as creates (useful when you only need to push new
 * rules and do not care about detecting drift).
 */
export interface BranchProtectionScope {
  /** GitHub org login. */
  org: string;
  /**
   * Subset of repos to fetch live protection for. Typically set to
   * `orgConfig.repos` for the relevant org. Absent → no live fetch (all
   * desired rules will be emitted as creates).
   */
  repos?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we use)
// ---------------------------------------------------------------------------

/** Minimal shape of the branch protection GET response we care about. */
interface GhBranchProtection {
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
  } | null;
  required_status_checks?: {
    contexts?: string[];
    strict?: boolean;
  } | null;
  restrictions?: {
    users: unknown[];
    teams: unknown[];
  } | null;
  allow_force_pushes?: { enabled: boolean } | null;
  allow_deletions?: { enabled: boolean } | null;
  required_linear_history?: { enabled: boolean } | null;
}

// ---------------------------------------------------------------------------
// Live-state fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the branch protection rule for one branch pattern.
 * Returns null when the branch/protection does not exist (404).
 */
async function fetchBranchProtection(
  client: AppClient,
  owner: string,
  repo: string,
  branch: string,
  budget: RateBudget,
): Promise<LiveBranchProtectionConfig | null> {
  budget.use(1);
  let raw: GhBranchProtection;
  try {
    raw = await client.request<GhBranchProtection>(
      "GET",
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
    );
  } catch (err) {
    // 404 means no protection rule — not an error, just no live state.
    if (
      err instanceof Error &&
      (err.message.includes("404") || err.message.includes("Branch not protected"))
    ) {
      return null;
    }
    throw err;
  }

  const live: LiveBranchProtectionConfig = { pattern: branch };

  if (raw.required_pull_request_reviews !== undefined && raw.required_pull_request_reviews !== null) {
    live.requirePullRequestReviews = true;
    live.requiredApprovingReviewCount =
      raw.required_pull_request_reviews.required_approving_review_count ?? 0;
    live.dismissStaleReviews = raw.required_pull_request_reviews.dismiss_stale_reviews ?? false;
    live.requireCodeOwnerReviews =
      raw.required_pull_request_reviews.require_code_owner_reviews ?? false;
  } else {
    live.requirePullRequestReviews = false;
  }

  if (raw.required_status_checks !== undefined && raw.required_status_checks !== null) {
    live.requireStatusChecks = true;
    live.requiredStatusCheckContexts = raw.required_status_checks.contexts ?? [];
    live.requireBranchesToBeUpToDate = raw.required_status_checks.strict ?? false;
  } else {
    live.requireStatusChecks = false;
  }

  live.restrictPushes = raw.restrictions !== undefined && raw.restrictions !== null;
  live.allowForcePushes = raw.allow_force_pushes?.enabled ?? false;
  live.allowDeletions = raw.allow_deletions?.enabled ?? false;
  live.requireLinearHistory = raw.required_linear_history?.enabled ?? false;

  return live;
}

// ---------------------------------------------------------------------------
// BranchProtection API write helpers
// ---------------------------------------------------------------------------

/**
 * Build the GitHub API request body for PUT /branches/{branch}/protection.
 *
 * The GitHub branch-protection PUT endpoint requires ALL top-level keys to be
 * present (even if set to null/false). We build a complete body from a
 * `BranchProtectionConfig`, applying the field only when it is explicitly set.
 */
function buildProtectionBody(desired: BranchProtectionConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // Required pull request reviews
  if (desired.requirePullRequestReviews === true) {
    body.required_pull_request_reviews = {
      required_approving_review_count: desired.requiredApprovingReviewCount ?? 1,
      dismiss_stale_reviews: desired.dismissStaleReviews ?? false,
      require_code_owner_reviews: desired.requireCodeOwnerReviews ?? false,
    };
  } else {
    body.required_pull_request_reviews = null;
  }

  // Required status checks
  if (desired.requireStatusChecks === true) {
    body.required_status_checks = {
      strict: desired.requireBranchesToBeUpToDate ?? false,
      contexts: desired.requiredStatusCheckContexts ?? [],
    };
  } else {
    body.required_status_checks = null;
  }

  // Enforce admins (not exposed in our config; default to false)
  body.enforce_admins = false;

  // Restrictions (not exposed in our config; leave unrestricted)
  body.restrictions = desired.restrictPushes === true ? { users: [], teams: [] } : null;

  body.allow_force_pushes = desired.allowForcePushes ?? false;
  body.allow_deletions = desired.allowDeletions ?? false;
  body.required_linear_history = desired.requireLinearHistory ?? false;

  return body;
}

// ---------------------------------------------------------------------------
// BranchProtectionCycle — implements Cycle<BranchProtectionScope>
// ---------------------------------------------------------------------------

/**
 * Governance cycle for repository branch-protection rules.
 *
 * Reconciles the `branchProtection` array under each repo in the config's
 * `repos` map. Creates, updates, or deletes branch protection rules on GitHub
 * to match desired state.
 *
 * The cycle leaves repos, branches, and fields absent from the config entirely
 * untouched (selective-by-omission).
 */
export const branchProtectionCycle: Cycle<BranchProtectionScope> = {
  name: "branch-protection",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    scope: BranchProtectionScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const repos = scope.repos;
    if (!repos || Object.keys(repos).length === 0) {
      // No repos in scope: return empty state. The diff will emit creates for
      // all desired rules. Useful when pushing new rules without checking drift.
      return { repos: {} };
    }

    return fetchLiveForOrg(client, scope.org, repos, budget);
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _scope: BranchProtectionScope): OrgConfig {
    // Keep only the repos that have branchProtection config. Repo-level fields
    // (description, visibility, etc.) are handled by a separate cycle.
    if (!orgConfig.repos) return {};

    const repos: Record<string, RepoConfig> = {};
    for (const [repoName, repoConfig] of Object.entries(orgConfig.repos)) {
      if (repoConfig.branchProtection && repoConfig.branchProtection.length > 0) {
        repos[repoName] = { branchProtection: repoConfig.branchProtection };
      }
    }

    return { repos };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    scope: BranchProtectionScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "branch-protection") {
      // Safety: this cycle only handles branch-protection entries.
      return;
    }

    // key format: "<repo>/<branch-pattern>" (set by diff.ts)
    const slashIdx = entry.key.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(
        `branch-protection: malformed entry key "${entry.key}" — expected "<repo>/<branch>"`,
      );
    }
    const repoName = entry.key.slice(0, slashIdx);
    const branchPattern = entry.key.slice(slashIdx + 1);
    const owner = scope.org;

    const url = `/repos/${owner}/${repoName}/branches/${encodeURIComponent(branchPattern)}/protection`;

    if (entry.kind === "delete") {
      budget.use(1);
      await client.request("DELETE", url);
      return;
    }

    // create or update — both use PUT (idempotent on GitHub's side)
    const desired = entry.after as BranchProtectionConfig;
    const body = buildProtectionBody(desired);
    budget.use(1);
    await client.request("PUT", url, body);
  },
};

// ---------------------------------------------------------------------------
// fetchLiveForOrg — low-level helper (also used by the cycle internally)
// ---------------------------------------------------------------------------

/**
 * Fetch live branch-protection state for a specific set of repos.
 *
 * Each branch in each repo's `branchProtection` config costs one API call.
 * The budget is checked before each iteration; when exhausted the
 * partially-fetched state is returned so the runner can record deferred work.
 *
 * Repos with no `branchProtection` config are skipped (zero API calls).
 * A 404 for a specific branch means no protection rule is live for it —
 * returned as an absent entry (not an error).
 */
export async function fetchLiveForOrg(
  client: AppClient,
  orgLogin: string,
  repos: Record<string, RepoConfig>,
  budget: RateBudget,
): Promise<LiveOrgState> {
  const liveRepos: LiveOrgState["repos"] = {};

  for (const [repoName, repoConfig] of Object.entries(repos)) {
    if (!repoConfig.branchProtection || repoConfig.branchProtection.length === 0) continue;

    if (budget.exhausted) break;

    const liveBranchProtections: LiveBranchProtectionConfig[] = [];

    for (const bp of repoConfig.branchProtection) {
      if (budget.exhausted) break;
      const live = await fetchBranchProtection(client, orgLogin, repoName, bp.pattern, budget);
      if (live) liveBranchProtections.push(live);
    }

    liveRepos[repoName] = { branchProtection: liveBranchProtections };
  }

  return { repos: liveRepos };
}
