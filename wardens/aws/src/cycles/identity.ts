/**
 * identity-assignment cycle: IAM Identity Center permission sets and account
 * assignments. Creates carry the ownership tag; permission-set deletes only
 * ever reach apply for warden-owned sets (the diff gates it) and tear down
 * their assignments first. Assignment deletes are scoped to config-declared
 * permission sets by the diff. Identity-store principals (users/groups) are
 * never provisioned here — a missing principal fails its entry with
 * instructions, like manual account creation in the org-unit cycle.
 */

import type { ChangeSetEntry } from "@intentius/chant/reconcile";
import type { AwsClient } from "../auth/client.js";
import type { PermissionSetConfig } from "../config/types.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";
import { fetchLiveOrg, OWNERSHIP_TAG } from "../reconcile/live.js";
import {
  resolveAccountIdByName,
  resolvePermissionSetArnByName,
  resolvePrincipalId,
  resolveSsoInstance,
} from "./_shared.js";

interface AssignmentSide {
  principal: string;
  principalType: "GROUP" | "USER";
  permissionSet: string;
  account: string;
}

/** SSO assignment/provisioning calls are async server-side: surface immediate FAILED statuses. */
async function checkAsyncStatus(promise: Promise<unknown>, what: string): Promise<void> {
  const res = (await promise) as Record<string, { Status?: string; FailureReason?: string } | undefined>;
  const status = Object.values(res ?? {}).find((v) => v !== undefined && typeof v === "object" && "Status" in v);
  if (status?.Status === "FAILED") throw new Error(`${what} failed: ${status.FailureReason ?? "unknown reason"}`);
}

async function applyPermissionSet(
  client: AwsClient,
  entry: ChangeSetEntry,
  instanceArn: string,
  budget: RateBudget,
): Promise<void> {
  if (entry.kind === "create") {
    const want = entry.after as Required<Pick<PermissionSetConfig, "description" | "sessionDuration">> &
      PermissionSetConfig & { managedPolicies: string[] };
    budget.use();
    const created = await client.request<{ PermissionSet: { PermissionSetArn: string } }>(
      "sso-admin",
      "CreatePermissionSet",
      {
        InstanceArn: instanceArn,
        Name: entry.key,
        Description: want.description,
        SessionDuration: want.sessionDuration,
        Tags: [OWNERSHIP_TAG],
      },
    );
    const arn = created.PermissionSet.PermissionSetArn;
    for (const policyArn of want.managedPolicies) {
      budget.use();
      await client.request("sso-admin", "AttachManagedPolicyToPermissionSet", {
        InstanceArn: instanceArn,
        PermissionSetArn: arn,
        ManagedPolicyArn: policyArn,
      });
    }
    if (want.inlinePolicy) {
      budget.use();
      await client.request("sso-admin", "PutInlinePolicyToPermissionSet", {
        InstanceArn: instanceArn,
        PermissionSetArn: arn,
        InlinePolicy: JSON.stringify(want.inlinePolicy),
      });
    }
    return;
  }

  if (entry.kind === "update") {
    const arn = await resolvePermissionSetArnByName(client, budget, instanceArn, entry.key);
    const want = entry.after as { description: string; sessionDuration: string; managedPolicies: string[]; inlinePolicy?: Record<string, unknown> };
    const have = entry.before as { managedPolicies: string[]; inlinePolicy?: Record<string, unknown> };
    const changed = new Set(entry.fields?.map((f) => f.field));
    if (changed.has("description") || changed.has("sessionDuration")) {
      budget.use();
      await client.request("sso-admin", "UpdatePermissionSet", {
        InstanceArn: instanceArn,
        PermissionSetArn: arn,
        Description: want.description,
        SessionDuration: want.sessionDuration,
      });
    }
    if (changed.has("managedPolicies")) {
      const wantPolicies = new Set(want.managedPolicies);
      const havePolicies = new Set(have.managedPolicies);
      for (const policyArn of wantPolicies) {
        if (havePolicies.has(policyArn)) continue;
        budget.use();
        await client.request("sso-admin", "AttachManagedPolicyToPermissionSet", {
          InstanceArn: instanceArn,
          PermissionSetArn: arn,
          ManagedPolicyArn: policyArn,
        });
      }
      for (const policyArn of havePolicies) {
        if (wantPolicies.has(policyArn)) continue;
        budget.use();
        await client.request("sso-admin", "DetachManagedPolicyFromPermissionSet", {
          InstanceArn: instanceArn,
          PermissionSetArn: arn,
          ManagedPolicyArn: policyArn,
        });
      }
    }
    if (changed.has("inlinePolicy")) {
      budget.use();
      if (want.inlinePolicy) {
        await client.request("sso-admin", "PutInlinePolicyToPermissionSet", {
          InstanceArn: instanceArn,
          PermissionSetArn: arn,
          InlinePolicy: JSON.stringify(want.inlinePolicy),
        });
      } else {
        await client.request("sso-admin", "DeleteInlinePolicyFromPermissionSet", {
          InstanceArn: instanceArn,
          PermissionSetArn: arn,
        });
      }
    }
    // Push content changes out to every account the set is provisioned in.
    budget.use();
    await checkAsyncStatus(
      client.request("sso-admin", "ProvisionPermissionSet", {
        InstanceArn: instanceArn,
        PermissionSetArn: arn,
        TargetType: "ALL_PROVISIONED_ACCOUNTS",
      }),
      `provisioning permission set "${entry.key}"`,
    );
    return;
  }

  // delete — only warden-owned sets get here (ownership-gated diff)
  const arn = (entry.before as { arn: string }).arn;
  budget.use();
  const accountIds = await client.paginate<string>(
    "sso-admin",
    "ListAccountsForProvisionedPermissionSet",
    { InstanceArn: instanceArn, PermissionSetArn: arn },
    (p) => p.AccountIds as string[] | undefined,
  );
  for (const accountId of accountIds) {
    budget.use();
    const rows = await client.paginate<{ PrincipalId: string; PrincipalType: string }>(
      "sso-admin",
      "ListAccountAssignments",
      { InstanceArn: instanceArn, AccountId: accountId, PermissionSetArn: arn },
      (p) => p.AccountAssignments as Array<{ PrincipalId: string; PrincipalType: string }> | undefined,
    );
    for (const row of rows) {
      budget.use();
      await checkAsyncStatus(
        client.request("sso-admin", "DeleteAccountAssignment", {
          InstanceArn: instanceArn,
          TargetId: accountId,
          TargetType: "AWS_ACCOUNT",
          PermissionSetArn: arn,
          PrincipalType: row.PrincipalType,
          PrincipalId: row.PrincipalId,
        }),
        `deleting an assignment of permission set "${entry.key}"`,
      );
    }
  }
  budget.use();
  await client.request("sso-admin", "DeletePermissionSet", { InstanceArn: instanceArn, PermissionSetArn: arn });
}

