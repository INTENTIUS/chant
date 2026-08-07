/**
 * policy-guardrail cycle: service control policies — documents, descriptions,
 * and attachments. Creates carry the ownership tag; deletes only ever reach
 * apply for warden-owned policies (the diff gates it) and detach every
 * target first. AWS-managed policies are never touched.
 */

import type { ChangeSetEntry } from "@intentius/chant/reconcile";
import type { Cycle } from "../reconcile/runner.js";
import { fetchLiveOrg, OWNERSHIP_TAG } from "../reconcile/live.js";
import { resolveOuIdForPath, resolveScpIdByName } from "./_shared.js";

interface ScpSide {
  document?: Record<string, unknown>;
  description?: string;
  targets?: string[];
}

async function apply(
  client: Parameters<Cycle["apply"]>[0],
  entry: ChangeSetEntry,
  _scopeId: string,
  _scope: unknown,
  budget: Parameters<Cycle["apply"]>[4],
): Promise<void> {
  if (entry.resourceType !== "scp") throw new Error(`scp apply: unsupported entry [${entry.resourceType}]`);

  if (entry.kind === "create") {
    const want = entry.after as Required<Pick<ScpSide, "document" | "targets">> & ScpSide;
    budget.use();
    const created = await client.request<{ Policy: { PolicySummary: { Id: string } } }>(
      "organizations",
      "CreatePolicy",
      {
        Name: entry.key,
        Type: "SERVICE_CONTROL_POLICY",
        Content: JSON.stringify(want.document),
        Description: want.description ?? "",
        Tags: [OWNERSHIP_TAG],
      },
    );
    const policyId = created.Policy.PolicySummary.Id;
    for (const path of want.targets) {
      const targetId = await resolveOuIdForPath(client, budget, path);
      budget.use();
      await client.request("organizations", "AttachPolicy", { PolicyId: policyId, TargetId: targetId });
    }
    return;
  }

  if (entry.kind === "update") {
    const policyId = await resolveScpIdByName(client, budget, entry.key);
    const want = entry.after as ScpSide;
    const have = entry.before as ScpSide;
    const contentChanged = entry.fields?.some((f) => f.field === "document" || f.field === "description");
    if (contentChanged) {
      budget.use();
      await client.request("organizations", "UpdatePolicy", {
        PolicyId: policyId,
        ...(want.document ? { Content: JSON.stringify(want.document) } : {}),
        ...(want.description !== undefined ? { Description: want.description } : {}),
      });
    }
    if (entry.fields?.some((f) => f.field === "targets")) {
      const wantTargets = new Set(want.targets ?? []);
      const haveTargets = new Set(have.targets ?? []);
      for (const path of wantTargets) {
        if (haveTargets.has(path)) continue;
        const targetId = await resolveOuIdForPath(client, budget, path);
        budget.use();
        await client.request("organizations", "AttachPolicy", { PolicyId: policyId, TargetId: targetId });
      }
      for (const path of haveTargets) {
        if (wantTargets.has(path)) continue;
        const targetId = await resolveOuIdForPath(client, budget, path);
        budget.use();
        await client.request("organizations", "DetachPolicy", { PolicyId: policyId, TargetId: targetId });
      }
    }
    return;
  }

  // delete — only warden-owned policies get here (ownership-gated diff)
  const policyId = (entry.before as { id: string }).id;
  budget.use();
  const targets = await client.paginate<{ TargetId: string }>(
    "organizations",
    "ListTargetsForPolicy",
    { PolicyId: policyId },
    (p) => p.Targets as Array<{ TargetId: string }> | undefined,
  );
  for (const t of targets) {
    budget.use();
    await client.request("organizations", "DetachPolicy", { PolicyId: policyId, TargetId: t.TargetId });
  }
  budget.use();
  await client.request("organizations", "DeletePolicy", { PolicyId: policyId });
}

export const scpsCycle: Cycle = {
  name: "scps",
  verb: "policy-guardrail",
  fetchLive: (client, _scopeId, _scope, budget) => fetchLiveOrg(client, budget, { scps: true }),
  buildDesired: (config) => config,
  apply,
};
