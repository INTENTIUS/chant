/**
 * Full-loop convergence test: the real client (SigV4 and all), the real
 * cycles, and the real runner against an in-memory Organizations/CloudTrail
 * backend. The floci emulator has no organizations service yet
 * (test/floci-gaps.md entry 5), so this is the executable version of the e2e
 * suite's promise: dry-run proposes the foundation, apply converges, the
 * re-run plan is empty, and drift injected afterwards is re-detected.
 */

import { describe, expect, it } from "vitest";
import { createClient } from "../auth/client.js";
import { runReconcile } from "./runner.js";
import { orgUnitsCycle } from "../cycles/org-units.js";
import { scpsCycle } from "../cycles/scps.js";
import { identityCycle } from "../cycles/identity.js";
import { auditTrailCycle } from "../cycles/audit-trail.js";
import type { AwsGovernanceConfig } from "../config/types.js";

// ── In-memory AWS backend ──────────────────────────────────────────────────

interface FakeOu {
  Id: string;
  Name: string;
  ParentId: string;
}
interface FakePolicy {
  Id: string;
  Name: string;
  Description: string;
  Content: string;
  targets: Set<string>;
  tags: Array<{ Key: string; Value: string }>;
}
interface FakePermissionSet {
  Arn: string;
  Name: string;
  Description: string;
  SessionDuration: string;
  managedPolicies: Set<string>;
  InlinePolicy?: string;
}
interface FakeSsoAssignment {
  AccountId: string;
  PermissionSetArn: string;
  PrincipalType: "GROUP" | "USER";
  PrincipalId: string;
}

const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-1";
const IDENTITY_STORE_ID = "d-1";

