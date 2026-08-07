import { describe, expect, test } from "vitest";
import { landingZoneConfig, FOUNDATION_FOLDERS } from "./governance";

describe("landingZoneConfig (#791)", () => {
  test("the default is the recommended foundation", () => {
    const cfg = landingZoneConfig();
    expect(Object.keys(cfg.folders)).toEqual(["Security", "Infrastructure", "Sandbox", "Workloads"]);
    expect(cfg.organization.orgPolicies).toEqual(["disable-sa-key-creation", "skip-default-network"]);
    expect(Object.keys(cfg.orgPolicies).sort()).toEqual(["disable-sa-key-creation", "skip-default-network"]);
    expect(cfg.orgPolicies["disable-sa-key-creation"].constraint).toBe("iam.disableServiceAccountKeyCreation");
    expect(cfg.auditSinks).toBeUndefined();
  });

  test("custom folders and projects merge over the foundation (brownfield: partial trees work)", () => {
    const cfg = landingZoneConfig({
      folders: {
        Workloads: {
          children: { Prod: { projects: [{ name: "checkout" }] } },
        },
      },
    });
    // Same-name key wins over the foundation's Workloads…
    expect(cfg.folders.Workloads.children?.Prod.projects?.[0].name).toBe("checkout");
    // …while the rest of the foundation persists.
    expect(cfg.folders.Security).toEqual(FOUNDATION_FOLDERS.Security);

    const partial = landingZoneConfig({ foundation: false, folders: { Legacy: {} }, rootOrgPolicies: [] });
    expect(Object.keys(partial.folders)).toEqual(["Legacy"]);
    expect(partial.organization.orgPolicies).toBeUndefined();
    expect(partial.orgPolicies).toEqual({});
  });

  test("allowedLocations adds a root resource-location org policy", () => {
    const cfg = landingZoneConfig({ allowedLocations: ["in:eu-locations", "europe-west1"] });
    expect(cfg.organization.orgPolicies).toContain("resource-location-restriction");
    const policy = cfg.orgPolicies["resource-location-restriction"];
    expect(policy.constraint).toBe("gcp.resourceLocations");
    expect(JSON.stringify(policy.rules)).toContain("europe-west1");
  });

  test("auditAllServices declares the audit sink", () => {
    const cfg = landingZoneConfig({ auditAllServices: true });
    expect(cfg.auditSinks?.auditConfig).toEqual({
      service: "allServices",
      logTypes: ["ADMIN_READ", "DATA_READ", "DATA_WRITE"],
    });
  });

  test("only attached org policies are emitted; attaching an undefined policy throws", () => {
    const cfg = landingZoneConfig({
      orgPolicies: { unused: { constraint: "compute.disableSerialPortAccess", rules: [{ enforce: "TRUE" }] } },
    });
    expect(cfg.orgPolicies.unused).toBeUndefined();

    expect(() => landingZoneConfig({ folders: { Security: { orgPolicies: ["nope"] } } })).toThrowError(
      'org policy "nope" is attached but not defined',
    );
  });
});
