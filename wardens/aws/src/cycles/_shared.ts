/**
 * Shared apply-side helpers: resolving OU paths, policy names, and account
 * names to live ids at apply time. Apply re-resolves rather than trusting ids
 * captured at diff time, so entries created earlier in the same run (a parent
 * OU, say) resolve correctly.
 */

import type { RateBudget } from "@intentius/chant/reconcile";
import type { AwsClient } from "../auth/client.js";

export async function resolveRootId(client: AwsClient, budget: RateBudget): Promise<string> {
  budget.use();
  const roots = await client.request<{ Roots: Array<{ Id: string }> }>("organizations", "ListRoots");
  const rootId = roots.Roots[0]?.Id;
  if (!rootId) throw new Error("no organization root found");
  return rootId;
}

/** Resolve an OU path ("" = root) to its id, walking segment by segment. */
export async function resolveOuIdForPath(client: AwsClient, budget: RateBudget, path: string): Promise<string> {
  let parentId = await resolveRootId(client, budget);
  if (path === "") return parentId;
  for (const segment of path.split("/")) {
    budget.use();
    const children = await client.paginate<{ Id: string; Name: string }>(
      "organizations",
      "ListOrganizationalUnitsForParent",
      { ParentId: parentId },
      (p) => p.OrganizationalUnits as Array<{ Id: string; Name: string }> | undefined,
    );
    const match = children.find((c) => c.Name === segment);
    if (!match) throw new Error(`OU path "${path}" not found (missing segment "${segment}")`);
    parentId = match.Id;
  }
  return parentId;
}

export async function resolveScpIdByName(client: AwsClient, budget: RateBudget, name: string): Promise<string> {
  budget.use();
  const policies = await client.paginate<{ Id: string; Name: string }>(
    "organizations",
    "ListPolicies",
    { Filter: "SERVICE_CONTROL_POLICY" },
    (p) => p.Policies as Array<{ Id: string; Name: string }> | undefined,
  );
  const match = policies.find((p) => p.Name === name);
  if (!match) throw new Error(`SCP "${name}" not found`);
  return match.Id;
}

export async function resolveAccountIdByName(client: AwsClient, budget: RateBudget, name: string): Promise<string> {
  budget.use();
  const accounts = await client.paginate<{ Id: string; Name: string }>(
    "organizations",
    "ListAccounts",
    {},
    (p) => p.Accounts as Array<{ Id: string; Name: string }> | undefined,
  );
  const match = accounts.find((a) => a.Name === name);
  if (!match) throw new Error(`account "${name}" not found in the organization`);
  return match.Id;
}

/** The parent (root or OU) an account currently sits under. */
export async function resolveAccountParentId(client: AwsClient, budget: RateBudget, accountId: string): Promise<string> {
  budget.use();
  const parents = await client.request<{ Parents: Array<{ Id: string }> }>("organizations", "ListParents", {
    ChildId: accountId,
  });
  const parent = parents.Parents[0]?.Id;
  if (!parent) throw new Error(`account ${accountId} has no parent (impossible in a healthy org)`);
  return parent;
}
