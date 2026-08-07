/**
 * Live-state fetch for the AWS governance surface. Each cycle fetches only
 * its parts (`fetchLiveOrg(client, budget, { tree, scps, trails, identity })`)
 * into the shared `LiveOrgState` shape; the shared diff emits entries only
 * for parts that are present. Every API call charges the run's RateBudget.
 */

import type { RateBudget } from "@intentius/chant/reconcile";
import type { AwsClient } from "../auth/client.js";

export interface LiveOu {
  id: string;
  /** Slash-joined path from the root, e.g. "Workloads/Prod". */
  path: string;
  name: string;
  parentId: string;
  /** True when the warden's ownership tag is present (deletes are gated on it). */
  owned: boolean;
}

export interface LiveAccount {
  id: string;
  name: string;
  email: string;
  /** Path of the OU it currently sits in ("" = directly under root). */
  ouPath: string;
}

export interface LiveScp {
  id: string;
  name: string;
  description: string | undefined;
  document: Record<string, unknown>;
  /** Target ids (root id or OU ids) the policy is attached to. */
  targetIds: string[];
  awsManaged: boolean;
  owned: boolean;
}

export interface LiveTrail {
  name: string;
  bucket: string;
  multiRegion: boolean;
  isOrganizationTrail: boolean;
}

export interface LivePermissionSet {
  arn: string;
  name: string;
  description: string | undefined;
  sessionDuration: string | undefined;
  /** Managed policy ARNs, sorted. */
  managedPolicies: string[];
  inlinePolicy: Record<string, unknown> | undefined;
  owned: boolean;
}

export interface LiveAssignment {
  accountId: string;
  /** Organization account name; falls back to the raw id when unresolvable. */
  accountName: string;
  permissionSetArn: string;
  permissionSetName: string;
  principalId: string;
  principalType: "GROUP" | "USER";
  /** Identity-store DisplayName/UserName; falls back to the raw id. */
  principalName: string;
}

export interface LiveIdentity {
  instanceArn: string;
  identityStoreId: string;
  permissionSets: LivePermissionSet[];
  assignments: LiveAssignment[];
}

export interface LiveOrgState {
  /** Present whenever the org tree was needed (tree/scps fetches). */
  rootId?: string;
  ous?: LiveOu[];
  /** OU id -> path, including the root as "". */
  pathById?: Record<string, string>;
  accounts?: LiveAccount[];
  scps?: LiveScp[];
  trails?: LiveTrail[];
  /** IAM Identity Center: permission sets and account assignments. */
  identity?: LiveIdentity;
}

export interface FetchParts {
  /** Root + OU tree + account placements. */
  tree?: boolean;
  /** SCPs with documents and attachments (implies the tree, for target paths). */
  scps?: boolean;
  /** CloudTrail trails. */
  trails?: boolean;
  /** IAM Identity Center permission sets + assignments. */
  identity?: boolean;
}

/** The tag that marks a resource as warden-managed (delete-eligible). */
export const OWNERSHIP_TAG = { Key: "managed-by", Value: "aws-warden" };

interface RawOu {
  Id: string;
  Name: string;
}

async function isOwnedSso(
  client: AwsClient,
  budget: RateBudget,
  instanceArn: string,
  resourceArn: string,
): Promise<boolean> {
  budget.use();
  try {
    const res = await client.request<{ Tags?: Array<{ Key: string; Value: string }> }>(
      "sso-admin",
      "ListTagsForResource",
      { InstanceArn: instanceArn, ResourceArn: resourceArn },
    );
    return (res.Tags ?? []).some((t) => t.Key === OWNERSHIP_TAG.Key && t.Value === OWNERSHIP_TAG.Value);
  } catch {
    // Same contract as isOwned: an unreadable tag never makes a resource
    // delete-eligible.
    return false;
  }
}

async function isOwned(client: AwsClient, budget: RateBudget, resourceId: string): Promise<boolean> {
  budget.use();
  try {
    const res = await client.request<{ Tags?: Array<{ Key: string; Value: string }> }>(
      "organizations",
      "ListTagsForResource",
      { ResourceId: resourceId },
    );
    return (res.Tags ?? []).some((t) => t.Key === OWNERSHIP_TAG.Key && t.Value === OWNERSHIP_TAG.Value);
  } catch {
    // Tag listing is advisory: failing to read tags must never make a
    // resource delete-eligible.
    return false;
  }
}

