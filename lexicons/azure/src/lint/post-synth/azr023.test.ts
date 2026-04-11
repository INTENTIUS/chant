import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr023 } from "./azr023";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR023: VM Missing Managed Disk", () => {
  test("check metadata", () => {
    expect(azr023.id).toBe("AZR023");
    expect(azr023.description).toBeTruthy();
  });

  test("warns when OS disk has no managedDisk", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/virtualMachines",
          apiVersion: "2023-07-01",
          name: "myVm",
          location: "[resourceGroup().location]",
          properties: {
            storageProfile: {
              osDisk: { createOption: "FromImage" },
            },
          },
        },
      ],
    });

    const diags = azr023.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR023");
    expect(diags[0].message).toContain("managed disks");
  });

  test("no diagnostic when managedDisk is configured", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/virtualMachines",
          apiVersion: "2023-07-01",
          name: "myVm",
          location: "[resourceGroup().location]",
          properties: {
            storageProfile: {
              osDisk: {
                createOption: "FromImage",
                managedDisk: { storageAccountType: "Premium_LRS" },
              },
            },
          },
        },
      ],
    });

    const diags = azr023.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
