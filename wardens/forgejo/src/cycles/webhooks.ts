/**
 * Webhooks cycle — Forgejo org and repo webhooks (keyed by URL).
 *
 * Forgejo addresses a hook by numeric id, but config/diff key it by URL. So
 * fetchLive carries the live hook `id` (never diffed) and the apply path reads
 * it off the change entry's `before` for update/delete.
 *
 *   fetchLive    — GET /orgs/{org}/hooks + per-repo GET /repos/{org}/{repo}/hooks
 *   buildDesired — config.webhooks (org) + repo.webhooks (per repo)
 *   apply
 *     create → POST   /orgs/{org}/hooks  | /repos/{org}/{repo}/hooks
 *     update → PATCH  …/hooks/{id}
 *     delete → DELETE …/hooks/{id}
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, WebhookConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveRepo, LiveWebhook } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type WebhooksScope = Record<string, never>;

interface GhHook {
  id?: number;
  type?: string;
  active?: boolean;
  events?: string[];
  branch_filter?: string;
  config?: { url?: string; content_type?: string };
}
interface GhRepo {
  name?: string;
}

function mapHook(raw: GhHook): LiveWebhook | null {
  const url = raw.config?.url;
  if (!url) return null;
  const hook: LiveWebhook = { url };
  if (typeof raw.id === "number") hook.id = raw.id;
  if (raw.type != null) hook.type = raw.type;
  if (raw.config?.content_type === "json" || raw.config?.content_type === "form") {
    hook.contentType = raw.config.content_type;
  }
  if (Array.isArray(raw.events)) hook.events = raw.events;
  if (typeof raw.active === "boolean") hook.active = raw.active;
  if (raw.branch_filter != null) hook.branchFilter = raw.branch_filter;
  return hook;
}

async function fetchHooks(
  client: ForgejoClient,
  path: string,
  budget: RateBudget,
): Promise<LiveWebhook[]> {
  const raws = await paginate<GhHook>(client, path, budget);
  return raws.map(mapHook).filter((h): h is LiveWebhook => h !== null);
}

/** Build a Forgejo hook body. On create, `type` is required. */
export function buildHookBody(w: WebhookConfig, includeType: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    config: { url: w.url, content_type: w.contentType ?? "json" },
  };
  if (includeType) body.type = w.type ?? "forgejo";
  if (w.events !== undefined) body.events = w.events;
  if (w.active !== undefined) body.active = w.active;
  if (w.branchFilter !== undefined) body.branch_filter = w.branchFilter;
  return body;
}

export const webhooksCycle: Cycle<WebhooksScope> = {
  name: "webhooks",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: WebhooksScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const webhooks = await fetchHooks(client, `/orgs/${scopeId}/hooks`, budget);
    const orgRepos = await paginate<GhRepo>(client, `/orgs/${scopeId}/repos`, budget);
    const repos: Record<string, LiveRepo> = {};
    for (const r of orgRepos) {
      if (!r.name) continue;
      repos[r.name] = { webhooks: await fetchHooks(client, `/repos/${scopeId}/${r.name}/hooks`, budget) };
    }
    return { webhooks, repos };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    const out: OrgConfig = {};
    if (orgConfig.webhooks !== undefined) out.webhooks = orgConfig.webhooks;
    if (orgConfig.repos) {
      const repos: Record<string, { webhooks: WebhookConfig[] }> = {};
      for (const [name, rc] of Object.entries(orgConfig.repos)) {
        if (rc.webhooks !== undefined) repos[name] = { webhooks: rc.webhooks };
      }
      if (Object.keys(repos).length) out.repos = repos;
    }
    return out;
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: WebhooksScope,
    budget: RateBudget,
  ): Promise<void> {
    const isOrg = entry.resourceType === "org-webhook";
    const isRepo = entry.resourceType === "repo-webhook";
    if (!isOrg && !isRepo) return;

    let base: string;
    if (isRepo) {
      const slash = entry.key.indexOf("/");
      const repo = entry.key.slice(0, slash);
      base = `/repos/${scopeId}/${repo}/hooks`;
    } else {
      base = `/orgs/${scopeId}/hooks`;
    }

    if (entry.kind === "create") {
      charge(budget);
      await client.request("POST", base, buildHookBody(entry.after as WebhookConfig, true));
      return;
    }

    const id = (entry.before as LiveWebhook | undefined)?.id;
    if (typeof id !== "number") throw new Error(`webhook '${entry.key}' has no live id`);
    if (entry.kind === "update") {
      charge(budget);
      await client.request("PATCH", `${base}/${id}`, buildHookBody(entry.after as WebhookConfig, false));
      return;
    }
    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", `${base}/${id}`);
    }
  },
};