export async function fetchLiveOrg(client: AwsClient, budget: RateBudget, parts: FetchParts): Promise<LiveOrgState> {
  const state: LiveOrgState = {};
  const needTree = Boolean(parts.tree || parts.scps);

  if (needTree) {
    budget.use();
    const roots = await client.request<{ Roots: Array<{ Id: string }> }>("organizations", "ListRoots");
    const rootId = roots.Roots[0]?.Id;
    if (!rootId) throw new Error("no organization root found — is this the organization's management account?");
    state.rootId = rootId;

    const ous: LiveOu[] = [];
    const pathById: Record<string, string> = { [rootId]: "" };
    const accounts: LiveAccount[] = [];

    const walk = async (parentId: string, path: string): Promise<void> => {
      budget.use();
      const children = await client.paginate<RawOu>(
        "organizations",
        "ListOrganizationalUnitsForParent",
        { ParentId: parentId },
        (p) => p.OrganizationalUnits as RawOu[] | undefined,
      );
      for (const child of children) {
        const childPath = path ? `${path}/${child.Name}` : child.Name;
        pathById[child.Id] = childPath;
        ous.push({
          id: child.Id,
          path: childPath,
          name: child.Name,
          parentId,
          owned: await isOwned(client, budget, child.Id),
        });
        await walk(child.Id, childPath);
      }
      if (parts.tree) {
        budget.use();
        const accts = await client.paginate<{ Id: string; Name: string; Email: string }>(
          "organizations",
          "ListAccountsForParent",
          { ParentId: parentId },
          (p) => p.Accounts as Array<{ Id: string; Name: string; Email: string }> | undefined,
        );
        for (const a of accts) accounts.push({ id: a.Id, name: a.Name, email: a.Email, ouPath: path });
      }
    };
    await walk(rootId, "");
    state.pathById = pathById;
    if (parts.tree) {
      state.ous = ous;
      state.accounts = accounts;
    }
  }

  if (parts.scps) {
    budget.use();
    const rawScps = await client.paginate<{ Id: string; Name: string; Description?: string; AwsManaged?: boolean }>(
      "organizations",
      "ListPolicies",
      { Filter: "SERVICE_CONTROL_POLICY" },
      (p) => p.Policies as Array<{ Id: string; Name: string; Description?: string; AwsManaged?: boolean }> | undefined,
    );
    const scps: LiveScp[] = [];
    for (const raw of rawScps) {
      budget.use();
      const desc = await client.request<{ Policy: { Content: string } }>("organizations", "DescribePolicy", {
        PolicyId: raw.Id,
      });
      budget.use();
      const targets = await client.paginate<{ TargetId: string }>(
        "organizations",
        "ListTargetsForPolicy",
        { PolicyId: raw.Id },
        (p) => p.Targets as Array<{ TargetId: string }> | undefined,
      );
      scps.push({
        id: raw.Id,
        name: raw.Name,
        description: raw.Description,
        document: JSON.parse(desc.Policy.Content) as Record<string, unknown>,
        targetIds: targets.map((t) => t.TargetId),
        awsManaged: raw.AwsManaged ?? false,
        owned: raw.AwsManaged ? false : await isOwned(client, budget, raw.Id),
      });
    }
    state.scps = scps;
  }

  if (parts.trails) {
    budget.use();
    const trailsRes = await client.request<{
      trailList?: Array<{ Name: string; S3BucketName: string; IsMultiRegionTrail?: boolean; IsOrganizationTrail?: boolean }>;
    }>("cloudtrail", "DescribeTrails", {});
    state.trails = (trailsRes.trailList ?? []).map((t) => ({
      name: t.Name,
      bucket: t.S3BucketName,
      multiRegion: t.IsMultiRegionTrail ?? false,
      isOrganizationTrail: t.IsOrganizationTrail ?? false,
    }));
  }

  if (parts.identity) {
    state.identity = await fetchIdentity(client, budget);
  }

  return state;
}

