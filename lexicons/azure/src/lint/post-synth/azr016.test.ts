import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr016 } from "./azr016";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR016: Key Vault Soft Delete", () => {
  test("check metadata", () => {
    expect(azr016.id).toBe("AZR016");
    expect(azr016.description).toBeTruthy();
  });

  test("warns when soft delete is not enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr016.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR016");
    expect(diags[0].message).toContain("soft-delete");
  });

  test("no diagnostic when soft delete is enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: { enableSoftDelete: true },
        },
      ],
    });

    const diags = azr016.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
