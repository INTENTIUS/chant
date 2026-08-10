import { describe, expect, test } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr030 } from "./azr030";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

// AZR030 reads deployScopes from the generated lexicon (built by `just
// _ensure-gen` before tests run), so these cases exercise the real
// management-group / policy scope metadata (#1545).

describe("AZR030: Resource deployed at an unsupported template scope", () => {
  test("errors when a tenant-only resource sits in a resource-group template", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Management/managementGroups",
          apiVersion: "2023-04-01",
          name: "platform",
          properties: {},
        },
      ],
    });

    const diags = azr030.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR030");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("tenant");
    expect(diags[0].message).toContain("resourceGroup scope");
  });

  test("no diagnostic for a tenant-only resource in a tenant template", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-08-01/tenantDeploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Management/managementGroups",
          apiVersion: "2023-04-01",
          name: "platform",
          properties: {},
        },
      ],
    });

    const diags = azr030.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("errors when a policy definition sits in a resource-group template", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Authorization/policyDefinitions",
          apiVersion: "2026-06-01",
          name: "deny-public-ip",
          properties: { policyRule: {} },
        },
      ],
    });

    const diags = azr030.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("subscription/managementGroup");
  });

  test("no diagnostic for a policy definition in a subscription template", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Authorization/policyDefinitions",
          apiVersion: "2026-06-01",
          name: "deny-public-ip",
          properties: { policyRule: {} },
        },
      ],
    });

    const diags = azr030.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("policy assignments deploy at any scope, including resource group", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Authorization/policyAssignments",
          apiVersion: "2026-06-01",
          name: "enforce-tags",
          properties: {},
        },
      ],
    });

    const diags = azr030.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("plain resources stay silent in resource-group templates", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr030.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
