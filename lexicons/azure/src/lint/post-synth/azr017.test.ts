import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr017 } from "./azr017";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR017: Key Vault Purge Protection", () => {
  test("check metadata", () => {
    expect(azr017.id).toBe("AZR017");
    expect(azr017.description).toBeTruthy();
  });

  test("warns when purge protection is not enabled", () => {
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

    const diags = azr017.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR017");
    expect(diags[0].message).toContain("purge protection");
  });

  test("no diagnostic when purge protection is enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: { enableSoftDelete: true, enablePurgeProtection: true },
        },
      ],
    });

    const diags = azr017.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
