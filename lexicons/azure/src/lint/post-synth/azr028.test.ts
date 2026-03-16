import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr028 } from "./azr028";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR028: Network Interface Missing NSG", () => {
  test("check metadata", () => {
    expect(azr028.id).toBe("AZR028");
    expect(azr028.description).toBeTruthy();
  });

  test("warns when NIC has no NSG", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Network/networkInterfaces",
          apiVersion: "2023-05-01",
          name: "myNic",
          location: "[resourceGroup().location]",
          properties: {
            ipConfigurations: [{ name: "ipconfig1", properties: {} }],
          },
        },
      ],
    });

    const diags = azr028.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR028");
    expect(diags[0].message).toContain("NSG");
  });

  test("no diagnostic when NSG is associated", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Network/networkInterfaces",
          apiVersion: "2023-05-01",
          name: "myNic",
          location: "[resourceGroup().location]",
          properties: {
            ipConfigurations: [{ name: "ipconfig1", properties: {} }],
            networkSecurityGroup: { id: "[resourceId('Microsoft.Network/networkSecurityGroups', 'myNsg')]" },
          },
        },
      ],
    });

    const diags = azr028.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
