/**
 * Repo-settings cycle — reconciles settings of *existing* org repos.
 *
 *   fetchLive    — GET /orgs/{org}/repos (paginated) → LiveRepo per repo
 *   buildDesired — config.repos
 *   apply        — PATCH /repos/{org}/{repo}          (partial settings)
 *                  PUT   /repos/{org}/{repo}/topics   (full topics replacement)
 *
 * This cycle never *creates* a repo — that's the repo-baseline cycle's job. A
 * declared repo that doesn't exist live surfaces as a `create` whose PATCH 404s
 * into the cycle's `failed[]` (an honest "this repo doesn't exist yet" signal).
 * Against an existing repo, the PATCH is a partial update — selective-by-
 * omission holds, no read-modify-write. Topics are a full-replacement PUT.
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, RepoConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveRepo } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type RepoSettingsScope = Record<string, never>;

interface GhRepo {
  name?: string;
  description?: string | null;
  website?: string | null;
  private?: boolean | null;
  has_issues?: boolean | null;
  has_wiki?: boolean | null;
  has_pull_requests?: boolean | null;
  default_branch?: string | null;
  allow_merge_commits?: boolean | null;
  allow_rebase?: boolean | null;
  allow_squash_merge?: boolean | null;
  default_merge_style?: string | null;
  topics?: string[] | null;
}

function mapRepoToLive(raw: GhRepo): LiveRepo {
  const r: LiveRepo = {};
  if (raw.description != null) r.description = raw.description;
  if (raw.website != null) r.website = raw.website;
  if (typeof raw.private === "boolean") r.private = raw.private;
  if (typeof raw.has_issues === "boolean") r.hasIssues = raw.has_issues;
  if (typeof raw.has_wiki === "boolean") r.hasWiki = raw.has_wiki;
  if (typeof raw.has_pull_requests === "boolean") r.hasPullRequests = raw.has_pull_requests;
  if (raw.default_branch != null) r.defaultBranch = raw.default_branch;
  if (typeof raw.allow_merge_commits === "boolean") r.allowMergeCommits = raw.allow_merge_commits;
  if (typeof raw.allow_rebase === "boolean") r.allowRebase = raw.allow_rebase;
  if (typeof raw.allow_squash_merge === "boolean") r.allowSquashMerge = raw.allow_squash_merge;
  if (raw.default_merge_style != null) r.defaultMergeStyle = raw.default_merge_style;
  if (Array.isArray(raw.topics)) r.topics = raw.topics;
  return r;
}

/** Build the partial `PATCH /repos/{org}/{repo}` body (topics excluded — separate PUT). */
export function buildRepoBody(d: RepoConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.description !== undefined) body.description = d.description;
  if (d.website !== undefined) body.website = d.website;
  if (d.private !== undefined) body.private = d.private;
  if (d.hasIssues !== undefined) body.has_issues = d.hasIssues;
  if (d.hasWiki !== undefined) body.has_wiki = d.hasWiki;
  if (d.hasPullRequests !== undefined) body.has_pull_requests = d.hasPullRequests;
  if (d.defaultBranch !== undefined) body.default_branch = d.defaultBranch;
  if (d.allowMergeCommits !== undefined) body.allow_merge_commits = d.allowMergeCommits;
  if (d.allowRebase !== undefined) body.allow_rebase = d.allowRebase;
  if (d.allowSquashMerge !== undefined) body.allow_squash_merge = d.allowSquashMerge;
  if (d.defaultMergeStyle !== undefined) body.default_merge_style = d.defaultMergeStyle;
  return body;
}

export const repoSettingsCycle: Cycle<RepoSettingsScope> = {
  name: "repo-settings",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: RepoSettingsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const raws = await paginate<GhRepo>(client, `/orgs/${scopeId}/repos`, budget);
    const repos: Record<string, LiveRepo> = {};
    for (const raw of raws) {
      if (raw.name) repos[raw.name] = mapRepoToLive(raw);
    }
    return { repos };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    if (!orgConfig.repos) return {};
    return { repos: orgConfig.repos };
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: RepoSettingsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "repo") return;
    if (entry.kind === "delete") return; // repos are never deleted here
    const repo = entry.key;
    const desired = entry.after as RepoConfig;

    const body = buildRepoBody(desired);
    if (Object.keys(body).length > 0) {
      charge(budget);
      await client.request("PATCH", `/repos/${scopeId}/${repo}`, body);
    }
    if (desired.topics !== undefined) {
      charge(budget);
      await client.request("PUT", `/repos/${scopeId}/${repo}/topics`, { topics: desired.topics });
    }
  },
};
