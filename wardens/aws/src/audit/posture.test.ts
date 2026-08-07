import { describe, expect, it } from "vitest";
import type { AwsGovernanceConfig } from "../config/types.js";
import type { LiveOrgState } from "../reconcile/live.js";
import { auditPosture, renderPostureFindings, shouldFail, postureFetchParts } from "./posture.js";

const DENY_LEAVE = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Deny", Action: "organizations:LeaveOrganization", Resource: "*" }],
};

const config: AwsGovernanceConfig = {
  organization: { scps: ["deny-leave-organization"] },
  ous: { Security: {}, Workloads: { accounts: [{ name: "checkout", email: "aws+checkout@acme.dev" }] } },
  scps: { "deny-leave-organization": { document: DENY_LEAVE, description: "root guard" } },
  identity: {
    permissionSets: { admin: { description: "full admin" } },
    breakGlass: { principal: "BreakGlass", principalType: "GROUP", permissionSet: "admin", accounts: ["checkout"] },
  },
  auditSinks: { cloudtrail: { bucket: "acme-audit", multiRegion: true } },
};

/** Live state that matches `config` exactly — the no-findings baseline. */
function liveInPosture(): LiveOrgState {
  return {
    rootId: "r-1",
    pathById: { "r-1": "", "ou-sec": "Security", "ou-wl": "Workloads" },
    ous: [
      { id: "ou-sec", path: "Security", name: "Security", parentId: "r-1", owned: true },
      { id: "ou-wl", path: "Workloads", name: "Workloads", parentId: "r-1", owned: true },
    ],
    accounts: [{ id: "111111111111", name: "checkout", email: "aws+checkout@acme.dev", ouPath: "Workloads" }],
    scps: [
      {
        id: "p-1",
        name: "deny-leave-organization",
        description: "root guard",
        document: DENY_LEAVE,
        targetIds: ["r-1"],
        awsManaged: false,
        owned: true,
      },
    ],
    trails: [{ name: "organization-trail", bucket: "acme-audit", multiRegion: true, isOrganizationTrail: true }],
    identity: {
      instanceArn: "arn:aws:sso:::instance/ssoins-1",
      identityStoreId: "d-1",
      permissionSets: [
        {
          arn: "arn:ps-1",
          name: "admin",
          description: "full admin",
          sessionDuration: undefined,
          managedPolicies: [],
          inlinePolicy: undefined,
          owned: true,
        },
      ],
      assignments: [
        {
          accountId: "111111111111",
          accountName: "checkout",
          permissionSetArn: "arn:ps-1",
          permissionSetName: "admin",
          principalId: "g-1",
          principalType: "GROUP",
          principalName: "BreakGlass",
        },
      ],
    },
  };
}

describe("auditPosture (#793)", () => {
  it("reports nothing when live matches the declared posture", () => {
    expect(auditPosture(config, liveInPosture())).toEqual([]);
  });

  it("flags a declared SCP missing live as merge-worthy", () => {
    const live = liveInPosture();
    live.scps = [];
    const findings = auditPosture(config, live);
    const f = findings.find((x) => x.id === "scp-missing-live");
    expect(f).toMatchObject({ tier: "merge-worthy", category: "security", verb: "policy-guardrail", key: "deny-leave-organization" });
  });

  it("flags a live warden-owned SCP the config no longer declares", () => {
    const live = liveInPosture();
    live.scps!.push({
      id: "p-2",
      name: "deny-audit-tamper",
      description: undefined,
      document: DENY_LEAVE,
      targetIds: ["ou-sec"],
      awsManaged: false,
      owned: true,
    });
    const findings = auditPosture(config, live);
    expect(findings.map((f) => f.id)).toEqual(["scp-undeclared"]);
    expect(findings[0].message).toContain("removes the guardrail");
  });

  it("flags document and target drift, but not description drift", () => {
    const live = liveInPosture();
    live.scps![0].document = { Version: "2012-10-17", Statement: [] };
    live.scps![0].targetIds = [];
    live.scps![0].description = "renamed";
    const ids = auditPosture(config, live).map((f) => f.id).sort();
    expect(ids).toEqual(["scp-document-drift", "scp-targets-drift"]);
  });

  it("flags the audit-sink regressions: missing, single-region, bucket drift, undeclared", () => {
    const missing = liveInPosture();
    missing.trails = [];
    expect(auditPosture(config, missing).map((f) => f.id)).toEqual(["trail-missing-live"]);

    const scoped = liveInPosture();
    scoped.trails = [{ name: "organization-trail", bucket: "other-bucket", multiRegion: false, isOrganizationTrail: true }];
    const ids = auditPosture(config, scoped).map((f) => f.id).sort();
    expect(ids).toEqual(["trail-bucket-drift", "trail-single-region"]);

    const undeclared = auditPosture({ ...config, auditSinks: undefined }, liveInPosture());
    expect(undeclared.map((f) => f.id)).toEqual(["trail-undeclared"]);
    expect(undeclared[0].tier).toBe("report-only");
  });

  it("flags a missing break-glass grant, not ordinary assignment drift", () => {
    const live = liveInPosture();
    live.identity!.assignments = [];
    const findings = auditPosture(config, live);
    expect(findings.map((f) => f.id)).toEqual(["break-glass-missing"]);
    expect(findings[0]).toMatchObject({ tier: "merge-worthy", verb: "identity-assignment" });

    const withExtraAssignment: AwsGovernanceConfig = {
      ...config,
      identity: {
        ...config.identity!,
        assignments: [{ principal: "Platform", principalType: "GROUP", permissionSet: "admin", accounts: ["checkout"] }],
      },
    };
    const drifted = auditPosture(withExtraAssignment, liveInPosture());
    expect(drifted.filter((f) => f.verb === "identity-assignment")).toEqual([]);
  });

  it("selects live parts from the config shape", () => {
    expect(postureFetchParts(config)).toEqual({ scps: true, trails: true, identity: true });
    expect(postureFetchParts({ ...config, identity: undefined })).toEqual({ scps: true, trails: true });
  });
});

describe("posture rendering + exit policy", () => {
  it("renders findings with tier and verb, and totals", () => {
    const live = liveInPosture();
    live.scps = [];
    const out = renderPostureFindings(auditPosture(config, live));
    expect(out).toContain("[merge-worthy] policy-guardrail scp-missing-live:");
    expect(out).toContain("merge-worthy=1");
  });

  it("renders the in-posture case", () => {
    const out = renderPostureFindings([]);
    expect(out).toContain("no posture regressions");
    expect(out).toContain("total=0");
  });

  it("shouldFail mirrors github-warden's audit thresholds", () => {
    const live = liveInPosture();
    live.scps = [];
    const findings = auditPosture(config, live);
    expect(shouldFail(findings, "merge-worthy")).toBe(true);
    expect(shouldFail(findings, "any")).toBe(true);
    expect(shouldFail(findings, "none")).toBe(false);
    expect(shouldFail([], "merge-worthy")).toBe(false);
  });
});
