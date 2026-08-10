import { describe, expect, test } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr031 } from "./azr031";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

const SCHEMA = "https://schema.management.azure.com/schemas/2019-08-01/managementGroupDeploymentTemplate.json#";

describe("AZR031: policy assignment not enforced", () => {
  test("flags enforcementMode DoNotEnforce", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2023-04-01",
          name: "deny-classic",
          properties: {
            policyDefinitionId: "[managementGroupResourceId('Microsoft.Authorization/policyDefinitions', 'deny-classic-resources')]",
            enforcementMode: "DoNotEnforce",
          },
        },
      ],
    });

    const diags = azr031.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR031");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("deny-classic");
  });

  test("no diagnostic for Default enforcement or an unset mode", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2023-04-01",
          name: "explicit-default",
          properties: { policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/abc", enforcementMode: "Default" },
        },
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2023-04-01",
          name: "unset",
          properties: { policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/abc" },
        },
      ],
    });

    expect(azr031.check(ctx)).toHaveLength(0);
  });
});
