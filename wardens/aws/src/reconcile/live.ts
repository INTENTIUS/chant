/**
 * Live-state fetch for the AWS governance surface. Each cycle fetches only
 * its parts (`fetchLiveOrg(client, budget, { tree, scps, trails })`) into the
 * shared `LiveOrgState` shape; the shared diff emits entries only for parts
 * that are present. Every API call charges the run's RateBudget.
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

export interface LiveOrgState {
  /** Present whenever the org tree was needed (tree/scps fetches). */
  rootId?: string;
  ous?: LiveOu[];
  /** OU id -> path, including the root as "". */
  pathById?: Record<string, string>;
  accounts?: LiveAccount[];
  scps?: LiveScp[];
  trails?: LiveTrail[];
}

export interface FetchParts {
  /** Root + OU tree + account placements. */
  tree?: boolean;
  /** SCPs with documents and attachments (implies the tree, for target paths). */
  scps?: boolean;
  /** CloudTrail trails. */
  trails?: boolean;
}

/** The tag that marks a resource as warden-managed (delete-eligible). */
export const OWNERSHIP_TAG = { Key: "managed-by", Value: "aws-warden" };

interface RawOu {
  Id: string;
  Name: string;
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

  return state;
}
