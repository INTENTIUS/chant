import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr026 } from "./azr026";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR026: AKS Missing Network Policy", () => {
  test("check metadata", () => {
    expect(azr026.id).toBe("AZR026");
    expect(azr026.description).toBeTruthy();
  });

  test("warns when no network policy configured", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: {
            networkProfile: { networkPlugin: "azure" },
          },
        },
      ],
    });

    const diags = azr026.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR026");
    expect(diags[0].message).toContain("network policy");
  });

  test("no diagnostic when network policy set", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: {
            networkProfile: { networkPlugin: "azure", networkPolicy: "azure" },
          },
        },
      ],
    });

    const diags = azr026.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