function fakeAws(): { fetchImpl: typeof fetch; state: ReturnType<typeof mkState> } {
  const state = mkState();
  const handlers: Record<string, (req: any) => unknown> = {
    ListRoots: () => ({ Roots: [{ Id: "r-1" }] }),
    ListOrganizationalUnitsForParent: (req) => ({
      OrganizationalUnits: state.ous.filter((o) => o.ParentId === req.ParentId),
    }),
    ListAccountsForParent: (req) => ({
      Accounts: state.accounts.filter((a) => a.ParentId === req.ParentId),
    }),
    ListAccounts: () => ({ Accounts: state.accounts }),
    ListParents: (req) => ({
      Parents: [{ Id: state.accounts.find((a) => a.Id === req.ChildId)?.ParentId ?? "r-1" }],
    }),
    MoveAccount: (req) => {
      const acct = state.accounts.find((a) => a.Id === req.AccountId)!;
      acct.ParentId = req.DestinationParentId;
      return {};
    },
    CreateOrganizationalUnit: (req) => {
      const ou: FakeOu = { Id: `ou-${state.seq++}`, Name: req.Name, ParentId: req.ParentId };
      state.ous.push(ou);
      state.tags.set(ou.Id, req.Tags ?? []);
      return { OrganizationalUnit: ou };
    },
    DeleteOrganizationalUnit: (req) => {
      state.ous = state.ous.filter((o) => o.Id !== req.OrganizationalUnitId);
      return {};
    },
    ListPolicies: () => ({
      Policies: state.policies.map((p) => ({ Id: p.Id, Name: p.Name, Description: p.Description, AwsManaged: false })),
    }),
    DescribePolicy: (req) => {
      const p = state.policies.find((x) => x.Id === req.PolicyId)!;
      return { Policy: { Content: p.Content, PolicySummary: { Id: p.Id } } };
    },
    ListTargetsForPolicy: (req) => ({
      Targets: [...state.policies.find((x) => x.Id === req.PolicyId)!.targets].map((t) => ({ TargetId: t })),
    }),
    // Shared action name: Organizations sends ResourceId, SSO Admin ResourceArn.
    ListTagsForResource: (req) => ({ Tags: state.tags.get(req.ResourceArn ?? req.ResourceId) ?? [] }),
    CreatePolicy: (req) => {
      const p: FakePolicy = {
        Id: `p-${state.seq++}`,
        Name: req.Name,
        Description: req.Description ?? "",
        Content: req.Content,
        targets: new Set(),
        tags: req.Tags ?? [],
      };
      state.policies.push(p);
      state.tags.set(p.Id, p.tags);
      return { Policy: { PolicySummary: { Id: p.Id } } };
    },
    UpdatePolicy: (req) => {
      const p = state.policies.find((x) => x.Id === req.PolicyId)!;
      if (req.Content) p.Content = req.Content;
      if (req.Description !== undefined) p.Description = req.Description;
      return {};
    },
    AttachPolicy: (req) => {
      state.policies.find((x) => x.Id === req.PolicyId)!.targets.add(req.TargetId);
      return {};
    },
    DetachPolicy: (req) => {
      state.policies.find((x) => x.Id === req.PolicyId)!.targets.delete(req.TargetId);
      return {};
    },
    DeletePolicy: (req) => {
      state.policies = state.policies.filter((x) => x.Id !== req.PolicyId);
      return {};
    },
    DescribeTrails: () => ({ trailList: state.trails }),
    CreateTrail: (req) => {
      state.trails.push({
        Name: req.Name,
        S3BucketName: req.S3BucketName,
        IsMultiRegionTrail: req.IsMultiRegionTrail,
        IsOrganizationTrail: req.IsOrganizationTrail,
      });
      return {};
    },
    UpdateTrail: (req) => {
      const t = state.trails.find((x) => x.Name === req.Name)!;
      t.S3BucketName = req.S3BucketName;
      t.IsMultiRegionTrail = req.IsMultiRegionTrail;
      return {};
    },
    StartLogging: () => ({}),
    ListInstances: () => ({ Instances: [{ InstanceArn: INSTANCE_ARN, IdentityStoreId: IDENTITY_STORE_ID }] }),
    ListPermissionSets: () => ({ PermissionSets: state.permissionSets.map((p) => p.Arn) }),
    DescribePermissionSet: (req) => {
      const p = state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!;
      return {
        PermissionSet: { Name: p.Name, Description: p.Description, SessionDuration: p.SessionDuration, PermissionSetArn: p.Arn },
      };
    },
    ListManagedPoliciesInPermissionSet: (req) => ({
      AttachedManagedPolicies: [...state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!.managedPolicies].map(
        (arn) => ({ Arn: arn }),
      ),
    }),
    GetInlinePolicyForPermissionSet: (req) => ({
      InlinePolicy: state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!.InlinePolicy ?? "",
    }),
    CreatePermissionSet: (req) => {
      const p: FakePermissionSet = {
        Arn: `ps-${state.seq++}`,
        Name: req.Name,
        Description: req.Description ?? "",
        SessionDuration: req.SessionDuration,
        managedPolicies: new Set(),
      };
      state.permissionSets.push(p);
      state.tags.set(p.Arn, req.Tags ?? []);
      return { PermissionSet: { PermissionSetArn: p.Arn } };
    },
    UpdatePermissionSet: (req) => {
      const p = state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!;
      if (req.Description !== undefined) p.Description = req.Description;
      if (req.SessionDuration !== undefined) p.SessionDuration = req.SessionDuration;
      return {};
    },
    DeletePermissionSet: (req) => {
      state.permissionSets = state.permissionSets.filter((x) => x.Arn !== req.PermissionSetArn);
      return {};
    },
    AttachManagedPolicyToPermissionSet: (req) => {
      state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!.managedPolicies.add(req.ManagedPolicyArn);
      return {};
    },
    DetachManagedPolicyFromPermissionSet: (req) => {
      state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!.managedPolicies.delete(req.ManagedPolicyArn);
      return {};
    },
    PutInlinePolicyToPermissionSet: (req) => {
      state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!.InlinePolicy = req.InlinePolicy;
      return {};
    },
    DeleteInlinePolicyFromPermissionSet: (req) => {
      state.permissionSets.find((x) => x.Arn === req.PermissionSetArn)!.InlinePolicy = undefined;
      return {};
    },
    ProvisionPermissionSet: () => ({ PermissionSetProvisioningStatus: { Status: "SUCCEEDED" } }),
    ListAccountsForProvisionedPermissionSet: (req) => ({
      AccountIds: [...new Set(state.ssoAssignments.filter((a) => a.PermissionSetArn === req.PermissionSetArn).map((a) => a.AccountId))],
    }),
    ListAccountAssignments: (req) => ({
      AccountAssignments: state.ssoAssignments.filter(
        (a) => a.AccountId === req.AccountId && a.PermissionSetArn === req.PermissionSetArn,
      ),
    }),
    CreateAccountAssignment: (req) => {
      state.ssoAssignments.push({
        AccountId: req.TargetId,
        PermissionSetArn: req.PermissionSetArn,
        PrincipalType: req.PrincipalType,
        PrincipalId: req.PrincipalId,
      });
      return { AccountAssignmentCreationStatus: { Status: "SUCCEEDED" } };
    },
    DeleteAccountAssignment: (req) => {
      state.ssoAssignments = state.ssoAssignments.filter(
        (a) =>
          !(
            a.AccountId === req.TargetId &&
            a.PermissionSetArn === req.PermissionSetArn &&
            a.PrincipalType === req.PrincipalType &&
            a.PrincipalId === req.PrincipalId
          ),
      );
      return { AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" } };
    },
    ListGroups: (req) => ({
      Groups: state.groups.filter((g) => g.DisplayName === req.Filters?.[0]?.AttributeValue),
    }),
    ListUsers: (req) => ({
      Users: state.users.filter((u) => u.UserName === req.Filters?.[0]?.AttributeValue),
    }),
    DescribeGroup: (req) => state.groups.find((g) => g.GroupId === req.GroupId)!,
    DescribeUser: (req) => state.users.find((u) => u.UserId === req.UserId)!,
  };

  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = (init!.headers as Record<string, string>)["x-amz-target"];
    const action = target.split(".").pop()!;
    const handler = handlers[action];
    if (!handler) {
      return new Response(JSON.stringify({ __type: "UnknownOperationException", message: action }), { status: 404 });
    }
    return new Response(JSON.stringify(handler(JSON.parse(String(init!.body)))), { status: 200 });
  }) as typeof fetch;

  return { fetchImpl, state };
}

