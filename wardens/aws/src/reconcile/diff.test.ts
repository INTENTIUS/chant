import { describe, expect, it } from "vitest";
import type { AwsGovernanceConfig } from "../config/types.js";
import { diff, diffAuditSinks, diffOrgUnits, diffScps } from "./diff.js";
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
    const treeOnly: LiveOrgState = { ...liveBase(), scps: undefined, trails: undefined };
    const entries = diff("organization", { ...config, ous: {} }, treeOnly).entries;
    expect(entries.every((e) => e.resourceType === "ou" || e.resourceType === "account")).toBe(true);
  });
});
