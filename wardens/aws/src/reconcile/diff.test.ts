import { describe, expect, it } from "vitest";
import type { AwsGovernanceConfig } from "../config/types.js";
import { diff, diffAuditSinks, diffIdentity, diffOrgUnits, diffScps } from "./diff.js";
import type { LiveOrgState } from "./live.js";

const DOC = { Version: "2012-10-17", Statement: [] };

const config: AwsGovernanceConfig = {
  organization: { scps: ["deny-leave-organization"] },
  ous: {
    Security: { scps: ["deny-audit-tamper"] },
    Workloads: {
      children: { Prod: { accounts: [{ name: "checkout", email: "aws+checkout@acme.dev" }] } },
    },
  },
  scps: {
    "deny-leave-organization": { document: DOC, description: "root guard" },
    "deny-audit-tamper": { document: DOC },
  },
  identity: {
    permissionSets: {
      admin: { description: "full admin", managedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"] },
      readonly: { sessionDuration: "PT8H", managedPolicies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"] },
    },
    assignments: [{ principal: "Platform", principalType: "GROUP", permissionSet: "readonly", accounts: ["checkout"] }],
    breakGlass: { principal: "BreakGlass", principalType: "GROUP", permissionSet: "admin", accounts: ["checkout"] },
  },
  auditSinks: { cloudtrail: { bucket: "acme-audit", multiRegion: true } },
};

function liveBase(): LiveOrgState {
  return {
    rootId: "r-1",
    pathById: { "r-1": "", "ou-sec": "Security", "ou-wl": "Workloads", "ou-prod": "Workloads/Prod" },
    ous: [
      { id: "ou-sec", path: "Security", name: "Security", parentId: "r-1", owned: true },
      { id: "ou-wl", path: "Workloads", name: "Workloads", parentId: "r-1", owned: true },
      { id: "ou-prod", path: "Workloads/Prod", name: "Prod", parentId: "ou-wl", owned: true },
    ],
    accounts: [{ id: "111111111111", name: "checkout", email: "aws+checkout@acme.dev", ouPath: "Workloads/Prod" }],
    scps: [
      {
        id: "p-1",
        name: "deny-leave-organization",
        description: "root guard",
        document: DOC,
        targetIds: ["r-1"],
        awsManaged: false,
        owned: true,
      },
      {
        id: "p-2",
        name: "deny-audit-tamper",
        description: undefined,
        document: DOC,
        targetIds: ["ou-sec"],
        awsManaged: false,
        owned: true,
      },
    ],
    trails: [{ name: "org-trail", bucket: "acme-audit", multiRegion: true, isOrganizationTrail: true }],
    identity: {
      instanceArn: "arn:aws:sso:::instance/ssoins-1",
      identityStoreId: "d-1",
      permissionSets: [
        {
          arn: "ps-admin",
          name: "admin",
          description: "full admin",
          sessionDuration: undefined,
          managedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
          inlinePolicy: undefined,
          owned: true,
        },
        {
          arn: "ps-readonly",
          name: "readonly",
          description: undefined,
          sessionDuration: "PT8H",
          managedPolicies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
          inlinePolicy: undefined,
          owned: true,
        },
      ],
      assignments: [
        {
          accountId: "111111111111",
          accountName: "checkout",
          permissionSetArn: "ps-readonly",
          permissionSetName: "readonly",
          principalId: "g-1",
          principalType: "GROUP",
          principalName: "Platform",
        },
        {
          accountId: "111111111111",
          accountName: "checkout",
          permissionSetArn: "ps-admin",
          permissionSetName: "admin",
          principalId: "g-2",
          principalType: "GROUP",
          principalName: "BreakGlass",
        },
      ],
    },
  };
}

describe("aws warden diff", () => {
  it("a converged org produces an empty plan", () => {
    expect(diff("organization", config, liveBase()).entries).toEqual([]);
  });

  it("missing OUs are creates, parents before children", () => {
    const live = liveBase();
    live.ous = live.ous!.filter((o) => !o.path.startsWith("Workloads"));
    live.accounts = [];
    const entries = diffOrgUnits("organization", config, live).entries;
    const ouCreates = entries.filter((e) => e.resourceType === "ou").map((e) => e.key);
    expect(ouCreates).toEqual(["Workloads", "Workloads/Prod"]);
    // The account it should contain is a create apply will refuse (manual step).
    expect(entries.find((e) => e.resourceType === "account")?.kind).toBe("create");
  });

  it("an undeclared live OU inside a managed subtree deletes only when owned", () => {
    const live = liveBase();
    live.ous!.push({ id: "ou-x", path: "Workloads/Stray", name: "Stray", parentId: "ou-wl", owned: false });
    expect(diffOrgUnits("organization", config, live).entries).toEqual([]);
    live.ous!.at(-1)!.owned = true;
    const entries = diffOrgUnits("organization", config, live).entries;
    expect(entries).toEqual([{ kind: "delete", resourceType: "ou", key: "Workloads/Stray", before: { id: "ou-x" } }]);
  });

  it("an undeclared top-level subtree is out of scope (selective-by-omission)", () => {
    const live = liveBase();
    live.ous!.push({ id: "ou-y", path: "Legacy", name: "Legacy", parentId: "r-1", owned: true });
    expect(diffOrgUnits("organization", config, live).entries).toEqual([]);
  });

  it("an account in the wrong OU is a move update", () => {
    const live = liveBase();
    live.accounts![0].ouPath = "Sandbox";
    const entries = diffOrgUnits("organization", config, live).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "update", resourceType: "account", key: "checkout" });
    expect(entries[0].fields).toEqual([{ field: "ouPath", before: "Sandbox", after: "Workloads/Prod" }]);
  });

  it("SCP drift is field-level: document, description, targets", () => {
    const live = liveBase();
    live.scps![0].document = { Version: "2012-10-17", Statement: [{ weakened: true }] };
    live.scps![1].targetIds = []; // detached
    const entries = diffScps("organization", config, live).entries;
    expect(entries.map((e) => [e.key, e.fields!.map((f) => f.field)])).toEqual([
      ["deny-leave-organization", ["document"]],
      ["deny-audit-tamper", ["targets"]],
    ]);
  });

  it("an undeclared SCP deletes only when warden-owned and never when AWS-managed", () => {
    const live = liveBase();
    live.scps!.push({ id: "p-x", name: "stray", description: undefined, document: DOC, targetIds: [], awsManaged: false, owned: false });
    live.scps!.push({ id: "p-full", name: "FullAWSAccess", description: undefined, document: DOC, targetIds: ["r-1"], awsManaged: true, owned: false });
    expect(diffScps("organization", config, live).entries).toEqual([]);
    live.scps![2].owned = true;
    expect(diffScps("organization", config, live).entries).toEqual([
      { kind: "delete", resourceType: "scp", key: "stray", before: { id: "p-x" } },
    ]);
  });

  it("permission-set drift is field-level; deletes are ownership-gated", () => {
    const live = liveBase();
    live.identity!.permissionSets[0].managedPolicies = [];
    live.identity!.permissionSets[1].sessionDuration = "PT1H";
    const entries = diffIdentity("organization", config, live).entries.filter((e) => e.resourceType === "permission-set");
    expect(entries.map((e) => [e.key, e.fields!.map((f) => f.field)])).toEqual([
      ["admin", ["managedPolicies"]],
      ["readonly", ["sessionDuration"]],
    ]);

    const stray = liveBase();
    stray.identity!.permissionSets.push({
      arn: "ps-stray",
      name: "stray",
      description: undefined,
      sessionDuration: undefined,
      managedPolicies: [],
      inlinePolicy: undefined,
      owned: false,
    });
    expect(diffIdentity("organization", config, stray).entries).toEqual([]);
    stray.identity!.permissionSets.at(-1)!.owned = true;
    expect(diffIdentity("organization", config, stray).entries).toEqual([
      { kind: "delete", resourceType: "permission-set", key: "stray", before: { arn: "ps-stray", name: "stray" } },
    ]);
  });

  it("assignments: missing grants are creates (break-glass implicitly desired); undeclared grants delete only under declared permission sets", () => {
    const live = liveBase();
    live.identity!.assignments = [];
    const creates = diffIdentity("organization", config, live).entries.filter((e) => e.resourceType === "assignment");
    expect(creates.map((e) => e.key).sort()).toEqual([
      "admin/checkout/GROUP:BreakGlass",
      "readonly/checkout/GROUP:Platform",
    ]);
    expect(creates.every((e) => e.kind === "create")).toBe(true);

    const extra = liveBase();
    extra.identity!.assignments.push({
      accountId: "111111111111",
      accountName: "checkout",
      permissionSetArn: "ps-readonly",
      permissionSetName: "readonly",
      principalId: "u-1",
      principalType: "USER",
      principalName: "mallory",
    });
    // An assignment under an UNDECLARED permission set is out of scope.
    extra.identity!.assignments.push({
      accountId: "111111111111",
      accountName: "checkout",
      permissionSetArn: "ps-legacy",
      permissionSetName: "legacy",
      principalId: "g-9",
      principalType: "GROUP",
      principalName: "Old",
    });
    const entries = diffIdentity("organization", config, extra).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "delete", resourceType: "assignment", key: "readonly/checkout/USER:mallory" });
  });

  it("no identity section declared → identity is out of scope entirely", () => {
    const noIdentity: AwsGovernanceConfig = { ...config, identity: undefined };
    expect(diffIdentity("organization", noIdentity, liveBase()).entries).toEqual([]);
  });

  it("a missing organization trail is a create; a mismatched one is an update; none are deletes", () => {
    const live = liveBase();
    live.trails = [];
    expect(diffAuditSinks("organization", config, live).entries[0]).toMatchObject({
      kind: "create",
      resourceType: "trail",
    });
    live.trails = [{ name: "org-trail", bucket: "wrong", multiRegion: false, isOrganizationTrail: true }];
    const update = diffAuditSinks("organization", config, live).entries[0];
    expect(update.fields!.map((f) => f.field)).toEqual(["bucket", "multiRegion"]);

    const noSink: AwsGovernanceConfig = { ...config, auditSinks: undefined };
    expect(diffAuditSinks("organization", noSink, liveBase()).entries).toEqual([]);
  });

  it("the dispatcher emits only fetched parts", () => {
    const treeOnly: LiveOrgState = { ...liveBase(), scps: undefined, trails: undefined, identity: undefined };
    const entries = diff("organization", { ...config, ous: {} }, treeOnly).entries;
    expect(entries.every((e) => e.resourceType === "ou" || e.resourceType === "account")).toBe(true);
  });
});
