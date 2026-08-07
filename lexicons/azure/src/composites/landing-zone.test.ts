import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant";
import { ActivityLogSink, GovernanceBaseline, GovernanceFoundation, LocationRestriction } from "./landing-zone";
import { ACTIVITY_LOG_TO_LOG_ANALYTICS_DEFINITION_ID } from "../governance";

/** Helper to extract props from a Declarable member. */
function p(member: unknown): Record<string, any> {
  return (member as any).props;
}

describe("GovernanceFoundation (#791)", () => {
  test("declares the foundation management groups and the subscription tenant policy", () => {
    const lz = GovernanceFoundation({});
    expect(Object.keys(lz.members)).toEqual([
      "mgSecurity",
      "mgInfrastructure",
      "mgSandbox",
      "mgWorkloads",
      "subscriptionTenantPolicy",
    ]);
    expect(p(lz.mgSecurity).name).toBe("Security");
    expect(p(lz.mgSecurity).displayName).toBe("Security");
    expect(p(lz.mgSecurity).details).toBeUndefined();
    expect(p(lz.subscriptionTenantPolicy)).toMatchObject({
      name: "default",
      blockSubscriptionsLeavingTenant: true,
    });
  });

  test("parentId hangs the groups under an existing management group", () => {
    const lz = GovernanceFoundation({ parentId: "acme-root" });
    expect(p(lz.mgWorkloads).details).toEqual({
      parent: { id: "/providers/Microsoft.Management/managementGroups/acme-root" },
    });
  });

  test("blockSubscriptionsLeavingTenant can be relaxed", () => {
    const lz = GovernanceFoundation({ blockSubscriptionsLeavingTenant: false });
    expect(p(lz.subscriptionTenantPolicy).blockSubscriptionsLeavingTenant).toBe(false);
  });

  test("expandComposite produces prefixed logical names", () => {
    const expanded = expandComposite("lz", GovernanceFoundation({}));
    expect([...expanded.keys()]).toContain("lzMgSecurity");
    expect([...expanded.keys()]).toContain("lzSubscriptionTenantPolicy");
    expect(expanded.size).toBe(5);
  });
});

describe("GovernanceBaseline (#791)", () => {
  test("defines and assigns the two baseline policies", () => {
    const gb = GovernanceBaseline({});
    expect(Object.keys(gb.members)).toEqual([
      "definitionDenyClassicResources",
      "definitionDenyUnmanagedDisks",
      "assignmentDenyClassicResources",
      "assignmentDenyUnmanagedDisks",
    ]);
    const def = p(gb.definitionDenyClassicResources);
    expect(def.name).toBe("deny-classic-resources");
    expect(def.policyType).toBe("Custom");
    expect(def.mode).toBe("All");
    expect(def.policyRule).toMatchObject({ then: { effect: "deny" } });
  });

  test("assignments reference their definitions by managementGroupResourceId, under a distinct name", () => {
    const gb = GovernanceBaseline({});
    const assignment = p(gb.assignmentDenyClassicResources);
    expect(assignment.name).toBe("deny-classic");
    expect(assignment.policyDefinitionId).toBe(
      "[managementGroupResourceId('Microsoft.Authorization/policyDefinitions', 'deny-classic-resources')]",
    );
    // Ordered after the definition — the serializer's dependsOn inference
    // does not read managementGroupResourceId() expressions
    expect((gb.assignmentDenyClassicResources as any).attributes).toEqual({ DependsOn: "deny-classic-resources" });
  });
});

describe("LocationRestriction and ActivityLogSink (#791)", () => {
  test("LocationRestriction defines and assigns the allowed-locations policy", () => {
    const lr = LocationRestriction({ locations: ["westeurope"] });
    const def = p(lr.definitionLocationRestriction);
    expect(def.name).toBe("location-restriction");
    expect(def.mode).toBe("Indexed");
    expect(JSON.stringify(def.policyRule)).toContain("westeurope");
    expect(p(lr.assignmentLocationRestriction).policyDefinitionId).toBe(
      "[managementGroupResourceId('Microsoft.Authorization/policyDefinitions', 'location-restriction')]",
    );
  });

  test("ActivityLogSink assigns the built-in DeployIfNotExists policy with a managed identity", () => {
    const workspaceId =
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/audit/providers/Microsoft.OperationalInsights/workspaces/org-audit";
    const al = ActivityLogSink({ workspaceId, location: "westeurope" });
    expect(p(al.assignmentActivityLogSink)).toMatchObject({
      name: "activity-log-sink",
      location: "westeurope",
      identity: { type: "SystemAssigned" },
      policyDefinitionId: ACTIVITY_LOG_TO_LOG_ANALYTICS_DEFINITION_ID,
      parameters: { logAnalytics: { value: workspaceId } },
    });
  });
});
