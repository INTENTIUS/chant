import { describe, expect, test } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr032 } from "./azr032";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

const SCHEMA = "https://schema.management.azure.com/schemas/2019-08-01/managementGroupDeploymentTemplate.json#";

function definition(name: string) {
  return {
    type: "Microsoft.Authorization/policyDefinitions",
    apiVersion: "2023-04-01",
    name,
    properties: { policyType: "Custom", mode: "All", policyRule: { if: { field: "type", like: "Microsoft.Classic*" }, then: { effect: "deny" } } },
  };
}

describe("AZR032: policy definition assigned nowhere", () => {
  test("flags a definition with no assignment", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [definition("deny-classic-resources")],
    });

    const diags = azr032.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR032");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("deny-classic-resources");
  });

  test("no diagnostic when the GovernanceBaseline pairing references it", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [
        definition("deny-classic-resources"),
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2023-04-01",
          name: "deny-classic",
          dependsOn: ["deny-classic-resources"],
          properties: {
            policyDefinitionId: "[managementGroupResourceId('Microsoft.Authorization/policyDefinitions', 'deny-classic-resources')]",
          },
        },
      ],
    });

    expect(azr032.check(ctx)).toHaveLength(0);
  });

  test("a literal resource-id reference also counts", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [
        definition("allowed-locations"),
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2023-04-01",
          name: "locations",
          properties: {
            policyDefinitionId: "/providers/Microsoft.Management/managementGroups/root/providers/Microsoft.Authorization/policyDefinitions/allowed-locations",
          },
        },
      ],
    });

    expect(azr032.check(ctx)).toHaveLength(0);
  });

  test("a built-in assignment does not cover an unrelated definition", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [
        definition("deny-unmanaged-disks"),
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2023-04-01",
          name: "activity-log-sink",
          properties: {
            policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/2465583e-4e78-4c15-b6be-a36cbc7c8b0f",
          },
        },
      ],
    });

    expect(azr032.check(ctx)).toHaveLength(1);
  });
});
