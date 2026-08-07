/**
 * Teams cycle — team CRUD plus `team-member` and `team-repo` subresources.
 *
 * Forgejo addresses teams by numeric id, but config (and the diff) key them by
 * name. So:
 *   - fetchLive carries the live team `id` (never diffed) for the apply path.
 *   - team create/update/delete read the id off the change entry's live `before`
 *     (or the POST response for a fresh team).
 *   - team-member / team-repo entries only know the team *name* (from the key),
 *     so apply resolves name → id via `GET /orgs/{org}/teams/{name}`.
 *
 * On create, members/repos are embedded in the team entry (the diff emits no
 * separate child entries for a not-yet-live team), so apply adds them inline
 * using the freshly-created id.
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, TeamConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveTeam } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type TeamsScope = Record<string, never>;

interface GhTeam {
  id?: number;
  name?: string;
  description?: string;
  permission?: string;
  can_create_org_repo?: boolean;
  includes_all_repositories?: boolean;
  units?: string[];
}
interface GhUser {
  login?: string;
  username?: string;
}
interface GhRepo {
  name?: string;
}

const TEAM_PERMS = new Set(["read", "write", "admin", "owner"]);

function mapTeam(raw: GhTeam): LiveTeam {
  const t: LiveTeam = {};
  if (typeof raw.id === "number") t.id = raw.id;
  if (raw.description != null) t.description = raw.description;
  if (raw.permission != null && TEAM_PERMS.has(raw.permission)) {
    t.permission = raw.permission as LiveTeam["permission"];
  }
  if (typeof raw.can_create_org_repo === "boolean") t.canCreateOrgRepo = raw.can_create_org_repo;
  if (typeof raw.includes_all_repositories === "boolean") {
    t.includesAllRepositories = raw.includes_all_repositories;
  }
  if (Array.isArray(raw.units)) t.units = raw.units;
  return t;
}

/** camelCase TeamConfig → Forgejo snake_case body (declared fields only). */
export function buildTeamBody(t: TeamConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (t.description !== undefined) body.description = t.description;
  if (t.permission !== undefined) body.permission = t.permission;
  if (t.canCreateOrgRepo !== undefined) body.can_create_org_repo = t.canCreateOrgRepo;
  if (t.includesAllRepositories !== undefined) body.includes_all_repositories = t.includesAllRepositories;
  if (t.units !== undefined) body.units = t.units;
  return body;
}

/** Split a `${team}/${child}` change key into its two parts. */
function splitTeamKey(key: string): { team: string; child: string } {
  const i = key.indexOf("/");
  return { team: key.slice(0, i), child: key.slice(i + 1) };
}

async function resolveTeamId(
  client: ForgejoClient,
  org: string,
  name: string,
  budget: RateBudget,
): Promise<number> {
  charge(budget);
  const team = await client.request<GhTeam>("GET", `/orgs/${org}/teams/${name}`);
  if (typeof team.id !== "number") throw new Error(`team '${name}' has no id`);
  return team.id;
}

export const teamsCycle: Cycle<TeamsScope> = {
  name: "teams",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: TeamsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const raws = await paginate<GhTeam>(client, `/orgs/${scopeId}/teams`, budget);
    const teams: Record<string, LiveTeam> = {};
    for (const raw of raws) {
      if (!raw.name || typeof raw.id !== "number") continue;
      const t = mapTeam(raw);
      const members = await paginate<GhUser>(client, `/teams/${raw.id}/members`, budget);
      t.members = members
        .map((u) => u.login ?? u.username)
        .filter((u): u is string => typeof u === "string")
        .map((username) => ({ username }));
      const repos = await paginate<GhRepo>(client, `/teams/${raw.id}/repos`, budget);
      t.repos = repos
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string")
        .map((name) => ({ name }));
      teams[raw.name] = t;
    }
    return { teams };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    if (!orgConfig.teams) return {};
    return { teams: orgConfig.teams };
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: TeamsScope,
    budget: RateBudget,
  ): Promise<void> {
    switch (entry.resourceType) {
      case "team":
        return applyTeam(client, entry, scopeId, budget);
      case "team-member":
        return applyTeamMember(client, entry, scopeId, budget);
      case "team-repo":
        return applyTeamRepo(client, entry, scopeId, budget);
      default:
        return;
    }
  },
};

async function applyTeam(
  client: ForgejoClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  if (entry.kind === "create") {
    const cfg = entry.after as TeamConfig;
    charge(budget);
    const created = await client.request<GhTeam>("POST", `/orgs/${org}/teams`, {
      name: entry.key,
      ...buildTeamBody(cfg),
    });
    const id = created.id;
    if (typeof id !== "number") return;
    for (const m of cfg.members ?? []) {
      charge(budget);
      await client.request("PUT", `/teams/${id}/members/${m.username}`);
    }
    for (const r of cfg.repos ?? []) {
      charge(budget);
      await client.request("PUT", `/teams/${id}/repos/${org}/${r.name}`);
    }
    return;
  }
  const live = entry.before as LiveTeam | undefined;
  const id = live?.id;
  if (typeof id !== "number") throw new Error(`team '${entry.key}' has no live id`);
  if (entry.kind === "update") {
    charge(budget);
    await client.request("PATCH", `/teams/${id}`, buildTeamBody(entry.after as TeamConfig));
    return;
  }
  if (entry.kind === "delete") {
    charge(budget);
    await client.request("DELETE", `/teams/${id}`);
  }
}

async function applyTeamMember(
  client: ForgejoClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const { team, child: username } = splitTeamKey(entry.key);
  const id = await resolveTeamId(client, org, team, budget);
  charge(budget);
  if (entry.kind === "delete") {
    await client.request("DELETE", `/teams/${id}/members/${username}`);
  } else {
    await client.request("PUT", `/teams/${id}/members/${username}`);
  }
}

async function applyTeamRepo(
  client: ForgejoClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const { team, child: repo } = splitTeamKey(entry.key);
  const id = await resolveTeamId(client, org, team, budget);
  charge(budget);
  if (entry.kind === "delete") {
    await client.request("DELETE", `/teams/${id}/repos/${org}/${repo}`);
  } else {
    await client.request("PUT", `/teams/${id}/repos/${org}/${repo}`);
  }
}
