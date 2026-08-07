/**
 * audit-sink cycle: the organization CloudTrail. Creates the trail (and
 * starts logging) or updates bucket/multi-region on an existing organization
 * trail. Never deletes — an undeclared trail is drift for the audit tier
 * (#793) to surface, not something reconcile removes.
 */

import type { ChangeSetEntry } from "@intentius/chant/reconcile";
import type { Cycle } from "../reconcile/runner.js";
import { fetchLiveOrg } from "../reconcile/live.js";

async function apply(
  client: Parameters<Cycle["apply"]>[0],
  entry: ChangeSetEntry,
  _scopeId: string,
  _scope: unknown,
  budget: Parameters<Cycle["apply"]>[4],
): Promise<void> {
  if (entry.resourceType !== "trail") throw new Error(`audit-trail apply: unsupported entry [${entry.resourceType}]`);
  const want = entry.after as { bucket: string; multiRegion: boolean };

  if (entry.kind === "create") {
    budget.use();
    await client.request("cloudtrail", "CreateTrail", {
      Name: entry.key,
      S3BucketName: want.bucket,
      IsMultiRegionTrail: want.multiRegion,
      IsOrganizationTrail: true,
    });
    budget.use();
    await client.request("cloudtrail", "StartLogging", { Name: entry.key });
    return;
  }

  if (entry.kind === "update") {
    budget.use();
    await client.request("cloudtrail", "UpdateTrail", {
      Name: entry.key,
      S3BucketName: want.bucket,
      IsMultiRegionTrail: want.multiRegion,
    });
    return;
  }

  throw new Error("audit-trail apply: trails are never deleted by reconcile");
}

export const auditTrailCycle: Cycle = {
  name: "audit-trail",
  verb: "audit-sink",
  fetchLive: (client, _scopeId, _scope, budget) => fetchLiveOrg(client, budget, { trails: true }),
  buildDesired: (config) => config,
  apply,
};