async function applyAssignment(
  client: AwsClient,
  entry: ChangeSetEntry,
  instanceArn: string,
  identityStoreId: string,
  budget: RateBudget,
): Promise<void> {
  if (entry.kind === "create") {
    const want = entry.after as AssignmentSide;
    const permissionSetArn = await resolvePermissionSetArnByName(client, budget, instanceArn, want.permissionSet);
    const accountId = await resolveAccountIdByName(client, budget, want.account);
    const principalId = await resolvePrincipalId(client, budget, identityStoreId, want.principalType, want.principal);
    budget.use();
    await checkAsyncStatus(
      client.request("sso-admin", "CreateAccountAssignment", {
        InstanceArn: instanceArn,
        TargetId: accountId,
        TargetType: "AWS_ACCOUNT",
        PermissionSetArn: permissionSetArn,
        PrincipalType: want.principalType,
        PrincipalId: principalId,
      }),
      `creating assignment "${entry.key}"`,
    );
    return;
  }

  if (entry.kind === "delete") {
    const have = entry.before as { accountId: string; permissionSetArn: string; principalId: string; principalType: string };
    budget.use();
    await checkAsyncStatus(
      client.request("sso-admin", "DeleteAccountAssignment", {
        InstanceArn: instanceArn,
        TargetId: have.accountId,
        TargetType: "AWS_ACCOUNT",
        PermissionSetArn: have.permissionSetArn,
        PrincipalType: have.principalType,
        PrincipalId: have.principalId,
      }),
      `deleting assignment "${entry.key}"`,
    );
    return;
  }

  throw new Error(`identity apply: assignments are create/delete only, got ${entry.kind}`);
}

async function apply(
  client: Parameters<Cycle["apply"]>[0],
  entry: ChangeSetEntry,
  _scopeId: string,
  _scope: unknown,
  budget: Parameters<Cycle["apply"]>[4],
): Promise<void> {
  // Apply re-resolves the instance rather than trusting fetch-time state,
  // matching the other cycles' resolve-at-apply discipline.
  const { instanceArn, identityStoreId } = await resolveSsoInstance(client, budget);
  if (entry.resourceType === "permission-set") return applyPermissionSet(client, entry, instanceArn, budget);
  if (entry.resourceType === "assignment") return applyAssignment(client, entry, instanceArn, identityStoreId, budget);
  throw new Error(`identity apply: unsupported entry [${entry.resourceType}]`);
}

export const identityCycle: Cycle = {
  name: "identity",
  verb: "identity-assignment",
  fetchLive: (client, _scopeId, _scope, budget) => fetchLiveOrg(client, budget, { identity: true }),
  buildDesired: (config) => config,
  apply,
};
