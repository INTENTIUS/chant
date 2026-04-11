import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr025 } from "./azr025";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR025: AKS Missing RBAC", () => {
  test("check metadata", () => {
    expect(azr025.id).toBe("AZR025");
    expect(azr025.description).toBeTruthy();
  });

  test("warns when RBAC not enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr025.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR025");
    expect(diags[0].message).toContain("RBAC");
  });

  test("no diagnostic when RBAC enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: { enableRBAC: true },
        },
      ],
    });

    const diags = azr025.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
