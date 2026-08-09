import { describe, expect, test } from "vitest";
import { landingZoneConfig, FOUNDATION_MANAGEMENT_GROUPS } from "./governance";

describe("landingZoneConfig", () => {
  test("the default is the recommended foundation", () => {
    const cfg = landingZoneConfig();
    expect(Object.keys(cfg.managementGroups)).toEqual(["Security", "Infrastructure", "Sandbox", "Workloads"]);
    expect(cfg.tenant.policies).toEqual(["deny-classic-resources", "deny-unmanaged-disks"]);
    expect(cfg.tenant.blockSubscriptionsLeavingTenant).toBe(true);
    expect(Object.keys(cfg.policies).sort()).toEqual(["deny-classic-resources", "deny-unmanaged-disks"]);
    expect(cfg.policies["deny-classic-resources"].policyRule).toMatchObject({ then: { effect: "deny" } });
    expect(cfg.auditSinks).toBeUndefined();
  });

  test("custom groups and subscriptions merge over the foundation (brownfield: partial trees work)", () => {
    const cfg = landingZoneConfig({
      managementGroups: {
        Workloads: {
          children: { Prod: { subscriptions: [{ name: "checkout", subscriptionId: "00000000-0000-0000-0000-000000000001" }] } },
        },
      },
    });
    // Same-name key wins over the foundation's Workloads…
    expect(cfg.managementGroups.Workloads.children?.Prod.subscriptions?.[0].name).toBe("checkout");
    // …while the rest of the foundation persists.
    expect(cfg.managementGroups.Security).toEqual(FOUNDATION_MANAGEMENT_GROUPS.Security);

    const partial = landingZoneConfig({ foundation: false, managementGroups: { Legacy: {} }, rootPolicies: [] });
    expect(Object.keys(partial.managementGroups)).toEqual(["Legacy"]);
    expect(partial.tenant.policies).toBeUndefined();
    expect(partial.tenant.blockSubscriptionsLeavingTenant).toBeUndefined();
    expect(partial.policies).toEqual({});
  });

  test("allowedLocations adds a root location-restriction policy", () => {
    const cfg = landingZoneConfig({ allowedLocations: ["westeurope", "northeurope"] });
    expect(cfg.tenant.policies).toContain("location-restriction");
    const policy = cfg.policies["location-restriction"];
    expect(policy.mode).toBe("Indexed");
    expect(JSON.stringify(policy.policyRule)).toContain("northeurope");
  });

  test("activityLogWorkspaceId declares the audit sink", () => {
    const workspaceId =
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/audit/providers/Microsoft.OperationalInsights/workspaces/org-audit";
    const cfg = landingZoneConfig({ activityLogWorkspaceId: workspaceId });
    expect(cfg.auditSinks?.activityLog).toEqual({ workspaceId });
  });

  test("only assigned policies are emitted; assigning an undefined policy throws", () => {
    const cfg = landingZoneConfig({
      policies: { unused: { policyRule: { if: { field: "type", like: "*" }, then: { effect: "audit" } } } },
    });
    expect(cfg.policies.unused).toBeUndefined();

    expect(() => landingZoneConfig({ managementGroups: { Security: { policies: ["nope"] } } })).toThrowError(
      'policy "nope" is assigned but not defined',
    );
  });
});