function mkState() {
  return {
    seq: 1,
    ous: [] as FakeOu[],
    // The management account pre-exists (account creation is manual by design).
    accounts: [{ Id: "111111111111", Name: "management", Email: "root@acme.dev", ParentId: "r-1" }],
    policies: [] as FakePolicy[],
    trails: [] as Array<{ Name: string; S3BucketName: string; IsMultiRegionTrail: boolean; IsOrganizationTrail: boolean }>,
    permissionSets: [] as FakePermissionSet[],
    ssoAssignments: [] as FakeSsoAssignment[],
    groups: [
      { GroupId: "g-1", DisplayName: "Platform" },
      { GroupId: "g-2", DisplayName: "BreakGlass" },
    ],
    users: [] as Array<{ UserId: string; UserName: string }>,
    tags: new Map<string, Array<{ Key: string; Value: string }>>(),
  };
}

// ── The scenario ───────────────────────────────────────────────────────────

const DOC = (marker: string): Record<string, unknown> => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Deny", Action: marker, Resource: "*" }],
});

const config: AwsGovernanceConfig = {
  organization: { scps: ["deny-leave-organization"] },
  ous: {
    Security: { scps: ["deny-audit-tamper"] },
    Workloads: { children: { Prod: {} } },
  },
  scps: {
    "deny-leave-organization": { description: "root guard", document: DOC("organizations:LeaveOrganization") },
    "deny-audit-tamper": { document: DOC("cloudtrail:StopLogging") },
  },
  identity: {
    permissionSets: {
      admin: { description: "full admin", managedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"] },
      readonly: { sessionDuration: "PT8H", managedPolicies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"] },
    },
    assignments: [{ principal: "Platform", principalType: "GROUP", permissionSet: "readonly", accounts: ["management"] }],
    breakGlass: { principal: "BreakGlass", principalType: "GROUP", permissionSet: "admin", accounts: ["management"] },
  },
  auditSinks: { cloudtrail: { bucket: "acme-audit", multiRegion: true } },
};

const CYCLES = [orgUnitsCycle, scpsCycle, identityCycle, auditTrailCycle];

describe("aws-warden convergence (in-memory backend)", () => {
  it("dry-run proposes, apply converges, re-run is empty, drift is re-detected", async () => {
    const { fetchImpl, state } = fakeAws();
    const client = createClient({ credentials: { accessKeyId: "test", secretAccessKey: "test" }, fetchImpl });

    const dry = await runReconcile({ config, client, cycles: CYCLES, mode: "dry-run" });
    expect(dry.errored).toEqual([]);
    expect(dry.cycles.find((c) => c.name === "org-units")!.counts.create).toBe(3);
    expect(dry.cycles.find((c) => c.name === "scps")!.counts.create).toBe(2);
    // 2 permission sets + the Platform grant + the implicitly-desired break-glass.
    expect(dry.cycles.find((c) => c.name === "identity")!.counts.create).toBe(4);
    expect(dry.cycles.find((c) => c.name === "audit-trail")!.counts.create).toBe(1);

    const apply = await runReconcile({ config, client, cycles: CYCLES, mode: "apply" });
    expect(apply.errored).toEqual([]);
    for (const c of apply.cycles) {
      expect(c.failed, `${c.name}: ${JSON.stringify(c.failed)}`).toEqual([]);
      expect(c.guardrailBlocked).toBe(false);
    }

    // Everything landed with the ownership tag.
    expect(state.ous.map((o) => o.Name).sort()).toEqual(["Prod", "Security", "Workloads"]);
    expect(state.policies.map((p) => p.Name).sort()).toEqual(["deny-audit-tamper", "deny-leave-organization"]);
    expect(state.trails).toHaveLength(1);
    for (const p of state.policies) {
      expect(state.tags.get(p.Id)).toEqual([{ Key: "managed-by", Value: "aws-warden" }]);
    }
    expect(state.permissionSets.map((p) => p.Name).sort()).toEqual(["admin", "readonly"]);
    for (const p of state.permissionSets) {
      expect(state.tags.get(p.Arn)).toEqual([{ Key: "managed-by", Value: "aws-warden" }]);
    }
    expect(state.ssoAssignments).toHaveLength(2);
    expect(state.ssoAssignments.map((a) => a.PrincipalId).sort()).toEqual(["g-1", "g-2"]);

    const rerun = await runReconcile({ config, client, cycles: CYCLES, mode: "dry-run" });
    for (const c of rerun.cycles) {
      expect(c.counts, `${c.name} plan not empty:\n${c.plan}`).toEqual({ create: 0, update: 0, delete: 0 });
    }

    // Inject drift: weaken a policy document + detach the root SCP target.
    const guard = state.policies.find((p) => p.Name === "deny-leave-organization")!;
    guard.Content = JSON.stringify(DOC("s3:GetObject"));
    const drift = await runReconcile({ config, client, cycles: [scpsCycle], mode: "dry-run" });
    const scpsResult = drift.cycles[0];
    expect(scpsResult.counts.update).toBe(1);
    expect(scpsResult.plan).toContain("deny-leave-organization");

    // And the fix converges again.
    const fix = await runReconcile({ config, client, cycles: [scpsCycle], mode: "apply" });
    expect(fix.cycles[0].failed).toEqual([]);
    expect(JSON.parse(guard.Content)).toEqual(DOC("organizations:LeaveOrganization"));

    // Identity drift: the break-glass grant vanishes out-of-band + a policy
    // is detached from a permission set. Both re-detected and re-applied.
    state.ssoAssignments = state.ssoAssignments.filter((a) => a.PrincipalId !== "g-2");
    state.permissionSets.find((p) => p.Name === "readonly")!.managedPolicies.clear();
    const identityDrift = await runReconcile({ config, client, cycles: [identityCycle], mode: "dry-run" });
    expect(identityDrift.cycles[0].counts).toEqual({ create: 1, update: 1, delete: 0 });
    expect(identityDrift.cycles[0].plan).toContain("admin/management/GROUP:BreakGlass");

    const identityFix = await runReconcile({ config, client, cycles: [identityCycle], mode: "apply" });
    expect(identityFix.cycles[0].failed).toEqual([]);
    expect(state.ssoAssignments.map((a) => a.PrincipalId).sort()).toEqual(["g-1", "g-2"]);
    expect([...state.permissionSets.find((p) => p.Name === "readonly")!.managedPolicies]).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });

  it("a missing identity-store principal fails its entry with instructions, not the run", async () => {
    const { fetchImpl, state } = fakeAws();
    state.groups = state.groups.filter((g) => g.DisplayName !== "Platform");
    const client = createClient({ credentials: { accessKeyId: "test", secretAccessKey: "test" }, fetchImpl });

    const res = await runReconcile({ config, client, cycles: [identityCycle], mode: "apply" });
    expect(res.cycles[0].failed).toHaveLength(1);
    expect(res.cycles[0].failed[0].error).toContain('group "Platform" not found in the identity store');
    // Everything else (both sets + the break-glass grant) still landed.
    expect(state.permissionSets).toHaveLength(2);
    expect(state.ssoAssignments.map((a) => a.PrincipalId)).toEqual(["g-2"]);
  });

  it("the break-glass admin guardrail blocks a plan that would drop the break-glass path", async () => {
    const { fetchImpl, state } = fakeAws();
    const client = createClient({ credentials: { accessKeyId: "test", secretAccessKey: "test" }, fetchImpl });

    // Converge first.
    await runReconcile({ config, client, cycles: CYCLES, mode: "apply" });

    // A config that drops the admin permission set while still naming it as
    // the break-glass path: the delete plan must be refused.
    const dropped: AwsGovernanceConfig = {
      ...config,
      identity: {
        ...config.identity!,
        permissionSets: { readonly: config.identity!.permissionSets.readonly },
      },
    };
    const res = await runReconcile({ config: dropped, client, cycles: [identityCycle], mode: "apply" });
    expect(res.cycles[0].guardrailBlocked).toBe(true);
    expect(res.cycles[0].applied).toEqual([]);
    const guardrails = res.cycles[0].guardrails;
    expect(guardrails.ok).toBe(false);
    if (!guardrails.ok) {
      expect(guardrails.diagnostics.map((d) => d.guardrail)).toContain("breakGlassAdmin");
    }
    expect(state.permissionSets.map((p) => p.Name).sort()).toEqual(["admin", "readonly"]);
  });

  it("the root-SCP floor blocks an apply that would strip the root", async () => {
    const { fetchImpl } = fakeAws();
    const client = createClient({ credentials: { accessKeyId: "test", secretAccessKey: "test" }, fetchImpl });

    // Converge first.
    await runReconcile({ config, client, cycles: CYCLES, mode: "apply" });

    // Now a config that drops every root SCP but keeps managing the others.
    const stripped: AwsGovernanceConfig = {
      ...config,
      organization: {},
      scps: { "deny-audit-tamper": config.scps["deny-audit-tamper"] },
    };
    const res = await runReconcile({ config: stripped, client, cycles: [scpsCycle], mode: "apply" });
    expect(res.cycles[0].guardrailBlocked).toBe(true);
    expect(res.cycles[0].applied).toEqual([]);
  });
});