async function fetchIdentity(client: AwsClient, budget: RateBudget): Promise<LiveIdentity> {
  budget.use();
  const instances = await client.request<{ Instances?: Array<{ InstanceArn: string; IdentityStoreId: string }> }>(
    "sso-admin",
    "ListInstances",
  );
  const instance = instances.Instances?.[0];
  if (!instance) throw new Error("no IAM Identity Center instance found — enable it in the management account first");
  const { InstanceArn: instanceArn, IdentityStoreId: identityStoreId } = instance;

  // Account id -> name, for assignment keys the config can express.
  budget.use();
  const accounts = await client.paginate<{ Id: string; Name: string }>(
    "organizations",
    "ListAccounts",
    {},
    (p) => p.Accounts as Array<{ Id: string; Name: string }> | undefined,
  );
  const accountNameById = new Map(accounts.map((a) => [a.Id, a.Name]));

  budget.use();
  const psArns = await client.paginate<string>(
    "sso-admin",
    "ListPermissionSets",
    { InstanceArn: instanceArn },
    (p) => p.PermissionSets as string[] | undefined,
  );

  const permissionSets: LivePermissionSet[] = [];
  const assignments: LiveAssignment[] = [];
  const principalNames = new Map<string, string>();

  const principalName = async (type: "GROUP" | "USER", id: string): Promise<string> => {
    const cacheKey = `${type}:${id}`;
    const cached = principalNames.get(cacheKey);
    if (cached !== undefined) return cached;
    budget.use();
    let name = id;
    try {
      if (type === "GROUP") {
        const g = await client.request<{ DisplayName?: string }>("identitystore", "DescribeGroup", {
          IdentityStoreId: identityStoreId,
          GroupId: id,
        });
        name = g.DisplayName ?? id;
      } else {
        const u = await client.request<{ UserName?: string }>("identitystore", "DescribeUser", {
          IdentityStoreId: identityStoreId,
          UserId: id,
        });
        name = u.UserName ?? id;
      }
    } catch {
      // Advisory, like tag reads: an unresolvable principal keeps its id.
    }
    principalNames.set(cacheKey, name);
    return name;
  };

  for (const arn of psArns) {
    budget.use();
    const described = await client.request<{
      PermissionSet: { Name: string; Description?: string; SessionDuration?: string };
    }>("sso-admin", "DescribePermissionSet", { InstanceArn: instanceArn, PermissionSetArn: arn });
    budget.use();
    const managed = await client.paginate<{ Arn: string }>(
      "sso-admin",
      "ListManagedPoliciesInPermissionSet",
      { InstanceArn: instanceArn, PermissionSetArn: arn },
      (p) => p.AttachedManagedPolicies as Array<{ Arn: string }> | undefined,
    );
    budget.use();
    const inline = await client.request<{ InlinePolicy?: string }>("sso-admin", "GetInlinePolicyForPermissionSet", {
      InstanceArn: instanceArn,
      PermissionSetArn: arn,
    });
    permissionSets.push({
      arn,
      name: described.PermissionSet.Name,
      description: described.PermissionSet.Description,
      sessionDuration: described.PermissionSet.SessionDuration,
      managedPolicies: managed.map((m) => m.Arn).sort(),
      inlinePolicy: inline.InlinePolicy ? (JSON.parse(inline.InlinePolicy) as Record<string, unknown>) : undefined,
      owned: await isOwnedSso(client, budget, instanceArn, arn),
    });

    budget.use();
    const provisionedAccounts = await client.paginate<string>(
      "sso-admin",
      "ListAccountsForProvisionedPermissionSet",
      { InstanceArn: instanceArn, PermissionSetArn: arn },
      (p) => p.AccountIds as string[] | undefined,
    );
    for (const accountId of provisionedAccounts) {
      budget.use();
      const rows = await client.paginate<{ PrincipalId: string; PrincipalType: "GROUP" | "USER" }>(
        "sso-admin",
        "ListAccountAssignments",
        { InstanceArn: instanceArn, AccountId: accountId, PermissionSetArn: arn },
        (p) => p.AccountAssignments as Array<{ PrincipalId: string; PrincipalType: "GROUP" | "USER" }> | undefined,
      );
      for (const row of rows) {
        assignments.push({
          accountId,
          accountName: accountNameById.get(accountId) ?? accountId,
          permissionSetArn: arn,
          permissionSetName: described.PermissionSet.Name,
          principalId: row.PrincipalId,
          principalType: row.PrincipalType,
          principalName: await principalName(row.PrincipalType, row.PrincipalId),
        });
      }
    }
  }

  return { instanceArn, identityStoreId, permissionSets, assignments };
}
