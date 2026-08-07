/**
 * org-unit cycle: the OU tree and account placements.
 *
 * Apply supports OU create/delete (delete only ever reaches apply for
 * warden-owned OUs — the diff gates it) and account moves. Account
 * creation/closure is deliberately manual: the entry stays visible in the
 * plan, and apply fails it with instructions rather than provisioning
 * accounts (real money, real e-mail addresses) from a reconcile loop.
 */

import type { ChangeSetEntry } from "@intentius/chant/reconcile";
import type { Cycle } from "../reconcile/runner.js";
import { fetchLiveOrg, OWNERSHIP_TAG } from "../reconcile/live.js";
import { resolveAccountIdByName, resolveAccountParentId, resolveOuIdForPath } from "./_shared.js";

async function apply(
  client: Parameters<Cycle["apply"]>[0],
  entry: ChangeSetEntry,
  _scopeId: string,
  _scope: unknown,
  budget: Parameters<Cycle["apply"]>[4],
): Promise<void> {
  if (entry.resourceType === "ou") {
    const path = entry.key;
    if (entry.kind === "create") {
      const idx = path.lastIndexOf("/");
      const parentPath = idx === -1 ? "" : path.slice(0, idx);
      const name = idx === -1 ? path : path.slice(idx + 1);
      const parentId = await resolveOuIdForPath(client, budget, parentPath);
      budget.use();
      await client.request("organizations", "CreateOrganizationalUnit", {
        ParentId: parentId,
        Name: name,
        Tags: [OWNERSHIP_TAG],
      });
      return;
    }
    if (entry.kind === "delete") {
      const ouId = (entry.before as { id: string }).id;
      budget.use();
      await client.request("organizations", "DeleteOrganizationalUnit", { OrganizationalUnitId: ouId });
      return;
    }
  }
  if (entry.resourceType === "account") {
    if (entry.kind === "update") {
      const accountId = await resolveAccountIdByName(client, budget, entry.key);
      const sourceParentId = await resolveAccountParentId(client, budget, accountId);
      const destParentId = await resolveOuIdForPath(client, budget, (entry.after as { ouPath: string }).ouPath);
      budget.use();
      await client.request("organizations", "MoveAccount", {
        AccountId: accountId,
        SourceParentId: sourceParentId,
        DestinationParentId: destParentId,
      });
      return;
    }
    if (entry.kind === "create") {
      throw new Error(
        `account "${entry.key}" is declared but does not exist — account creation is deliberately manual ` +
          `(billing + root e-mail): create it in the organization, then re-run to place it`,
      );
    }
  }
  throw new Error(`org-unit apply: unsupported entry [${entry.resourceType}] ${entry.kind}`);
}

export const orgUnitsCycle: Cycle = {
  name: "org-units",
  verb: "org-unit",
  fetchLive: (client, _scopeId, _scope, budget) => fetchLiveOrg(client, budget, { tree: true }),
  buildDesired: (config) => config,
  apply,
};
