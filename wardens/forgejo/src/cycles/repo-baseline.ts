/**
 * Repo-baseline cycle — ensures named repos *exist* in the org (provisioning).
 *
 *   fetchLive    — GET /orgs/{org}/repos (paginated) → repo names (existence)
 *   buildDesired — config.repoBaselines
 *   apply        — create the repo when absent:
 *       · template set → POST /repos/{tmplOwner}/{tmplRepo}/generate
 *       · else         → POST /orgs/{org}/repos  (empty repo)
 *
 * Existence-only: the diff (diffRepoBaselines) emits a `create` solely when the
 * named repo is missing live; it never updates or deletes. Repo *settings* are
 * the repo-settings cycle's concern.
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, RepoBaselineConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveRepo } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type RepoBaselineScope = Record<string, never>;

interface GhRepo {
  name?: string;
}

export const repoBaselineCycle: Cycle<RepoBaselineScope> = {
  name: "repo-baseline",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: RepoBaselineScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const raws = await paginate<GhRepo>(client, `/orgs/${scopeId}/repos`, budget);
    const repos: Record<string, LiveRepo> = {};
    for (const r of raws) {
      if (r.name) repos[r.name] = {};
    }
    return { repos };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    if (!orgConfig.repoBaselines) return {};
    return { repoBaselines: orgConfig.repoBaselines };
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: RepoBaselineScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "repo-baseline" || entry.kind !== "create") return;
    const baseline = entry.after as RepoBaselineConfig;
    const isPrivate = baseline.private ?? true;
    charge(budget);
    if (baseline.template) {
      const slash = baseline.template.indexOf("/");
      const owner = baseline.template.slice(0, slash);
      const repo = baseline.template.slice(slash + 1);
      await client.request("POST", `/repos/${owner}/${repo}/generate`, {
        owner: scopeId,
        name: baseline.name,
        private: isPrivate,
      });
      return;
    }
    await client.request("POST", `/orgs/${scopeId}/repos`, {
      name: baseline.name,
      private: isPrivate,
    });
  },
};
