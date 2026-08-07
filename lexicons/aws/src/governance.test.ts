import { describe, expect, test } from "vitest";
import { landingZoneConfig, FOUNDATION_OUS } from "./governance";

describe("landingZoneConfig (#791)", () => {
  test("the default is the recommended foundation", () => {
    const cfg = landingZoneConfig();
    expect(Object.keys(cfg.ous)).toEqual(["Security", "Infrastructure", "Sandbox", "Workloads"]);
    expect(cfg.organization.scps).toEqual(["deny-leave-organization"]);
    expect(cfg.ous.Security.scps).toEqual(["deny-audit-tamper"]);
    expect(Object.keys(cfg.scps).sort()).toEqual(["deny-audit-tamper", "deny-leave-organization"]);
    expect(cfg.auditSinks).toBeUndefined();
  });

  test("custom OUs and accounts merge over the foundation (brownfield: partial trees work)", () => {
    const cfg = landingZoneConfig({
      ous: {
        Workloads: {
          children: { Prod: { accounts: [{ name: "checkout", email: "aws+checkout@acme.dev" }] } },
        },
      },
    });
    // Same-name key wins over the foundation's Workloads…
    expect(cfg.ous.Workloads.children?.Prod.accounts?.[0].name).toBe("checkout");
    // …while the rest of the foundation persists.
    expect(cfg.ous.Security).toEqual(FOUNDATION_OUS.Security);

    const partial = landingZoneConfig({ foundation: false, ous: { Legacy: {} }, rootScps: [] });
    expect(Object.keys(partial.ous)).toEqual(["Legacy"]);
    expect(partial.organization.scps).toBeUndefined();
    expect(partial.scps).toEqual({});
  });

  test("allowedRegions adds a root region-restriction SCP", () => {
    const cfg = landingZoneConfig({ allowedRegions: ["eu-west-1", "eu-central-1"] });
    expect(cfg.organization.scps).toContain("region-restriction");
    expect(JSON.stringify(cfg.scps["region-restriction"].document)).toContain("eu-central-1");
  });

  test("cloudtrailBucket declares the audit sink", () => {
    const cfg = landingZoneConfig({ cloudtrailBucket: "acme-audit" });
    expect(cfg.auditSinks?.cloudtrail).toEqual({ bucket: "acme-audit", multiRegion: true });
  });

  test("identity passes through; assignments must reference defined permission sets", () => {
    const identity = {
      permissionSets: { admin: { managedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"] } },
      breakGlass: { principal: "BreakGlass", principalType: "GROUP" as const, permissionSet: "admin", accounts: ["management"] },
    };
    const cfg = landingZoneConfig({ identity });
    expect(cfg.identity).toEqual(identity);
    expect(landingZoneConfig().identity).toBeUndefined();

    expect(() =>
      landingZoneConfig({
        identity: {
          permissionSets: {},
          assignments: [{ principal: "Platform", principalType: "GROUP", permissionSet: "nope", accounts: ["management"] }],
        },
      }),
    ).toThrowError('references permission set "nope"');
    expect(() =>
      landingZoneConfig({
        identity: {
          permissionSets: {},
          breakGlass: { principal: "BreakGlass", principalType: "GROUP", permissionSet: "gone", accounts: ["management"] },
        },
      }),
    ).toThrowError('references permission set "gone"');
  });

  test("only attached SCPs are emitted; attaching an undefined SCP throws", () => {
    const cfg = landingZoneConfig({
      scps: { unused: { document: { Version: "2012-10-17", Statement: [] } } },
    });
    expect(cfg.scps.unused).toBeUndefined();

    expect(() => landingZoneConfig({ ous: { Security: { scps: ["nope"] } } })).toThrowError(
      'SCP "nope" is attached but not defined',
    );
  });
});
