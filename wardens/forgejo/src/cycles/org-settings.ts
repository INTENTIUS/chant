/**
 * Org-settings cycle — the template cycle.
 *
 * Reconciles org-level settings via the Forgejo org API. Every subsequent cycle
 * follows this four-part structure:
 *   1. config shape   — `OrgSettings` (src/config/types.ts)
 *   2. fetchLive      — GET /orgs/{org}  → LiveOrgSettings (budget-aware)
 *   3. buildDesired   — config → minimal OrgConfig (pure)
 *   4. apply          — PATCH /orgs/{org} with declared fields (budget-aware)
 *
 * `PATCH /orgs/{org}` is a partial update, so selective-by-omission holds by
 * sending only declared keys — no read-modify-write needed.
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig, OrgSettings } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState, LiveOrgSettings } from "../reconcile/live.js";

/** No sub-resource selector — the org is identified by `scopeId`. */
export type OrgSettingsScope = Record<string, never>;

/** Minimal shape of the `GET /orgs/{org}` response we read. */
interface GhOrg {
  full_name?: string | null;
  description?: string | null;
  website?: string | null;
  location?: string | null;
  visibility?: string | null;
  repo_admin_change_team_access?: boolean | null;
}

const VALID_VISIBILITY = new Set(["public", "limited", "private"]);

function mapOrgToLive(raw: GhOrg): LiveOrgSettings {
  const live: LiveOrgSettings = {};
  if (raw.full_name != null) live.fullName = raw.full_name;
  if (raw.description != null) live.description = raw.description;
  if (raw.website != null) live.website = raw.website;
  if (raw.location != null) live.location = raw.location;
  if (raw.visibility != null && VALID_VISIBILITY.has(raw.visibility)) {
    live.visibility = raw.visibility as LiveOrgSettings["visibility"];
  }
  if (typeof raw.repo_admin_change_team_access === "boolean") {
    live.repoAdminChangeTeamAccess = raw.repo_admin_change_team_access;
  }
  return live;
}

/** Build the `PATCH /orgs/{org}` body from declared settings (camelCase → snake_case). */
export function buildOrgPatchBody(desired: OrgSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (desired.fullName !== undefined) body.full_name = desired.fullName;
  if (desired.description !== undefined) body.description = desired.description;
  if (desired.website !== undefined) body.website = desired.website;
  if (desired.location !== undefined) body.location = desired.location;
  if (desired.visibility !== undefined) body.visibility = desired.visibility;
  if (desired.repoAdminChangeTeamAccess !== undefined) {
    body.repo_admin_change_team_access = desired.repoAdminChangeTeamAccess;
  }
  return body;
}

export const orgSettingsCycle: Cycle<OrgSettingsScope> = {
  name: "org-settings",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: OrgSettingsScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }
    budget.use(1);
    let raw: GhOrg;
    try {
      raw = await client.request<GhOrg>("GET", `/orgs/${scopeId}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return {};
      throw err;
    }
    return { settings: mapOrgToLive(raw) };
  },

  buildDesired(orgConfig: OrgConfig, _scopeId: string, _scope: OrgSettingsScope): OrgConfig {
    if (!orgConfig.settings) return {};
    return { settings: orgConfig.settings };
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: OrgSettingsScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "org-settings") return;
    if (entry.kind === "delete") return; // org settings are never deleted
    const body = buildOrgPatchBody(entry.after as OrgSettings);
    if (Object.keys(body).length === 0) return;
    budget.use(1);
    await client.request("PATCH", `/orgs/${scopeId}`, body);
  },
};
