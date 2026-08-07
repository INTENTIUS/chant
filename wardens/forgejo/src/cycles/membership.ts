/**
 * Membership cycle — org member inventory + ownership-gated removal.
 *
 * Forgejo org membership is **team-driven**: there is no "add this user to the
 * org" endpoint — a user becomes a member by joining a team. So this cycle:
 *   - fetchLive   — GET /orgs/{org}/members (paginated) → LiveMember[]
 *   - buildDesired— config.members (presence list)
 *   - apply
 *       · delete  — DELETE /orgs/{org}/members/{user}  (ownership-gated by diff)
 *       · create  — fails loudly: adds must go through the teams cycle
 *
 * A failed create lands in the cycle's `failed` list (run continues, `completed`
 * goes false) rather than silently dropping — the operator is told to use teams.
 */

import type { ForgejoClient } from "../auth/client.js";
import type { OrgConfig } from "../config/types.js";
import type { ChangeSetEntry } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import type { LiveOrgState } from "../reconcile/live.js";
import { charge, paginate } from "./_shared.js";

export type MembershipScope = Record<string, never>;

interface GhUser {
  login?: string;
  username?: string;
}

export const membershipCycle: Cycle<MembershipScope> = {
  name: "membership",

  async fetchLive(
    client: ForgejoClient,
    scopeId: string,
    _scope: MembershipScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    const users = await paginate<GhUser>(client, `/orgs/${scopeId}/members`, budget);
    const members = users
      .map((u) => u.login ?? u.username)
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .map((username) => ({ username }));
    return { members };
  },

  buildDesired(orgConfig: OrgConfig): OrgConfig {
    if (!orgConfig.members) return {};
    return { members: orgConfig.members };
  },

  async apply(
    client: ForgejoClient,
    entry: ChangeSetEntry,
    scopeId: string,
    _scope: MembershipScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "member") return;
    const username = entry.key;
    if (entry.kind === "delete") {
      charge(budget);
      await client.request("DELETE", `/orgs/${scopeId}/members/${username}`);
      return;
    }
    if (entry.kind === "create") {
      throw new Error(
        `cannot add member '${username}' directly: Forgejo org membership is team-driven — ` +
          `add them to a team via the 'teams' cycle`,
      );
    }
    // updates are impossible (membership has no fields)
  },
};
