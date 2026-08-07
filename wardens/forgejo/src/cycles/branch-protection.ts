/**
 * Branch-protection cycle — Forgejo `branch_protections` per repo.
 *
 * Forgejo uses branch protections (keyed by `rule_name`), not GitHub-style
 * rulesets. This cycle owns *only* the branchProtection slice of each repo:
 *   - buildDesired strips every repo field except `branchProtection`, so the
 *     shared diff emits no repo-scalar entries (those belong to repo-settings).
 *   - fetchLive lists org repos and, per repo, its protections — populating only
 *     `branchProtection` for the same reason.
 *
 *   apply (resourceType "branch-protection", key `${repo}/${ruleName}`):
 *     create → POST   /repos/{org}/{repo}/branch_protections
 *     update → PATCH  /repos/{org}/{repo}/branch_protections/{rule}
 *     delete → DELETE /repos/{org}/{repo}/branch_protections/{rule}
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, BranchProtectionConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveRepo, LiveBranchProtection } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type BranchProtectionScope = Record<string, never>;

interface GhBP {
  rule_name?: string;
  branch_name?: string;
  enable_push?: boolean;
  require_signed_commits?: boolean;
  required_approvals?: number;
  enable_status_check?: boolean;
  status_check_contexts?: string[];
  block_on_outdated_branch?: boolean;
  dismiss_stale_approvals?: boolean;
}
interface GhRepo {
  name?: string;
}

function mapBP(raw: GhBP): LiveBranchProtection {
  const bp: LiveBranchProtection = { ruleName: raw.rule_name ?? raw.branch_name ?? "" };
  if (typeof raw.enable_push === "boolean") bp.enablePush = raw.enable_push;
  if (typeof raw.require_signed_commits === "boolean") bp.requireSignedCommits = raw.require_signed_commits;
  if (typeof raw.required_approvals === "number") bp.requiredApprovals = raw.required_approvals;
  if (typeof raw.enable_status_check === "boolean") bp.enableStatusCheck = raw.enable_status_check;
  if (Array.isArray(raw.status_check_contexts)) bp.statusCheckContexts = raw.status_check_contexts;
  if (typeof raw.block_on_outdated_branch === "boolean") bp.blockOnOutdatedBranch = raw.block_on_outdated_branch;
  if (typeof raw.dismiss_stale_approvals === "boolean") bp.dismissStaleApprovals = raw.dismiss_stale_approvals;
  return bp;
}

/** Build a Forgejo branch-protection body; on create, `rule_name` is included. */
export function buildBPBody(d: BranchProtectionConfig, includeName: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (includeName) body.rule_name = d.ruleName;
  if (d.enablePush !== undefined) body.enable_push = d.enablePush;
  if (d.requireSignedCommits !== undefined) body.require_signed_commits = d.requireSignedCommits;
  if (d.requiredApprovals !== undefined) body.required_approvals = d.requiredApprovals;
  if (d.enableStatusCheck !== undefined) body.enable_status_check = d.enableStatusCheck;
  if (d.statusCheckContexts !== undefined) body.status_check_contexts = d.statusCheckContexts;
  if (d.blockOnOutdatedBranch !== undefined) body.block_on_outdated_branch = d.blockOnOutdatedBranch;
  if (d.dismissStaleApprovals !== undefined) body.dismiss_stale_approvals = d.dismissStaleApprovals;
  return body;
}

export const branchProtectionCycle: Cycle<BranchProtectionScope> = {
  name: "branch-protection",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: BranchProtectionScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const orgRepos = await paginate<GhRepo>(client, `/orgs/${scopeId}/repos`, budget);
    const repos: Record<string, LiveRepo> = {};
    for (const r of orgRepos) {
      if (!r.name) continue;
      const bps = await paginate<GhBP>(client, `/repos/${scopeId}/${r.name}/branch_protections`, budget);
      repos[r.name] = { branchProtection: bps.map(mapBP) };
    }
    return { repos };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    const repos: Record<string, { branchProtection: BranchProtectionConfig[] }> = {};
    for (const [name, rc] of Object.entries(orgConfig.repos ?? {})) {
      if (rc.branchProtection !== undefined) repos[name] = { branchProtection: rc.branchProtection };
    }
    return Object.keys(repos).length ? { repos } : {};
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: BranchProtectionScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "branch-protection") return;
    const slash = entry.key.indexOf("/");
    const repo = entry.key.slice(0, slash);
    const ruleName = entry.key.slice(slash + 1);
    const base = `/repos/${scopeId}/${repo}/branch_protections`;

    if (entry.kind === "create") {
      charge(budget);
      await client.request("POST", base, buildBPBody(entry.after as BranchProtectionConfig, true));
      return;
    }
    if (entry.kind === "update") {
      charge(budget);
      await client.request("PATCH", `${base}/${encodeURIComponent(ruleName)}`, buildBPBody(entry.after as BranchProtectionConfig, false));
      return;
    }
    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", `${base}/${encodeURIComponent(ruleName)}`);
    }
  },
};
